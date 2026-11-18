// OPEN FRAGILITY CHECK (Cloudflare Worker, no dependencies)
// Version 0.3.2 - Hardened caching, validation, partial-candle handling and Stooq limit detection

const VERSION = "0.3.2";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CACHE_SECONDS = 300;
const NEGATIVE_CACHE_SECONDS = 60;
const YAHOO_TIMEOUT_MS = 8000;
const STOOQ_TIMEOUT_MS = 6000;
const MAX_YAHOO_BYTES = 2_000_000;
const MAX_STOOQ_BYTES = 3_000_000;
const MEM_MAX_ENTRIES = 200;
const OFFER_RE = /^\d+(?:\.\d+)?$/;
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

// Rough conversion rates used only on the logarithmic liquidity scale
const USD_PER_UNIT = {
  USD: 1, EUR: 1.08, GBP: 1.27, GBp: 0.0127, GBX: 0.0127, CHF: 1.12, JPY: 0.0066,
  CAD: 0.73, AUD: 0.65, NZD: 0.60, HKD: 0.128, CNY: 0.14, SGD: 0.74, KRW: 0.00073,
  INR: 0.012, TWD: 0.031, SEK: 0.095, NOK: 0.092, DKK: 0.145, PLN: 0.25, BRL: 0.18, MXN: 0.05,
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

class UpstreamError extends Error {
  constructor(message, kind = "error") {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
  }
}

const asUpstream = (e, fallback) => (e instanceof UpstreamError ? e : new UpstreamError(fallback));
const httpKind = (status) => (status === 404 ? "notfound" : status === 429 ? "limited" : "error");

function isValidCandle(row) {
  if (!(row && num(row.t) && row.t > 0 &&
    num(row.o) && row.o > 0 && num(row.h) && row.h > 0 &&
    num(row.l) && row.l > 0 && num(row.c) && row.c > 0 &&
    (row.v === null || (num(row.v) && row.v >= 0)))) {
    return false;
  }
  // Allow minor IEEE-754 float32 rounding drift (common in Yahoo Finance chart JSON)
  const eps = row.h * 1e-6;
  return row.h >= row.l - eps &&
    row.h + eps >= Math.max(row.o, row.c) &&
    row.l - eps <= Math.min(row.o, row.c);
}

function normalizeRows(rows, limit = 260) {
  const byTimestamp = new Map();
  for (const row of rows) if (isValidCandle(row)) byTimestamp.set(row.t, row);
  return Array.from(byTimestamp.values()).sort((a, b) => a.t - b.t).slice(-limit);
}

async function readLimitedText(response, maxBytes, prefix) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new UpstreamError(`${prefix}_response_too_large`);
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new UpstreamError(`${prefix}_response_too_large`);
    return text;
  }
  const decoder = new TextDecoder();
  let received = 0, text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new UpstreamError(`${prefix}_response_too_large`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// ------------------------------------------------------------------ data sources
async function httpGet(url, headers, timeoutMs) {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new UpstreamError(e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "network_error");
  }
}

async function fromYahoo(symbol, interval = "1d", range = "1y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
  const res = await httpGet(url, { "User-Agent": UA, Accept: "application/json" }, YAHOO_TIMEOUT_MS);
  if (!res.ok) throw new UpstreamError(`yahoo_http_${res.status}`, httpKind(res.status));
  let json;
  try { json = JSON.parse(await readLimitedText(res, MAX_YAHOO_BYTES, "yahoo")); }
  catch (e) { if (e instanceof UpstreamError) throw e; throw new UpstreamError("yahoo_invalid_json"); }
  const r = json?.chart?.result?.[0];
  if (!r) throw new UpstreamError("yahoo_no_result", "notfound");
  const ts = Array.isArray(r.timestamp) ? r.timestamp : [];
  const q = r.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const v = q.volume?.[i];
    const row = { t: ts[i] * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: num(v) && v >= 0 ? v : null };
    if (isValidCandle(row)) rows.push(row);
  }
  const normalized = normalizeRows(rows);
  if (!normalized.length) throw new UpstreamError("yahoo_no_valid_rows", "notfound");
  const m = r.meta || {};
  const reg = m.currentTradingPeriod?.regular;
  const nowSec = Date.now() / 1000;
  const partialLast = interval === "1d" && normalized.length > 0 && reg &&
    num(reg.start) && num(reg.end) && nowSec >= reg.start && nowSec < reg.end;
  return {
    rows: normalized, interval, source: interval === "1h" ? "yahoo (1h intraday)" : "yahoo",
    meta: { name: m.longName || m.shortName || symbol, exchange: m.fullExchangeName || m.exchangeName || "", currency: m.currency || "", partialLast: Boolean(partialLast) },
  };
}

