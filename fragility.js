(() => {
  const out = document.getElementById("frag-out");
  const form = document.getElementById("frag-form");
  const symEl = document.getElementById("frag-sym");
  const offEl = document.getElementById("frag-off");
  const btnEl = document.getElementById("frag-btn");
  if (!out || !form || !symEl || !offEl) return;

  const colors = { stable: "#00ff66", elevated: "#ffcc00", fragile: "#ff6600" };
  const NUMBER = /^\d+(\.\d+)?$/;
  const cleanOffer = (v) => (v || "").trim().replace(",", ".");
  let reqId = 0;

  const el = (tag, text, style) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (style) e.style.cssText = style;
    return e;
  };

  function render(d) {
    out.replaceChildren();
    const col = colors[d.labelClass] || "#d1d5db";
    out.append(
      el(
        "div",
        `${d.symbol} · ${d.name}${d.exchange ? " · " + d.exchange : ""} · Price: ${d.price} ${d.currency || ""} · As of ${d.asOf} (${d.source})`,
        "color:#718096;font-size:0.8rem;margin-bottom:0.6rem;"
      )
    );
    const head = el("div", "", "display:flex;flex-wrap:wrap;align-items:baseline;gap:0.9rem;margin-bottom:0.8rem;");
    head.append(
      el("span", String(d.score), `font-size:2.3rem;font-weight:bold;line-height:1;color:${col};`),
      el("span", (d.label || "").toUpperCase(), `font-weight:bold;color:${col};`),
      el("span", `State: ${d.regime}`, "color:#e2e8f0;font-size:0.85rem;"),
      el("span", `Depth: ${d.quality} (${d.tradingDays}d)`, "color:#718096;font-size:0.8rem;")
    );
    out.append(head);

    for (const f of d.factors || []) {
      const wrap = el("div", "", "border-top:1px solid #161b22;padding:0.45rem 0;");
      const row = el("div", "", "display:flex;justify-content:space-between;gap:0.8rem;font-size:0.85rem;");
      const mid = el("span", f.valueText, "color:#a0aec0;flex:1;");
      mid.title = f.explain || "";
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
    for (const n of d.notes || []) {
      out.append(el("div", n, "color:#718096;font-size:0.78rem;margin-top:0.4rem;"));
    }
  }

  async function run(symbol, offer) {
    const id = ++reqId;
    if (btnEl) btnEl.disabled = true;
    out.replaceChildren(el("div", "Loading market data ...", "color:#a0aec0;font-size:0.85rem;"));
    const q = new URLSearchParams({ symbol });
    if (offer) q.set("offer", offer);
    try {
      const res = await fetch("/api/fragility?" + q);
      const d = await res.json();
      if (id !== reqId) return;
      if (!res.ok) {
        out.replaceChildren(el("div", d.message || "Error", "color:#ff6600;font-size:0.85rem;"));
        return;
      }
      render(d);
    } catch {
      if (id !== reqId) return;
      out.replaceChildren(el("div", "Failed to fetch API.", "color:#ff6600;font-size:0.85rem;"));
    } finally {
      if (id === reqId && btnEl) btnEl.disabled = false;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const s = symEl.value.trim().toUpperCase();
    const o = cleanOffer(offEl.value);
    if (o && !NUMBER.test(o)) {
      out.replaceChildren(el("div", "The offer price must be a number, for example 12.5", "color:#ff6600;font-size:0.85rem;"));
      return;
    }
    offEl.value = o;
    if (s) {
      location.hash = s + (o ? "," + o : "");
      run(s, o);
    }
  });

  let rawHash = "";
  try {
    rawHash = decodeURIComponent(location.hash.slice(1));
  } catch {
    rawHash = "";
  }
  const h = rawHash.split(",");
  if (h[0] && /^[A-Za-z0-9.-]{1,15}$/.test(h[0])) {
    const offer = cleanOffer(h.slice(1).join("."));
    const validOffer = NUMBER.test(offer) ? offer : "";
    symEl.value = h[0].toUpperCase();
    offEl.value = validOffer;
    run(h[0].toUpperCase(), validOffer);
  }
})();
