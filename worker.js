// OPEN FRAGILITY CHECK (Cloudflare Worker, no dependencies)
// Version 0.3.0 - Hardened caching, upstream limits, validation and error handling

const VERSION = "0.3.0";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CACHE_SECONDS = 300;
const NEGATIVE_CACHE_SECONDS = 300;
const YAHOO_TIMEOUT_MS = 8000;
const STOOQ_TIMEOUT_MS = 5000;
const MAX_YAHOO_BYTES = 2_000_000;
const MAX_STOOQ_BYTES = 2_000_000;
const ALLOWED_QUERY_PARAMS = new Set(["symbol", "offer"]);
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;

const DISCLAIMER =
  "Measures the structural market state of a stock using price and volume data. " +
  "No direction, no trading signal, no investment advice, and no statement on company fundamentals. " +
  "Scales and weights are uncalibrated estimates.";

const WEIGHTS = {
  volatility: 0.25, extension: 0.15, drawdown: 0.15, gaps: 0.10,
  volume: 0.10, liquidity: 0.10, depth: 0.15, offer: 0.15,
};

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const num = (x) => typeof x === "number" && Number.isFinite(x);

function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

const fmt = (x, d = 1) => x.toFixed(d);
class UpstreamError extends Error {}

function isValidCandle(row) {
  return (
    num(row.t) && row.t > 0 &&
    num(row.o) && row.o > 0 &&
    num(row.h) && row.h > 0 &&
    num(row.l) && row.l > 0 &&
    num(row.c) && row.c > 0 &&
    (row.v === null || (num(row.v) && row.v >= 0)) &&
    row.h >= Math.max(row.o, row.c, row.l) &&
    row.l <= Math.min(row.o, row.c, row.h)
  );
}

function normalizeRows(rows, limit = 260) {
  const byTimestamp = new Map();
  for (const row of rows) {
    if (isValidCandle(row)) byTimestamp.set(row.t, row);
  }
  return Array.from(byTimestamp.values())
    .sort((a, b) => a.t - b.t)
    .slice(-limit);
}

async function readLimitedText(response, maxBytes, errorPrefix) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new UpstreamError(`${errorPrefix}_response_too_large`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new UpstreamError(`${errorPrefix}_response_too_large`);
    }
    return text;
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore cancellation errors */ }
      throw new UpstreamError(`${errorPrefix}_response_too_large`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

// ------------------------------------------------------------------ data sources
async function fromYahoo(symbol, interval = "1d", range = "1y") {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
    });
  } catch (e) {
    throw new UpstreamError(e?.name === "TimeoutError" ? "yahoo_timeout" : "yahoo_network_error");
  }
  if (!res.ok) throw new UpstreamError(`yahoo_http_${res.status}`);
  let json;
  try {
    const text = await readLimitedText(res, MAX_YAHOO_BYTES, "yahoo");
    json = JSON.parse(text);
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError("yahoo_invalid_json");
  }
  const r = json?.chart?.result?.[0];
  if (!r) throw new UpstreamError("yahoo_no_result");
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    const row = { t: ts[i] * 1000, o, h, l, c, v: num(v) && v >= 0 ? v : null };
    if (isValidCandle(row)) rows.push(row);
  }
  const m = r.meta || {};
  return {
    rows: normalizeRows(rows), interval, source: interval === "1h" ? "yahoo (1h intraday)" : "yahoo",
    meta: { name: m.longName || m.shortName || symbol, exchange: m.fullExchangeName || m.exchangeName || "", currency: m.currency || "USD" },
  };
}

async function fromStooq(symbol) {
  const stooqSym = symbol.includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/csv,text/plain;q=0.9" },
      signal: AbortSignal.timeout(STOOQ_TIMEOUT_MS),
    });
  } catch (e) {
    throw new UpstreamError(e?.name === "TimeoutError" ? "stooq_timeout" : "stooq_network_error");
  }
  if (!res.ok) throw new UpstreamError(`stooq_http_${res.status}`);
  const text = await readLimitedText(res, MAX_STOOQ_BYTES, "stooq");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date,open/i.test(lines[0])) throw new UpstreamError("stooq_no_data");
  const rows = [];
  for (const line of lines.slice(1)) {
    const [d, o, h, l, c, v] = line.split(",");
    const t = Date.parse(d + "T00:00:00Z");
    const O = parseFloat(o), H = parseFloat(h), L = parseFloat(l), C = parseFloat(c), V = parseFloat(v);
    const row = { t, o: O, h: H, l: L, c: C, v: Number.isFinite(V) && V >= 0 ? V : null };
    if (isValidCandle(row)) rows.push(row);
  }
  return { rows: normalizeRows(rows), interval: "1d", source: "stooq", meta: { name: symbol, exchange: "", currency: "USD" } };
}