async function fromStooq(symbol) {
  const stooqSym = symbol.includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
  const res = await httpGet(url, { "User-Agent": UA, Accept: "text/csv,text/plain;q=0.9" }, STOOQ_TIMEOUT_MS);
  if (!res.ok) throw new UpstreamError(`stooq_http_${res.status}`, httpKind(res.status));
  const text = await readLimitedText(res, MAX_STOOQ_BYTES, "stooq");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0 || !/^date,open/i.test(lines[0])) {
    // Stooq often reports daily quota exhaustion with HTTP 200 and a plain-text notice
    if (/limit|exceeded/i.test(lines[0] || "")) {
      throw new UpstreamError("stooq_rate_limited", "limited");
    }
    throw new UpstreamError("stooq_no_data", "notfound");
  }
  if (lines.length < 2) throw new UpstreamError("stooq_no_data", "notfound");
  const rows = [];
  for (const line of lines.slice(1)) {
    const [d, o, h, l, c, v] = line.split(",");
    const V = Number.parseFloat(v);
    const row = { t: Date.parse(`${d}T00:00:00Z`), o: Number.parseFloat(o), h: Number.parseFloat(h), l: Number.parseFloat(l), c: Number.parseFloat(c), v: Number.isFinite(V) && V >= 0 ? V : null };
    if (isValidCandle(row)) rows.push(row);
  }
  const normalized = normalizeRows(rows);
  if (!normalized.length) throw new UpstreamError("stooq_no_valid_rows", "notfound");
  return { rows: normalized, interval: "1d", source: "stooq", meta: { name: symbol, exchange: "", currency: symbol.includes(".") ? "" : "USD", partialLast: false } };
}

async function loadCandles(symbol) {
  const errors = [];
  let dailyData = null;
  try {
    dailyData = await fromYahoo(symbol, "1d", "1y");
    if (dailyData.rows.length >= 5) return dailyData;
  } catch (e) { errors.push(asUpstream(e, "yahoo_error")); }
  if (dailyData && dailyData.rows.length > 0 && dailyData.rows.length < 5) {
    try {
      const intra = await fromYahoo(symbol, "1h", "5d");
      if (intra.rows.length >= 3) return intra;
    } catch (e) { errors.push(asUpstream(e, "yahoo_intraday_error")); }
    return dailyData;
  }
  try {
    const stooq = await fromStooq(symbol);
    if (stooq.rows.length >= 1) return stooq;
    errors.push(new UpstreamError("stooq_too_few_rows", "notfound"));
  } catch (e) { errors.push(asUpstream(e, "stooq_error")); }
  const kind = errors.every((e) => e.kind === "notfound") ? "notfound" : errors.some((e) => e.kind === "limited") ? "limited" : "error";
  throw new UpstreamError(errors.map((e) => e.message).join(", ") || "no_upstream_data", kind);
}

