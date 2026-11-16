FRAGILITY_WIDGET = """
    <h3 style="margin-top:2.5rem;">SINGLE-STOCK FRAGILITY CHECK</h3>
    <div class="posture-card">
        <div class="badge-sub" style="margin-bottom:0.8rem;">
            Measures structural market tension for an equity from price and volume data (no direction, no trading signal).
        </div>
        <form id="frag-form" style="display:flex;flex-wrap:wrap;gap:0.6rem;margin-bottom:1rem;">
            <input id="frag-sym" placeholder="Ticker (e.g. SPCX, ANT, RHM.DE)" maxlength="15" autocomplete="off" required
                   style="background:#090b0e;color:#e2e8f0;border:1px solid #2d3748;border-radius:4px;padding:0.55rem 0.7rem;font:inherit;text-transform:uppercase;width:15.5rem;">
            <input id="frag-off" placeholder="Offer / ref price (opt.)" inputmode="decimal" autocomplete="off"
                   style="background:#090b0e;color:#e2e8f0;border:1px solid #2d3748;border-radius:4px;padding:0.55rem 0.7rem;font:inherit;width:13.5rem;">
            <button type="submit"
                    style="background:#1a202c;color:#63b3ed;border:1px solid #2d3748;border-radius:4px;padding:0.55rem 1.1rem;font:inherit;cursor:pointer;">
                Check
            </button>
        </form>
        <div id="frag-out"></div>
        <details style="font-size:0.78rem;color:#718096;margin-top:0.8rem;">
            <summary style="cursor:pointer;">How it is calculated</summary>
            <p style="margin-top:0.4rem;">Eight factors (0–100, higher = more fragile): Volatility 25%, Upside Extension 15%, Peak Drawdown 15%, Overnight Gaps 10%, Volume Spike 10%, Liquidity 10%, History Depth 15%, Offer Price Distance 15% (optional). Young IPOs (&lt; 5 trading days) automatically fall back to 1h intraday candles. Include exchange suffixes for non-US stocks (e.g. RHM.DE for XETRA).</p>
        </details>
    </div>
    <script>
    (() => {
      const out = document.getElementById("frag-out");
      const form = document.getElementById("frag-form");
      const symEl = document.getElementById("frag-sym");
      const offEl = document.getElementById("frag-off");
      const colors = { stable: "#00ff66", elevated: "#ffcc00", fragile: "#ff6600" };
      const el = (tag, text, style) => {
        const e = document.createElement(tag);
        if (text !== undefined) e.textContent = text;
        if (style) e.style.cssText = style;
        return e;
      };
      function render(d) {
        out.replaceChildren();
        const col = colors[d.labelClass] || "#d1d5db";
        out.append(el("div", `${d.symbol} · ${d.name}${d.exchange ? " · " + d.exchange : ""} · Price: ${d.price} ${d.currency || ""} · As of ${d.asOf} (${d.source})`, "color:#718096;font-size:0.8rem;margin-bottom:0.6rem;"));
        const head = el("div", "", "display:flex;flex-wrap:wrap;align-items:baseline;gap:0.9rem;margin-bottom:0.8rem;");
        head.append(
          el("span", String(d.score), `font-size:2.3rem;font-weight:bold;line-height:1;color:${col};`),
          el("span", d.label.toUpperCase(), `font-weight:bold;color:${col};`),
          el("span", `State: ${d.regime}`, "color:#e2e8f0;font-size:0.85rem;"),
          el("span", `Depth: ${d.quality} (${d.tradingDays}d)`, "color:#718096;font-size:0.8rem;")
        );
        out.append(head);
        for (const f of d.factors) {
          const wrap = el("div", "", "border-top:1px solid #161b22;padding:0.45rem 0;");
          const row = el("div", "", "display:flex;justify-content:space-between;gap:0.8rem;font-size:0.85rem;");
          const mid = el("span", f.valueText, "color:#a0aec0;flex:1;");
          mid.title = f.explain;
          row.append(
            el("strong", f.label, "min-width:11.5rem;color:#cbd5e0;"),
            mid,
            el("span", f.score === null ? "n/a" : String(f.score), "background:#1a202c;border-radius:3px;padding:1px 8px;font-weight:bold;white-space:nowrap;")
          );
          wrap.append(row);
          if (f.score !== null) {
            const bar = el("div", "", "height:4px;background:#1a202c;border-radius:2px;margin-top:0.35rem;");
            bar.append(el("div", "", `height:4px;background:#63b3ed;border-radius:2px;width:${Math.max(2, f.score)}%;`));
            wrap.append(bar);
          }
          out.append(wrap);
        }
        for (const n of d.notes) out.append(el("div", n, "color:#718096;font-size:0.78rem;margin-top:0.4rem;"));
      }
      async function run(symbol, offer) {
        out.replaceChildren(el("div", "Loading market data ...", "color:#a0aec0;font-size:0.85rem;"));
        const q = new URLSearchParams({ symbol });
        if (offer) q.set("offer", offer);
        try {
          const res = await fetch("/api/fragility?" + q);
          const d = await res.json();
          if (!res.ok) { out.replaceChildren(el("div", d.message || "Error", "color:#ff6600;font-size:0.85rem;")); return; }
          render(d);
        } catch {
          out.replaceChildren(el("div", "Failed to fetch API.", "color:#ff6600;font-size:0.85rem;"));
        }
      }
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const s = symEl.value.trim().toUpperCase();
        const o = offEl.value.trim();
        if (s) { location.hash = s + (o ? "," + o : ""); run(s, o); }
      });
      const h = decodeURIComponent(location.hash.slice(1)).split(",");
      if (h[0] && /^[A-Za-z0-9.\\-]{1,15}$/.test(h[0])) {
        symEl.value = h[0].toUpperCase();
        if (h[1]) offEl.value = h[1];
        run(h[0].toUpperCase(), h[1] || "");
      }
    })();
    </script>
"""