async function loadCandles(symbol) {
  const errors = [];
  let dailyData = null;
  try {
    dailyData = await fromYahoo(symbol, "1d", "1y");
    if (dailyData.rows.length >= 5) return dailyData;
  } catch (e) {
    errors.push(e instanceof UpstreamError ? e.message : "yahoo_error");
  }

  // Young IPOs (Day 1 to 4): fall back to 1h intraday candles
  if (dailyData && dailyData.rows.length > 0 && dailyData.rows.length < 5) {
    try {
      const intra = await fromYahoo(symbol, "1h", "5d");
      if (intra.rows.length >= 3) return intra;
    } catch { /* fall through to dailyData */ }
    return dailyData;
  }

  try {
    const stooq = await fromStooq(symbol);
    if (stooq.rows.length >= 1) return stooq;
    errors.push("stooq_too_few_rows");
  } catch (e) {
    errors.push(e instanceof UpstreamError ? e.message : "stooq_error");
  }
  throw new UpstreamError(errors.join(", "));
}

// ------------------------------------------------------------------ the index
function computeFragility(rows, meta, opts = {}, interval = "1d") {
  const n = rows.length;
  const c = rows.map((r) => r.c);
  const last = c[n - 1];
  const uniqueDays = new Set(rows.map((r) => new Date(r.t).toISOString().slice(0, 10))).size;
  const isIntra = interval === "1h";
  const ccy = meta.currency || "USD";
  const factors = [];
  const add = (key, label, score, valueText, explain) =>
    factors.push({ key, label, weight: WEIGHTS[key], score: score === null ? null : Math.round(score), valueText, explain });

  // 1. volatility (annualized: 252 days or 252 * 6.5 hours)
  const annFactor = isIntra ? Math.sqrt(252 * 6.5) : Math.sqrt(252);
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(Math.log(c[i] / c[i - 1]));
  if (rets.length >= 4) {
    const win = isIntra ? 20 : 10;
    const volNow = stdev(rets.slice(-win)) * annFactor * 100;
    const parts = [clamp(volNow - 20)];
    let txt = `${isIntra ? "Intraday" : "10-day"} realized vol ${fmt(volNow, 0)}% p.a.`;
    const baseRets = !isIntra ? rets.slice(Math.max(0, rets.length - 70), rets.length - 10) : [];
    if (baseRets.length >= 30) {
      const baseVol = stdev(baseRets) * Math.sqrt(252) * 100;
      if (baseVol > 0) {
        const ratio = volNow / baseVol;
        parts.push(clamp(ratio <= 1 ? 20 * ratio : 20 + ((ratio - 1) / 2) * 80));
        txt += ` (${fmt(ratio, 1)}x vs prior 60d)`;
      }
    }
    add("volatility", "Volatility", mean(parts), txt, "Realized price volatility, absolute and relative to prior baseline.");
  } else add("volatility", "Volatility", null, "insufficient data points", "Requires at least 5 candles.");

  // 2. extension
  let extPct = null;
  if (!isIntra && n >= 20) {
    const m = Math.min(n, 50);
    const sma = mean(c.slice(-m));
    extPct = (last / sma - 1) * 100;
    const run = n > 20 ? (last / c[n - 21] - 1) * 100 : null;
    const parts = [clamp((Math.max(extPct, 0) / 40) * 100)];
    if (run !== null) parts.push(clamp((Math.max(run, 0) / 60) * 100));
    add("extension", "Upside Extension", Math.max(...parts),
      `${fmt(Math.abs(extPct))}% ${extPct >= 0 ? "above" : "below"} ${m}d SMA` + (run !== null ? ` (20d: ${run >= 0 ? "+" : ""}${fmt(run, 0)}%)` : ""),
      "Distance above the moving average and 20-day run-up. Upside stretches only.");
  } else add("extension", "Upside Extension", null, "fewer than 20 trading days", "Requires at least 20 trading days.");

  // 3. drawdown
  let ddPct = 0;
  if (n >= 2) {
    const peak = Math.max(...rows.map((r) => r.h));
    ddPct = ((peak - last) / peak) * 100;
    add("drawdown", "Peak Drawdown", clamp((ddPct / 40) * 100),
      `${fmt(ddPct)}% below window high (${uniqueDays} ${uniqueDays === 1 ? "day" : "days"})`,
      "Distance from the highest price in the observed window. 40%+ maxes out at 100.");
  } else add("drawdown", "Peak Drawdown", null, "insufficient data", "Requires at least 2 candles.");

  // 4. overnight gaps
  if (!isIntra && n >= 4) {
    const k = Math.min(20, n - 1);
    const gaps = [];
    for (let i = n - k; i < n; i++) gaps.push(Math.abs(rows[i].o / rows[i - 1].c - 1) * 100);
    const avg = mean(gaps);
    add("gaps", "Overnight Gaps", clamp((avg / 4) * 100), `Avg ${fmt(avg, 2)}% open-to-prev-close gap (${k}d)`, "Average overnight gap risk.");
  } else add("gaps", "Overnight Gaps", null, "requires 4+ trading days", "Requires at least 4 daily closes.");

  // 5. volume
  const vols = rows.map((r) => r.v).filter((v) => v !== null);
  if (!isIntra && n >= 7 && vols.slice(-2).every((v) => v > 0)) {
    const prev = vols.slice(Math.max(0, n - 22), n - 2).filter((v) => v > 0);
    if (prev.length >= 5) {
      const rvol = mean(vols.slice(-2)) / mean(prev);
      const s = rvol >= 1 ? 20 + ((rvol - 1) / 4) * 80 : 20 + (1 - rvol) * 40;
      add("volume", "Volume Spike", clamp(s), `${fmt(rvol, 1)}x volume (last 2d vs prior 20d)`, "Unusual volume spikes or liquidity dry-ups.");
    } else add("volume", "Volume Spike", null, "insufficient volume history", "Requires volume on at least 5 prior days.");
  } else add("volume", "Volume Spike", null, "history too short", "Requires at least 7 trading days.");

  // 6. liquidity (dollar/currency turnover grouped by calendar day)
  const dayTurnover = new Map();
  for (const r of rows) {
    if (r.v > 0) {
      const day = new Date(r.t).toISOString().slice(0, 10);
      dayTurnover.set(day, (dayTurnover.get(day) || 0) + r.c * r.v);
    }
  }
  const dv = Array.from(dayTurnover.values()).slice(-20);
  if (dv.length >= 1) {
    const avg = mean(dv);
    const s = ((Math.log10(50e6) - Math.log10(Math.max(avg, 1))) / (Math.log10(50e6) - Math.log10(1e6))) * 100;
    add("liquidity", "Liquidity", clamp(s), `Avg daily turnover ${fmt(avg / 1e6, 1)}M ${ccy}`, "50M+/day is treated as low liquidity friction.");
  } else add("liquidity", "Liquidity", null, "no turnover data", "Requires price and volume.");

  // 7. depth
  add("depth", "History Depth", clamp(((120 - uniqueDays) / 120) * 100), `${uniqueDays} trading days available`, "Less history means higher uncertainty. 0 penalty at 120+ days.");

  // 8. offer premium
  let premPct = null;
  if (num(opts.offer) && opts.offer > 0) {
    premPct = (last / opts.offer - 1) * 100;
    add("offer", "Offer Price Distance", clamp((Math.abs(premPct) / 60) * 100),
      `${premPct >= 0 ? "+" : "-"}${fmt(Math.abs(premPct), 0)}% vs reference price ${fmt(opts.offer, 2)}`,
      "Distance from the IPO offer or reference price. 60%+ maxes out at 100.");
  }

  const avail = factors.filter((f) => f.score !== null);
  const wsum = avail.reduce((s, f) => s + f.weight, 0);
  const score = Math.round(avail.reduce((s, f) => s + f.weight * f.score, 0) / wsum);
  const label = score < 30 ? "stable" : score < 55 ? "elevated" : "fragile";
  const labelClass = label;
  const quality = uniqueDays < 20 ? "low" : uniqueDays < 60 ? "medium" : "high";

  // Descriptive regime state (context without directional recommendation)
  const stretchedUp = (extPct !== null && extPct > 15) || (premPct !== null && premPct > 30);
  let regime = "Balanced / neutral";
  if (stretchedUp && ddPct < 10) regime = "Overextended to the upside (near peak)";
  else if (stretchedUp && ddPct >= 10 && ddPct < 25) regime = "Pullback after overextension (off the peak)";
  else if (ddPct >= 25) regime = `Significant drawdown from peak (-${fmt(ddPct, 0)}%)`;

  const notes = [];
  if (isIntra) notes.push("Recent listing: calculated using 1h intraday candles.");
  if (uniqueDays < 20 && !(num(opts.offer) && opts.offer > 0)) {
    notes.push("Tip for recent IPOs: enter the IPO offer price (e.g. 74 for ANT) to factor in the listing premium.");
  }
  const ageDays = (Date.now() - rows[n - 1].t) / 86400000;
  if (ageDays > 5) notes.push(`Last quote is ${Math.floor(ageDays)} days old; data may be stale.`);
  notes.push("This index measures structural tension and volatility only, not future price direction.");

  return {
    score, label, labelClass, regime, quality, tradingDays: uniqueDays,
    price: Math.round(last * 100) / 100,
    asOf: new Date(rows[n - 1].t).toISOString().slice(0, 10), factors, notes,
  };
}