// ------------------------------------------------------------------ the index
function computeFragility(rows, meta, opts = {}, interval = "1d") {
  // Upstream loaders already return validated, sorted, deduplicated rows
  if (!Array.isArray(rows) || !rows.length) throw new UpstreamError("no_valid_candles");
  const n = rows.length;
  const c = rows.map((r) => r.c);
  const last = c[n - 1];
  const uniqueDays = new Set(rows.map((r) => new Date(r.t).toISOString().slice(0, 10))).size;
  const isIntra = interval === "1h";
  const ccy = meta.currency || "";
  const usdRate = USD_PER_UNIT[ccy];
  // Exclude an in-progress daily candle from volume/liquidity only if prior candles remain
  const excludedPartial = Boolean(meta.partialLast && rows.length > 1);
  const vrows = excludedPartial ? rows.slice(0, -1) : rows;
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

  // 5. volume (complete daily candles only)
  const vols = vrows.map((r) => r.v);
  const nv = vrows.length;
  if (!isIntra && nv >= 7 && vols.slice(-2).length === 2 && vols.slice(-2).every((v) => num(v) && v > 0)) {
    const prev = vols.slice(Math.max(0, nv - 22), nv - 2).filter((v) => num(v) && v > 0);
    if (prev.length >= 5) {
      const rvol = mean(vols.slice(-2)) / mean(prev);
      const score = rvol >= 1 ? 20 + ((rvol - 1) / 4) * 80 : 20 + (1 - rvol) * 40;
      add("volume", "Volume Spike", clamp(score), `${fmt(rvol, 1)}x volume (last 2d vs prior 20d)`, "Unusual volume spikes or liquidity dry-ups.");
    } else add("volume", "Volume Spike", null, "insufficient volume history", "Requires volume on at least 5 prior days.");
  } else add("volume", "Volume Spike", null, "history too short or volume unavailable", "Requires at least 7 completed trading days with valid volume data.");

  // 6. liquidity (completed candles, turnover converted to USD)
  const dayTurnover = new Map();
  for (const r of vrows) {
    if (num(r.v) && r.v > 0) {
      const day = new Date(r.t).toISOString().slice(0, 10);
      dayTurnover.set(day, (dayTurnover.get(day) || 0) + r.c * r.v);
    }
  }
  const dv = Array.from(dayTurnover.values()).slice(-20);
  if (dv.length >= 1 && usdRate) {
    const avg = mean(dv);
    const usd = avg * usdRate;
    const score = ((Math.log10(50e6) - Math.log10(Math.max(usd, 1))) / (Math.log10(50e6) - Math.log10(1e6))) * 100;
    add("liquidity", "Liquidity", clamp(score),
      `Avg daily turnover ${fmt(avg / 1e6, 1)}M ${ccy}` + (ccy !== "USD" ? ` (~${fmt(usd / 1e6, 1)}M USD)` : ""),
      "50M USD/day and more is treated as low liquidity friction.");
  } else if (dv.length >= 1) {
    add("liquidity", "Liquidity", null, `turnover in ${ccy || "an unknown currency"} cannot be converted`, "Requires a known quote currency.");
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
  if (excludedPartial) notes.push("Today's daily candle is still forming and is excluded from the volume and liquidity factors.");
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

// ------------------------------------------------------------------ caching and HTTP handling
const memCache = new Map();

function memGet(key) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (hit.exp <= Date.now()) { memCache.delete(key); return null; }
  return hit;
}

function memSet(key, status, body, ttl) {
  // Delete existing key first to refresh insertion order without unnecessary eviction
  if (memCache.has(key)) memCache.delete(key);
  else if (memCache.size >= MEM_MAX_ENTRIES) memCache.delete(memCache.keys().next().value);
  memCache.set(key, { exp: Date.now() + ttl * 1000, status, body });
}

function getCache() {
  try { return typeof caches !== "undefined" ? caches.default : null; } catch { return null; }
}

function withHeader(res, name, value) {
  const headers = new Headers(res.headers); headers.set(name, value);
  return new Response(res.body, { status: res.status, headers });
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra },
  });
}
const NO_STORE = { "cache-control": "no-store" };

