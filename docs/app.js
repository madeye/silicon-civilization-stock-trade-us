// Static renderer for snapshots in ./data/*.json.
// No build step, no framework — just fetch + DOM.

const $ = (sel) => document.querySelector(sel);
const fmt = {
  num: (v, digits = 2) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(digits)),
  pct: (v, digits = 1) => (v == null || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`),
  int: (v) => (v == null ? "—" : v.toLocaleString()),
  money: (v) => (v == null ? "—" : `$${Math.round(v).toLocaleString()}`),
};

async function loadJson(name) {
  const r = await fetch(`./data/${name}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${name} ${r.status}`);
  return r.json();
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------- KPI summary ----------
function renderKpis({ universe, analyst, signals, backtest, meta }) {
  const grid = $("#kpi-grid");
  grid.innerHTML = "";
  const themes = new Set(universe.entries.map((e) => e.theme));
  const total = universe.entries.length;
  const globalCount = universe.entries.filter((e) => e.global_supply).length;
  const globalPct = total ? Math.round((globalCount / total) * 100) : 0;
  const upsideCount = analyst.items.filter((a) => (a.upside_pct ?? 0) > 0).length;
  const buys = (signals?.signals ?? []).filter((s) => s.action === "buy").length;
  const sells = (signals?.signals ?? []).filter((s) => s.action === "sell").length;
  const stamp = new Date(meta.generated_at);
  const stampStr = stamp.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const cards = [
    ["Watchlist", `${universe.entries.length}`, `${themes.size} sub-themes`],
    ["Global supply chain", `${globalCount}`, `${globalPct}% coverage`],
    ["Upside > 0", `${upsideCount}`, `by analyst target`],
    ["DeepSeek signals", `${buys} buy / ${sells} sell`, `${signals?.signals?.length ?? 0} total`],
  ];
  for (const [label, value, sub] of cards) {
    grid.appendChild(el("div", { class: "metric" }, [
      el("span", { class: "label" }, label),
      el("strong", {}, value),
      el("span", {}, sub),
    ]));
  }
  $("#meta-line").textContent = `Generated: ${stampStr} · Watchlist updated: ${universe.updated_at} (${universe.updated_by})`;
}

// ---------- Universe table ----------
function renderUniverse({ universe, analyst }) {
  const analystBySym = new Map(analyst.items.map((a) => [a.symbol, a]));
  const themes = [...new Set(universe.entries.map((e) => e.theme))].sort();
  const themeSelect = $("#theme");
  for (const t of themes) themeSelect.appendChild(el("option", { value: t }, t));

  const state = { query: "", theme: "all", onlyGlobal: false, onlyUpside: false };
  $("#search").addEventListener("input", (e) => { state.query = e.target.value.trim().toLowerCase(); render(); });
  $("#theme").addEventListener("change", (e) => { state.theme = e.target.value; render(); });
  $("#onlyGlobal").addEventListener("change", (e) => { state.onlyGlobal = e.target.checked; render(); });
  $("#onlyUpside").addEventListener("change", (e) => { state.onlyUpside = e.target.checked; render(); });

  function render() {
    const grid = $("#universe-grid");
    grid.innerHTML = "";
    let shown = 0;
    const grouped = new Map();
    for (const e of universe.entries) {
      const a = analystBySym.get(e.symbol);
      if (state.theme !== "all" && e.theme !== state.theme) continue;
      if (state.onlyGlobal && !e.global_supply) continue;
      if (state.onlyUpside && !(a?.upside_pct > 0)) continue;
      if (state.query) {
        const hay = `${e.symbol} ${e.name} ${e.theme} ${e.note ?? ""}`.toLowerCase();
        if (!hay.includes(state.query)) continue;
      }
      shown++;
      if (!grouped.has(e.theme)) grouped.set(e.theme, []);
      grouped.get(e.theme).push({ e, a });
    }
    for (const [theme, items] of grouped) {
      const tbody = el("tbody");
      for (const { e, a } of items) {
        const u = a?.upside_pct;
        const uClass = u == null ? "muted" : u > 0 ? "pos" : "neg";
        tbody.appendChild(el("tr", {}, [
          el("td", { class: "mono" }, e.symbol),
          el("td", {}, [
            el("div", { class: "stock-name" }, e.name),
            e.note ? el("div", { class: "stock-note" }, e.note) : null,
          ]),
          el("td", {}, el("span", { class: e.global_supply ? "pill good" : "pill" }, e.global_supply ? "Yes" : "No")),
          el("td", { class: "num" }, fmt.num(a?.current_price)),
          el("td", { class: "num" }, fmt.num(a?.implied_target)),
          el("td", { class: `num ${uClass}` }, u == null ? "—" : fmt.pct(u, 0)),
          el("td", { class: "num muted" }, a?.buy_count != null && a?.total_count ? `${a.buy_count}/${a.total_count}` : "—"),
        ]));
      }
      const panel = el("div", { class: "theme-panel" }, [
        el("div", { class: "theme-title" }, [
          el("strong", {}, theme),
          el("span", {}, `${items.length}`),
        ]),
        el("div", { class: "table-wrap" }, el("table", {}, [
          el("thead", {}, el("tr", {}, [
            el("th", {}, "Ticker"), el("th", {}, "Name"), el("th", {}, "Global"),
            el("th", { class: "num" }, "Price"), el("th", { class: "num" }, "Target"),
            el("th", { class: "num" }, "Upside"), el("th", { class: "num" }, "Buy rating"),
          ])),
          tbody,
        ])),
      ]);
      grid.appendChild(panel);
    }
    $("#status").textContent = `Showing ${shown}/${universe.entries.length}`;
  }
  render();
}

// ---------- Signals ----------
function renderSignals({ universe, signals }) {
  const tbody = $("#signals-table tbody");
  tbody.innerHTML = "";
  if (!signals) {
    tbody.appendChild(el("tr", {}, el("td", { colspan: 8, class: "muted" }, "No signal snapshot")));
    return;
  }
  const sigBySym = new Map((signals.signals ?? []).map((s) => [s.symbol, s]));
  const fundBySym = new Map((signals.fundamentals ?? []).map((f) => [f.symbol, f]));
  let buys = 0, sells = 0;
  // Sort: buys by confidence desc, then sells, then holds.
  const order = { buy: 0, hold: 2, sell: 1 };
  const rows = universe.entries
    .map((e) => ({ e, s: sigBySym.get(e.symbol), f: fundBySym.get(e.symbol) }))
    .sort((a, b) => {
      const oa = order[a.s?.action ?? "hold"], ob = order[b.s?.action ?? "hold"];
      if (oa !== ob) return oa - ob;
      return (b.s?.confidence ?? 0) - (a.s?.confidence ?? 0);
    });
  for (const { e, s, f } of rows) {
    if (s?.action === "buy") buys++;
    else if (s?.action === "sell") sells++;
    tbody.appendChild(el("tr", {}, [
      el("td", { class: "mono" }, e.symbol),
      el("td", {}, e.name),
      el("td", { class: "muted" }, e.theme),
      el("td", {}, el("span", { class: `badge ${s?.action ?? ""}` }, s?.action ?? "n/a")),
      el("td", { class: "num" }, s ? `${(s.confidence * 100).toFixed(0)}%` : "—"),
      el("td", { class: "num" }, s ? `${(s.size * 100).toFixed(0)}%` : "—"),
      el("td", { class: "num" }, fmt.num(f?.pe_ttm, 1)),
      el("td", { class: "muted signal-reason" }, s?.rationale ?? "—"),
    ]));
  }
  $("#signals-summary").textContent = `${buys} buy · ${sells} sell`;
}

// ---------- Backtest ----------
function renderBacktest(bt) {
  if (!bt) return;
  const { config, stats, equityCurve, trades } = bt;
  $("#backtest-window").textContent =
    `${config.startDate} → ${config.endDate} · Start cash $${config.startCash.toLocaleString()}` +
    ` · Rebalance every ${config.rebalanceEveryNDays} days · Max ${config.maxPositions} positions · Fee ${config.feeBps}bps`;

  const kpi = $("#backtest-kpi");
  kpi.innerHTML = "";
  const cards = [
    ["Total return", fmt.pct(stats.totalReturnPct, 1), stats.totalReturnPct >= 0 ? "pos" : "neg", "full period"],
    ["CAGR", fmt.pct(stats.cagrPct, 1), stats.cagrPct >= 0 ? "pos" : "neg", "compound annual"],
    ["Max drawdown", fmt.pct(stats.maxDrawdownPct, 1), "neg", "peak-to-trough"],
    ["Sharpe", stats.sharpe == null ? "—" : stats.sharpe.toFixed(2), "", `${stats.trades} trades`],
  ];
  for (const [label, value, cls, sub] of cards) {
    kpi.appendChild(el("div", { class: "metric" }, [
      el("span", { class: "label" }, label),
      el("strong", { class: cls }, value),
      el("span", {}, sub),
    ]));
  }

  drawEquityChart(equityCurve, config.startCash);

  const tbody = $("#trades-table tbody");
  tbody.innerHTML = "";
  // Most recent first.
  const recent = trades.slice().reverse();
  for (const t of recent) {
    tbody.appendChild(el("tr", {}, [
      el("td", { class: "mono" }, t.date),
      el("td", {}, el("span", { class: `badge ${t.side}` }, t.side)),
      el("td", { class: "mono" }, t.symbol),
      el("td", { class: "num" }, fmt.int(t.shares)),
      el("td", { class: "num" }, fmt.num(t.price)),
    ]));
  }
  $("#trades-count").textContent = `${trades.length} total (newest first)`;
}

function drawEquityChart(curve, baseline) {
  const canvas = $("#equity-chart");
  if (!curve || curve.length === 0) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  function draw() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const pad = { l: 56, r: 12, t: 12, b: 26 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const values = curve.map((b) => b.equity);
    const min = Math.min(baseline, ...values);
    const max = Math.max(baseline, ...values);
    const range = max - min || 1;
    const denom = curve.length > 1 ? curve.length - 1 : 1;
    const xAt = (i) => pad.l + (i / denom) * innerW;
    const yAt = (v) => pad.t + innerH - ((v - min) / range) * innerH;

    // grid + y axis labels
    ctx.font = "11px ui-sans-serif, -apple-system, sans-serif";
    ctx.fillStyle = "#9ca39a";
    ctx.strokeStyle = "#30343b";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = min + (range * i) / 4;
      const y = yAt(v);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(W - pad.r, y);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(`$${Math.round(v / 1000)}k`, pad.l - 6, y);
    }

    // baseline line
    ctx.strokeStyle = "rgba(242,184,75,0.6)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, yAt(baseline));
    ctx.lineTo(W - pad.r, yAt(baseline));
    ctx.stroke();
    ctx.setLineDash([]);

    // equity line + fill
    const last = curve[curve.length - 1].equity;
    const color = last >= baseline ? "#63d471" : "#ff6b6b";
    ctx.fillStyle = last >= baseline ? "rgba(99,212,113,0.15)" : "rgba(255,107,107,0.15)";
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(curve[0].equity));
    for (let i = 1; i < curve.length; i++) ctx.lineTo(xAt(i), yAt(curve[i].equity));
    ctx.lineTo(xAt(curve.length - 1), pad.t + innerH);
    ctx.lineTo(xAt(0), pad.t + innerH);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(curve[0].equity));
    for (let i = 1; i < curve.length; i++) ctx.lineTo(xAt(i), yAt(curve[i].equity));
    ctx.stroke();

    // x labels: first, middle, last
    ctx.fillStyle = "#9ca39a";
    ctx.textBaseline = "top";
    const ticks = [0, Math.floor(curve.length / 2), curve.length - 1];
    for (const i of ticks) {
      ctx.textAlign = i === 0 ? "left" : i === curve.length - 1 ? "right" : "center";
      ctx.fillText(curve[i].date, xAt(i), H - pad.b + 6);
    }
  }
  draw();
  // Redraw on resize (debounced).
  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  });
}

// ---------- Boot ----------
(async () => {
  try {
    const [universe, analyst, meta] = await Promise.all([
      loadJson("universe.json"),
      loadJson("analyst.json"),
      loadJson("meta.json"),
    ]);
    const [signals, backtest] = await Promise.all([
      loadJson("signals.json").catch(() => null),
      loadJson("backtest.json").catch(() => null),
    ]);
    renderKpis({ universe, analyst, signals, backtest, meta });
    renderUniverse({ universe, analyst });
    renderSignals({ universe, signals });
    renderBacktest(backtest);
  } catch (e) {
    document.body.innerHTML =
      `<div class="container"><h1>Load failed</h1><p>${e.message}</p>` +
      `<p>Run <code>npx tsx scripts/snapshot.ts</code> under <code>web/</code> first to generate <code>docs/data/</code>.</p></div>`;
  }
})();
