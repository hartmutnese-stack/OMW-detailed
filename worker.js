// OPEN FRAGILITY CHECK (Cloudflare Worker, no dependencies)
// Version 0.2.0 - IPO-ready (1h Intraday Fallback + Stretch/Drawdown State)

const VERSION = "0.2.0";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CACHE_SECONDS = 300;
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

const DISCLAIMER =
  "Misst den Zustand des Marktes für diese Aktie aus Kurs- und Volumendaten. " +
  "Keine Richtung, kein Handelssignal, keine Anlageberatung, keine Aussage über die Qualität des Unternehmens. " +
  "Skalen und Gewichte sind Schätzungen ohne Kalibrierung.";

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

const fmt = (x, d = 1) => x.toFixed(d).replace(".", ",");
class UpstreamError extends Error {}

// ------------------------------------------------------------------ data sources
async function fromYahoo(symbol, interval = "1d", range = "1y") {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new UpstreamError(`yahoo_http_${res.status}`);
  let json;
  try { json = await res.json(); } catch { throw new UpstreamError("yahoo_invalid_json"); }
  const r = json?.chart?.result?.[0];
  if (!r) throw new UpstreamError("yahoo_no_result");
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (num(o) && num(h) && num(l) && num(c) && c > 0) {
      rows.push({ t: ts[i] * 1000, o, h, l, c, v: num(v) ? v : 0 });
    }
  }
  const m = r.meta || {};
  return {
    rows, interval, source: interval === "1h" ? "yahoo (1h intraday)" : "yahoo",
    meta: { name: m.longName || m.shortName || symbol, exchange: m.fullExchangeName || m.exchangeName || "", currency: m.currency || "" },
  };
}