async function rateLimited(request, env) {
  const rl = env?.RATE_LIMITER;
  if (!rl || typeof rl.limit !== "function") return false;
  try {
    const ip = request.headers.get("cf-connecting-ip") || "anonymous";
    const { success } = await rl.limit({ key: ip });
    return !success;
  } catch { return false; }
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMS.has(key)) return json({ error: "unsupported_parameter", message: `Unsupported query parameter: ${key}` }, 400, NO_STORE);
  }
  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return json({ error: "invalid_symbol", message: "Invalid ticker symbol (letters, numbers, dot, hyphen; max 15 chars)." }, 400, NO_STORE);
  let offer = null;
  const offerRaw = (url.searchParams.get("offer") || "").trim().replace(",", ".");
  if (offerRaw) {
    offer = OFFER_RE.test(offerRaw) ? Number(offerRaw) : NaN;
    if (!Number.isFinite(offer) || offer <= 0 || offer > 1e6) return json({ error: "invalid_offer", message: "Invalid offer/reference price." }, 400, NO_STORE);
  }
  const keyUrl = new URL("/api/fragility", url.origin);
  keyUrl.searchParams.set("symbol", symbol);
  if (offer !== null) keyUrl.searchParams.set("offer", String(offer));
  const key = keyUrl.toString();
  const isHead = request.method === "HEAD";
  const mem = memGet(key);
  if (mem) {
    const left = Math.max(1, Math.ceil((mem.exp - Date.now()) / 1000));
    const res = json(mem.body, mem.status, { "cache-control": `public, max-age=${left}`, "x-cache": "MEM-HIT" });
    return isHead ? new Response(null, { status: res.status, headers: res.headers }) : res;
  }
  const cache = getCache();
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const res = withHeader(hit, "x-cache", "HIT");
        return isHead ? new Response(null, { status: res.status, headers: res.headers }) : res;
      }
    } catch {}
  }
  if (await rateLimited(request, env)) return json({ error: "rate_limited", message: "Too many requests. Please wait a minute and try again." }, 429, { "retry-after": "60", ...NO_STORE });

  const requestId = crypto.randomUUID();
  let data;
  try { data = await loadCandles(symbol); }
  catch (e) {
    const err = asUpstream(e, "unknown_upstream_error");
    console.error(JSON.stringify({ requestId, event: "fragility_upstream_error", symbol, kind: err.kind, error: err.message }));
    if (err.kind === "notfound") {
      const body = { error: "no_data", message: `No price data found for ${symbol}. For non-US exchanges, add the suffix (e.g. RHM.DE for XETRA, VOD.L for London). Pre-IPO tickers have no market data until listing.`, requestId };
      memSet(key, 404, body, NEGATIVE_CACHE_SECONDS);
      const res = json(body, 404, { "cache-control": `public, max-age=${NEGATIVE_CACHE_SECONDS}`, "x-cache": "MISS" });
      if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
      return isHead ? new Response(null, { status: res.status, headers: res.headers }) : res;
    }
    return json({ error: "upstream_unavailable", message: "The market data source is busy or unavailable. Please try again shortly.", requestId }, 503,
      { "retry-after": err.kind === "limited" ? "60" : "30", ...NO_STORE });
  }

  let result;
  try { result = computeFragility(data.rows, data.meta, { offer }, data.interval); }
  catch (e) {
    console.error(JSON.stringify({ requestId, event: "fragility_compute_error", symbol, error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "compute_failed", message: "The index could not be calculated for this ticker.", requestId }, 500, NO_STORE);
  }
  const body = {
    version: VERSION, symbol, name: data.meta.name, exchange: data.meta.exchange, currency: data.meta.currency,
    source: data.source, generatedAt: new Date().toISOString(), ...result, disclaimer: DISCLAIMER,
  };
  memSet(key, 200, body, CACHE_SECONDS);
  const res = json(body, 200, { "cache-control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`, "x-cache": "MISS" });
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return isHead ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/fragility") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD", "cache-control": "no-store" } });
      }
      return handleApi(request, env, ctx);
    }
    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