// ------------------------------------------------------------------ HTTP handling
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...extra },
  });
}

async function handleApi(request, ctx) {
  const url = new URL(request.url);

  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMS.has(key)) {
      return json({ error: "unsupported_parameter", message: `Unsupported query parameter: ${key}` }, 400, {
        "cache-control": "no-store",
      });
    }
  }

  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    return json({ error: "invalid_symbol", message: "Invalid ticker symbol (letters, numbers, dot, hyphen; max 15 chars)." }, 400, {
      "cache-control": "no-store",
    });
  }

  let offer = null;
  const offerRaw = (url.searchParams.get("offer") || "").trim().replace(",", ".");
  if (offerRaw) {
    offer = Number(offerRaw);
    if (!Number.isFinite(offer) || offer <= 0 || offer > 1e6) {
      return json({ error: "invalid_offer", message: "Invalid offer/reference price." }, 400, {
        "cache-control": "no-store",
      });
    }
  }

  const canonical = new URL("/api/fragility", url.origin);
  canonical.searchParams.set("symbol", symbol);
  if (offer !== null) canonical.searchParams.set("offer", String(offer));

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(canonical.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let data;
  try {
    data = await loadCandles(symbol);
  } catch (e) {
    const requestId = crypto.randomUUID();
    console.error("fragility_upstream_error", { requestId, symbol, error: e instanceof Error ? e.message : String(e) });
    const response = json({
      error: "no_data",
      message: `No price data found for ${symbol}. For non-US exchanges, add the suffix (e.g. RHM.DE for XETRA, VOD.L for London). Pre-IPO tickers like ANT have no market data until listing.`,
      requestId,
    }, 502, { "cache-control": `public, max-age=${NEGATIVE_CACHE_SECONDS}` });
    if (cache && ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  }

  data.rows = normalizeRows(data.rows);
  if (data.rows.length === 0) {
    return json({ error: "no_valid_data", message: "The upstream returned no valid market candles." }, 502, {
      "cache-control": `public, max-age=${NEGATIVE_CACHE_SECONDS}`,
    });
  }

  const result = computeFragility(data.rows, data.meta, { offer }, data.interval);
  const body = {
    version: VERSION, symbol, name: data.meta.name, exchange: data.meta.exchange, currency: data.meta.currency,
    source: data.source, generatedAt: new Date().toISOString(), ...result, disclaimer: DISCLAIMER,
  };
  const response = json(body, 200, { "cache-control": `public, max-age=${CACHE_SECONDS}` });
  if (cache && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
    if (url.pathname === "/api/fragility") return handleApi(request, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