async function fromStooq(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&i=d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new UpstreamError(`stooq_http_${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^date,open/i.test(lines[0])) throw new UpstreamError("stooq_no_data");
  const rows = [];
  for (const line of lines.slice(1)) {
    const [d, o, h, l, c, v] = line.split(",");
    const t = Date.parse(d + "T00:00:00Z");
    const O = parseFloat(o), H = parseFloat(h), L = parseFloat(l), C = parseFloat(c), V = parseFloat(v);
    if ([t, O, H, L, C].every(Number.isFinite) && C > 0) rows.push({ t, o: O, h: H, l: L, c: C, v: Number.isFinite(V) ? V : 0 });
  }
  return { rows: rows.slice(-260), interval: "1d", source: "stooq", meta: { name: symbol, exchange: "", currency: "USD" } };
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

  // Junge IPOs (Tag 1 bis 4): Fallback auf 1h-Intraday-Kerzen
  if (dailyData && dailyData.rows.length > 0 && dailyData.rows.length < 5) {
    try {
      const intra = await fromYahoo(symbol, "1h", "5d");
      if (intra.rows.length >= 3) return intra;
    } catch { /* weiter zu dailyData falls vorhanden */ }
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
  const factors = [];
  const add = (key, label, score, valueText, explain) =>
    factors.push({ key, label, weight: WEIGHTS[key], score: score === null ? null : Math.round(score), valueText, explain });

  // 1. volatility (annualisiert: 252 Tage oder 252 * 6.5 Stunden)
  const annFactor = isIntra ? Math.sqrt(252 * 6.5) : Math.sqrt(252);
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(Math.log(c[i] / c[i - 1]));
  if (rets.length >= 4) {
    const win = isIntra ? 20 : 10;
    const volNow = stdev(rets.slice(-win)) * annFactor * 100;
    const parts = [clamp(volNow - 20)];
    let txt = `${isIntra ? "Intraday" : "10-Tage"}-Schwankung ${fmt(volNow, 0)} % p. a.`;
    const baseRets = !isIntra ? rets.slice(Math.max(0, rets.length - 70), rets.length - 10) : [];
    if (baseRets.length >= 30) {
      const baseVol = stdev(baseRets) * Math.sqrt(252) * 100;
      if (baseVol > 0) {
        const ratio = volNow / baseVol;
        parts.push(clamp(ratio <= 1 ? 20 * ratio : 20 + ((ratio - 1) / 2) * 80));
        txt += `, ${fmt(ratio, 1)}-fach der Zeit davor`;
      }
    }
    add("volatility", "Schwankung", mean(parts), txt, "Realisierte Kursschwankung.");
  } else add("volatility", "Schwankung", null, "zu wenig Datenpunkte", "Braucht mindestens 5 Kerzen.");

  // 2. extension
  let extPct = null;
  if (!isIntra && n >= 20) {
    const m = Math.min(n, 50);
    const sma = mean(c.slice(-m));
    extPct = (last / sma - 1) * 100;
    const run = n > 20 ? (last / c[n - 21] - 1) * 100 : null;
    const parts = [clamp((Math.max(extPct, 0) / 40) * 100)];
    if (run !== null) parts.push(clamp((Math.max(run, 0) / 60) * 100));
    add("extension", "Überdehnung", Math.max(...parts),
      `${fmt(Math.abs(extPct))} % ${extPct >= 0 ? "über" : "unter"} dem ${m}-Tage-Schnitt` + (run !== null ? `, 20 Tage: ${run >= 0 ? "+" : ""}${fmt(run, 0)} %` : ""),
      "Abstand über dem gleitenden Durchschnitt.");
  } else add("extension", "Überdehnung", null, "weniger als 20 Handelstage", "Braucht mindestens 20 Handelstage.");

  // 3. drawdown
  let ddPct = 0;
  if (n >= 2) {
    const peak = Math.max(...rows.map((r) => r.h));
    ddPct = ((peak - last) / peak) * 100;
    add("drawdown", "Rückgang vom Hoch", clamp((ddPct / 40) * 100),
      `${fmt(ddPct)} % unter dem Hoch (${uniqueDays} ${uniqueDays === 1 ? "Handelstag" : "Handelstage"})`,
      "Abstand zum höchsten Kurs im betrachteten Zeitraum.");
  } else add("drawdown", "Rückgang vom Hoch", null, "zu wenig Daten", "Braucht mindestens 2 Kerzen.");

  // 4. gaps
  if (!isIntra && n >= 4) {
    const k = Math.min(20, n - 1);
    const gaps = [];
    for (let i = n - k; i < n; i++) gaps.push(Math.abs(rows[i].o / rows[i - 1].c - 1) * 100);
    const avg = mean(gaps);
    add("gaps", "Kurslücken", clamp((avg / 4) * 100), `Ø ${fmt(avg, 2)} % Lücke zum Vortag (${k} Tage)`, "Eröffnungssprünge über Nacht.");
  } else add("gaps", "Kurslücken", null, "erst ab 4 Handelstagen", "Braucht mindestens 4 Tagesschlüsse.");

  // 5. volume
  const vols = rows.map((r) => r.v);
  if (!isIntra && n >= 7 && vols.slice(-2).every((v) => v > 0)) {
    const prev = vols.slice(Math.max(0, n - 22), n - 2).filter((v) => v > 0);
    if (prev.length >= 5) {
      const rvol = mean(vols.slice(-2)) / mean(prev);
      const s = rvol >= 1 ? 20 + ((rvol - 1) / 4) * 80 : 20 + (1 - rvol) * 40;
      add("volume", "Handelsvolumen", clamp(s), `${fmt(rvol, 1)}-faches Volumen (letzte 2 Tage vs. davor)`, "Ungewöhnliche Umsatzspitzen oder -flauten.");
    } else add("volume", "Handelsvolumen", null, "zu wenig Volumendaten", "Braucht mindestens 5 Vortage.");
  } else add("volume", "Handelsvolumen", null, "zu kurze Historie", "Braucht mindestens 7 Handelstage.");

  // 6. liquidity (Umsatz pro Kalendertag aggregiert)
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
    add("liquidity", "Handelbarkeit", clamp(s), `Ø Tagesumsatz ${fmt(avg / 1e6, 1)} Mio. $`, "Ab 50 Mio. $/Tag gilt Liquidität als unkritisch.");
  } else add("liquidity", "Handelbarkeit", null, "keine Umsatzdaten", "Braucht Volumen und Kurs.");

  // 7. depth
  add("depth", "Länge der Historie", clamp(((120 - uniqueDays) / 120) * 100), `${uniqueDays} Handelstage Historie`, "Ab 120 Tagen kein Aufschlag.");

  // 8. offer premium
  let premPct = null;
  if (num(opts.offer) && opts.offer > 0) {
    premPct = (last / opts.offer - 1) * 100;
    add("offer", "Abstand zum Ausgabepreis", clamp((Math.abs(premPct) / 60) * 100),
      `${premPct >= 0 ? "+" : "-"}${fmt(Math.abs(premPct), 0)} % zum Ausgabepreis ${fmt(opts.offer, 2)}`,
      "Entfernung zum IPO-Ausgabepreis.");
  }

  const avail = factors.filter((f) => f.score !== null);
  const wsum = avail.reduce((s, f) => s + f.weight, 0);
  const score = Math.round(avail.reduce((s, f) => s + f.weight * f.score, 0) / wsum);
  const label = score < 30 ? "stabil" : score < 55 ? "erhöht" : "fragil";
  const labelClass = score < 30 ? "stabil" : score < 55 ? "erhoeht" : "fragil";
  const quality = uniqueDays < 20 ? "niedrig" : uniqueDays < 60 ? "mittel" : "hoch";

  // Deskriptives Lage-Merkmal (Richtungs-Kontext ohne Signalcharakter)
  const stretchedUp = (extPct !== null && extPct > 15) || (premPct !== null && premPct > 30);
  let regime = "Ausgeglichen / normal";
  if (stretchedUp && ddPct < 10) regime = "Nach oben überdehnt (nah am Hoch)";
  else if (stretchedUp && ddPct >= 10 && ddPct < 25) regime = "Rücksetzer nach Überdehnung (Bruch vom Hoch)";
  else if (ddPct >= 25) regime = "Deutlicher Abverkauf vom Hoch (-" + fmt(ddPct, 0) + " %)";

  const notes = [];
  if (isIntra) notes.push("Junger Börsengang: Berechnung nutzt 1h-Intraday-Daten.");
  if (uniqueDays < 20 && !(num(opts.offer) && opts.offer > 0)) {
    notes.push("Tipp für junge IPOs: Ausgabepreis eintragen (z. B. 74 für ANT), um das Aufgeld einzurechnen.");
  }
  notes.push("Der Index misst nur das Risiko-/Spannungsniveau, nicht die künftige Kursrichtung.");

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
  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return json({ error: "invalid_symbol", message: "Kürzel nicht gültig." }, 400);
  let offer = null;
  const offerRaw = (url.searchParams.get("offer") || "").trim().replace(",", ".");
  if (offerRaw) {
    offer = Number(offerRaw);
    if (!Number.isFinite(offer) || offer <= 0 || offer > 1e6) return json({ error: "invalid_offer", message: "Ausgabepreis nicht gültig." }, 400);
  }

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  let data;
  try {
    data = await loadCandles(symbol);
  } catch (e) {
    return json({
      error: "no_data",
      message: `Keine Kursdaten für ${symbol}. (Hinweis: Vor dem Börsengang wie bei ANT bis 19.11. existieren noch keine Nasdaq-Kurse).`,
      detail: e.message,
    }, 502);
  }
  const result = computeFragility(data.rows, data.meta, { offer }, data.interval);
  const body = {
    version: VERSION, symbol, name: data.meta.name, exchange: data.meta.exchange, currency: data.meta.currency,
    source: data.source, generatedAt: new Date().toISOString(), ...result, disclaimer: DISCLAIMER,
  };
  const response = json(body, 200, { "cache-control": `public, max-age=${CACHE_SECONDS}` });
  if (cache && ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    if (url.pathname === "/api/fragility") return handleApi(request, ctx);
    // Alle anderen Pfade (index.html, weather.json etc.) an die statischen Assets durchreichen:
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
