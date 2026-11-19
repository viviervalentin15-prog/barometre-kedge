/* Baromètre des marchés – site à plusieurs pages (navigation par #/...).
   Données : data/macro.json, data/sectors.json, data/companies.json, data/companies/<ticker>.json
   (produites par scripts/build_macro.py et scripts/build_companies.py). */

const S = { macro: null, sectors: null, companies: null, view: "commun", charts: {}, table: {}, detailCache: {} };
const ZONE_LABEL = { US: "États-Unis", EZ: "Zone euro", MONDE: "Monde" };
const TYPE_LABEL = { cyclique: "Cyclique", defensif: "Défensif", neutre: "Neutre" };
const CRISES = [["2008-09", "2009-06", "Crise financière"], ["2020-02", "2020-06", "Covid"], ["2022-02", "2022-10", "Choc d'inflation"]];
const VIEW_ZONES = { commun: ["US", "EZ"], US: ["US"], EZ: ["EZ"] };

/* ---------- outils ---------- */
function scoreColor(s) {
  if (s == null) return "#c7ccd4";
  if (s >= 70) return "#1f8a5b";
  if (s >= 55) return "#5fae7e";
  if (s >= 45) return "#8a8f98";
  if (s >= 30) return "#c27c0e";
  return "#c0392b";
}
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? "–" : Number(x).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (x, d = 1) => (x == null ? "–" : (x > 0 ? "+" : "") + fmt(x, d));
const pctCls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeName = (t) => t.replace(/[^A-Za-z0-9]/g, "_");
const scorePill = (s) => `<span class="score-pill" style="background:${scoreColor(s)}">${fmt(s, 0)}</span>`;
const capLabel = (bn) => (bn == null ? "–" : bn >= 1000 ? fmt(bn / 1000, 2) + " T$" : fmt(bn, bn >= 100 ? 0 : 1) + " Md$");
function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}
function chart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (S.charts[id] && S.charts[id].getDom() !== el) { S.charts[id].dispose(); delete S.charts[id]; }
  if (!S.charts[id]) S.charts[id] = echarts.init(el, null, { renderer: "svg" });
  return S.charts[id];
}
function disposeCharts() { Object.values(S.charts).forEach((c) => c.dispose()); S.charts = {}; }
const sectorLabel = (id) => (S.companies?.sector_labels || S.sectors?.sector_labels || {})[id] || id;

/* ---------- sélection pour les pools (gardée dans le navigateur) ---------- */
const Pool = {
  items: new Set(),
  load() { try { this.items = new Set(JSON.parse(localStorage.getItem("pool-selection") || "[]")); } catch { this.items = new Set(); } },
  save() { try { localStorage.setItem("pool-selection", JSON.stringify([...this.items])); } catch { /* stockage indisponible */ } this.refresh(); },
  toggle(t, on) { on ? this.items.add(t) : this.items.delete(t); this.save(); },
  clear() { this.items.clear(); this.save(); route(); },
  refresh() {
    const n = this.items.size;
    const badge = document.getElementById("pool-count");
    badge.hidden = n === 0; badge.textContent = n;
    document.getElementById("pool-bar").hidden = n === 0 || location.hash.startsWith("#/pools");
    document.getElementById("pool-bar-text").textContent = `${n} entreprise${n > 1 ? "s" : ""} sélectionnée${n > 1 ? "s" : ""}`;
  },
};

/* ---------- démarrage ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(url);
  return r.json();
}

async function init() {
  try { S.macro = await getJSON("data/macro.json"); } catch { document.getElementById("app").innerHTML = '<div class="banner">Données indisponibles.</div>'; return; }
  try { S.sectors = await getJSON("data/sectors.json"); } catch { S.sectors = null; }
  try { S.companies = await getJSON("data/companies.json"); } catch { S.companies = null; }
  const demo = [S.macro.demo && "baromètre macro", S.sectors?.demo && "secteurs et entreprises"].filter(Boolean);
  const banner = document.getElementById("demo-banner");
  banner.hidden = demo.length === 0;
  banner.textContent = `Données simulées pour tester l'affichage (${demo.join(", ")}) : les vraies données arriveront après la prochaine collecte.`;
  const upd = new Date(S.sectors?.updated || S.macro.updated);
  document.getElementById("updated").textContent = "Mise à jour : " + upd.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
  document.querySelectorAll("#zone-switch button").forEach((b) => b.addEventListener("click", () => {
    S.view = b.dataset.view;
    document.querySelectorAll("#zone-switch button").forEach((x) => x.classList.toggle("on", x === b));
    route();
  }));
  document.getElementById("pool-clear").addEventListener("click", () => Pool.clear());
  window.addEventListener("hashchange", () => { window.scrollTo(0, 0); route(); });
  window.addEventListener("resize", () => Object.values(S.charts).forEach((c) => c.resize()));
  Pool.load();
  route();
}

function route() {
  disposeCharts();
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const page = parts[0] || "";
  const nav = { "": "home", macro: "macro", secteur: "home", entreprises: "companies", entreprise: "companies", pools: "pools" }[page];
  document.querySelectorAll(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.route === nav));
  document.getElementById("zone-switch").style.visibility = page === "entreprise" ? "hidden" : "visible";
  Pool.refresh();
  const app = document.getElementById("app");
  if (page === "macro") return pageMacro(app);
  if (page === "secteur") return pageSector(app, parts[1]);
  if (page === "entreprises") return pageCompanies(app);
  if (page === "entreprise") return pageCompany(app, parts[1]);
  if (page === "pools") return pagePools(app);
  return pageHome(app);
}

/* =====================================================================
   ACCUEIL : état du marché + grille des secteurs
   ===================================================================== */
function pageHome(app) {
  const M = S.macro.views[S.view].latest;
  const sv = S.sectors?.views[S.view];
  app.innerHTML = `
    <section class="home-top">
      <a class="card macro-mini" href="#/macro">
        <div class="label">Baromètre macro</div>
        <div class="mini-score" style="color:${scoreColor(M.score)}">${fmt(M.score)}<small> / 100</small></div>
        <div class="signal" style="color:${scoreColor(M.score)}">${M.signal.label}</div>
        <div class="deltas"><span>12 mois <b class="${pctCls(M.delta_12m)}">${signed(M.delta_12m)}</b></span><span>3 mois <b class="${pctCls(M.delta_3m)}">${signed(M.delta_3m)}</b></span></div>
        <div class="mini-pillars">${S.macro.pillars.map((p) => `<div><span>${p.label}</span><div class="bar"><span style="width:${M.pillars[p.id] ?? 0}%;background:${scoreColor(M.pillars[p.id])}"></span></div><b>${fmt(M.pillars[p.id], 0)}</b></div>`).join("")}</div>
        <div class="more">Voir le baromètre détaillé →</div>
      </a>
      <div class="card reading">
        <h2>Lecture du marché</h2>
        ${sv ? readingText(M, sv) : "<p>Les données sectorielles arriveront après la prochaine collecte.</p>"}
      </div>
    </section>
    ${sv ? `
    <section>
      <div class="section-head"><h2>Les secteurs</h2><span class="hint">Cliquez sur un secteur pour voir ses entreprises.</span></div>
      <div class="sector-grid">${sv.sectors.map(sectorCard).join("")}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>De quoi est fait le score de chaque secteur ?</h2></div>
      <p class="hint">Score = ${fmt(S.sectors.method.company_weight * 100, 0)} % moyenne des entreprises + ${fmt(S.sectors.method.trend_weight * 100, 0)} % tendance de marché + ajustement selon le baromètre macro (cycliques favorisés quand le macro est au-dessus de 50, défensifs sinon).</p>
      <div id="sector-decomp" class="chart" style="height:${sv.sectors.length * 30 + 60}px"></div>
    </section>` : ""}`;
  if (!sv) return;
  sv.sectors.forEach((s) => {
    const pts = s.index.slice(-52);
    chart("spark-" + s.id).setOption({ grid: { left: 0, right: 0, top: 2, bottom: 0 }, xAxis: { type: "category", show: false, data: S.sectors.index_dates.slice(-52) },
      yAxis: { type: "value", show: false, scale: true },
      series: [{ type: "line", data: pts, symbol: "none", smooth: true, lineStyle: { width: 1.5, color: (pts.at(-1) >= pts[0]) ? "#1f8a5b" : "#c0392b" } }] });
  });
  const items = [...sv.sectors].reverse();
  const m = S.sectors.method;
  chart("sector-decomp").setOption({
    grid: { left: 170, right: 60, top: 30, bottom: 24 }, legend: { top: 0, data: ["Entreprises", "Tendance", "Ajustement macro"] },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v) => fmt(v) },
    xAxis: { type: "value", min: -10, max: 100, splitLine: { lineStyle: { color: "#eef0f3" } } },
    yAxis: { type: "category", data: items.map((s) => s.label) },
    series: [
      { name: "Entreprises", type: "bar", stack: "s", data: items.map((s) => +(m.company_weight * s.company_score).toFixed(1)), itemStyle: { color: "#1f4e8c" } },
      { name: "Tendance", type: "bar", stack: "s", data: items.map((s) => +(m.trend_weight * s.trend_score).toFixed(1)), itemStyle: { color: "#7ea6d8" } },
      { name: "Ajustement macro", type: "bar", stack: "s", data: items.map((s) => s.macro_tilt), itemStyle: { color: "#c27c0e" } },
      { name: "Score", type: "scatter", symbolSize: 0, tooltip: { show: false },
        data: items.map((s) => m.company_weight * s.company_score + m.trend_weight * s.trend_score + Math.max(s.macro_tilt, 0)),
        label: { show: true, position: "right", distance: 8, color: "#16202e", fontWeight: 600, formatter: (p) => "= " + fmt(items[p.dataIndex].score) } },
    ],
  });
}

function readingText(M, sv) {
  const best = sv.sectors.slice(0, 3).map((s) => s.label).join(", ");
  const worst = sv.sectors.slice(-3).reverse().map((s) => s.label).join(", ");
  const tilt = M.score >= 50 ? "favorise légèrement les secteurs cycliques" : "favorise les secteurs défensifs";
  const n = S.companies ? S.companies.companies.filter((c) => VIEW_ZONES[S.view].includes(c.z)).length : 0;
  return `<p>Le baromètre macro est à <b>${fmt(M.score)}</b> (${M.signal.label.toLowerCase()}), ${M.delta_12m < 0 ? "en recul" : "en hausse"} de ${fmt(Math.abs(M.delta_12m))} points sur un an. Ce contexte ${tilt}.</p>
    <p>Secteurs les mieux notés : <b>${best}</b>.<br>Secteurs les moins bien notés : <b>${worst}</b>.</p>
    <p class="hint">${n} entreprises analysées · <a href="#/entreprises">voir le classement complet →</a></p>`;
}

function sectorCard(s) {
  const top = s.top[0];
  return `<a class="card sector-card" href="#/secteur/${encodeURIComponent(s.id)}">
    <div class="sc-head"><span class="sc-name">${s.label}</span><span class="pill">${TYPE_LABEL[s.type]}</span></div>
    <div class="sc-score" style="color:${scoreColor(s.score)}">${fmt(s.score)}</div>
    <div class="bar"><span style="width:${s.score}%;background:${scoreColor(s.score)}"></span></div>
    <div class="spark" id="spark-${s.id}"></div>
    <div class="sc-stats"><span>1 an <b class="${pctCls(s.perf_1y)}">${signed(s.perf_1y)} %</b></span><span>${s.n} entreprises</span></div>
    ${top ? `<div class="sc-top">Meilleure note : <b>${esc(top.name)}</b> (${fmt(top.score, 0)})</div>` : ""}
  </a>`;
}

/* =====================================================================
   PAGE SECTEUR
   ===================================================================== */
function pageSector(app, id) {
  const s = S.sectors?.views[S.view].sectors.find((x) => x.id === id);
  if (!s) { app.innerHTML = `<div class="card">Ce secteur n'a pas d'entreprise dans la zone choisie. <a href="#/">Retour</a></div>`; return; }
  const m = S.sectors.method;
  app.innerHTML = `
    <a class="back" href="#/">← Tous les secteurs</a>
    <section class="sector-head card">
      <div>
        <div class="label">${TYPE_LABEL[s.type]} · ${s.n} entreprises · ${capLabel(s.cap_usd / 1e9)}</div>
        <h1>${s.label}</h1>
        <div class="decomp">
          <span>Entreprises <b>${fmt(s.company_score)}</b> × ${fmt(m.company_weight * 100, 0)} %</span>
          <span>Tendance <b>${fmt(s.trend_score)}</b> × ${fmt(m.trend_weight * 100, 0)} %</span>
          <span>Ajustement macro <b class="${pctCls(s.macro_tilt)}">${signed(s.macro_tilt)}</b></span>
        </div>
      </div>
      <div class="big-score" style="color:${scoreColor(s.score)}">${fmt(s.score)}<small>/100</small></div>
    </section>
    <section class="kpis">
      ${kpi("Performance 1 mois", signed(s.perf_1m) + " %", pctCls(s.perf_1m))}
      ${kpi("Depuis le 1er janvier", signed(s.perf_ytd) + " %", pctCls(s.perf_ytd))}
      ${kpi("Performance 1 an", signed(s.perf_1y) + " %", pctCls(s.perf_1y))}
      ${kpi("PER médian", fmt(s.pe_median) + " x")}
      ${kpi("Rendement moyen du dividende", fmt(s.div_yield_avg, 2) + " %")}
    </section>
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Indice du secteur sur 5 ans</h2></div>
        <p class="hint">Moyenne équipondérée des cours des entreprises du secteur, base 100.</p><div id="sector-index" class="chart chart-md"></div></div>
      <div class="card"><div class="card-head"><h2>Les 4 familles de critères</h2></div>
        <p class="hint">Moyenne pondérée par la capitalisation, notes sur 100 relatives au secteur.</p><div id="sector-fams" class="chart chart-md"></div></div>
    </section>
    <section class="card"><div class="card-head"><h2>Entreprises du secteur</h2></div><div id="table"></div></section>`;
  chart("sector-index").setOption({
    grid: { left: 44, right: 16, top: 16, bottom: 40 }, tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v) },
    xAxis: { type: "time", splitLine: { show: false } },
    yAxis: { type: "value", scale: true, splitLine: { lineStyle: { color: "#eef0f3" } } },
    dataZoom: [{ type: "inside" }],
    series: [{ type: "line", data: S.sectors.index_dates.map((d, k) => [d, s.index[k]]), symbol: "none", lineStyle: { width: 2, color: "#1f4e8c" }, areaStyle: { color: "rgba(31,78,140,.07)" } }],
  });
  const fams = S.sectors.families;
  chart("sector-fams").setOption({
    grid: { left: 110, right: 40, top: 10, bottom: 20 },
    xAxis: { type: "value", max: 100, splitLine: { lineStyle: { color: "#eef0f3" } } },
    yAxis: { type: "category", data: fams.map((f) => f.label).reverse() },
    series: [{ type: "bar", barWidth: 18, data: fams.map((f) => ({ value: s.families[f.id], itemStyle: { color: scoreColor(s.families[f.id]), borderRadius: 3 } })).reverse(),
      label: { show: true, position: "right", formatter: (p) => fmt(p.value) } }],
  });
  companyTable(document.getElementById("table"), { sector: id });
}

function kpi(label, value, cls = "") { return `<div class="card kpi"><div class="label">${label}</div><div class="kpi-value ${cls}">${value}</div></div>`; }

/* =====================================================================
   LISTE DES ENTREPRISES (page globale et page secteur)
   ===================================================================== */
const SIZE_BUCKETS = [["", "Toutes tailles"], ["200-", "Plus de 200 Md$"], ["50-200", "50 à 200 Md$"], ["10-50", "10 à 50 Md$"], ["0-10", "Moins de 10 Md$"]];

function pageCompanies(app) {
  if (!S.companies) { app.innerHTML = '<div class="card">Les données des entreprises arriveront après la prochaine collecte.</div>'; return; }
  app.innerHTML = `<section class="card"><div class="card-head"><h2>Toutes les entreprises, classées par score</h2></div>
    <p class="hint">Chaque critère est noté par rapport aux entreprises du même secteur. Cochez des entreprises pour les comparer dans un pool.</p>
    <div id="table"></div></section>`;
  companyTable(document.getElementById("table"), {});
}

function companyTable(box, fixed) {
  const key = fixed.sector ? "sector:" + fixed.sector : "all";
  const st = (S.table[key] ||= { q: "", sector: "", industry: "", country: "", size: "", min: 0, sort: "sc", dir: -1, limit: 100 });
  const base = S.companies.companies.filter((c) => VIEW_ZONES[S.view].includes(c.z) && (!fixed.sector || c.s === fixed.sector));
  const opts = (vals, cur, all, label = (v) => v) => `<option value="">${all}</option>` + [...new Set(vals)].filter(Boolean)
    .sort((a, b) => label(a).localeCompare(label(b), "fr")).map((v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label(v))}</option>`).join("");
  box.innerHTML = `
    <div class="filters">
      <input type="search" id="f-q" placeholder="Rechercher une entreprise ou un code" value="${esc(st.q)}">
      ${fixed.sector ? "" : `<select id="f-sector">${opts(base.map((c) => c.s), st.sector, "Tous les secteurs", sectorLabel)}</select>`}
      <select id="f-industry">${opts(base.filter((c) => !st.sector || c.s === st.sector).map((c) => c.i), st.industry, "Toutes les sous-industries")}</select>
      <select id="f-country">${opts(base.map((c) => c.c), st.country, "Tous les pays")}</select>
      <select id="f-size">${SIZE_BUCKETS.map(([v, l]) => `<option value="${v}" ${v === st.size ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label class="range">Score min. <input type="range" id="f-min" min="0" max="90" step="5" value="${st.min}"><b id="f-min-v">${st.min}</b></label>
    </div>
    <div class="table-meta" id="t-meta"></div>
    <div class="table-wrap"><table class="table companies"><thead><tr id="t-head"></tr></thead><tbody id="t-body"></tbody></table></div>
    <div class="more-row"><button class="btn ghost" id="t-more">Afficher plus</button></div>`;
  const fams = S.companies.families;
  const cols = [["", ""], ["n", "Entreprise"], ...(fixed.sector ? [["i", "Sous-industrie"]] : [["s", "Secteur"]]), ["c", "Pays"], ["cap", "Capitalisation", 1],
    ["sc", "Score", 1], ...fams.map((f) => ["f_" + f.id, f.label, 1]), ["p1y", "Perf. 1 an", 1], ["pe", "PER", 1], ["dy", "Dividende", 1]];
  const head = document.getElementById("t-head");
  head.innerHTML = cols.map(([k, l, num]) => `<th data-k="${k}" class="${num ? "num" : ""} ${k ? "sortable" : ""} ${st.sort === k ? (st.dir < 0 ? "desc" : "asc") : ""}">${l}</th>`).join("");
  head.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; st.dir = st.sort === k ? -st.dir : (["n", "s", "i", "c"].includes(k) ? 1 : -1); st.sort = k; companyTable(box, fixed);
  }));
  const draw = () => {
    const q = st.q.toLowerCase();
    const rows = base.filter((c) => (!q || c.n.toLowerCase().includes(q) || c.t.toLowerCase().includes(q))
      && (!st.sector || c.s === st.sector) && (!st.industry || c.i === st.industry) && (!st.country || c.c === st.country)
      && (st.min === 0 || (c.sc ?? -1) >= st.min) && inSize(c.cap, st.size));
    rows.sort((a, b) => {
      const x = st.sort === "s" ? sectorLabel(a.s) : a[st.sort], y = st.sort === "s" ? sectorLabel(b.s) : b[st.sort];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y, "fr") : x - y) * st.dir;
    });
    document.getElementById("t-meta").textContent = `${rows.length} entreprise${rows.length > 1 ? "s" : ""}`;
    document.getElementById("t-body").innerHTML = rows.slice(0, st.limit).map((c) => `<tr>
      <td><input type="checkbox" data-t="${esc(c.t)}" ${Pool.items.has(c.t) ? "checked" : ""} title="Ajouter au pool"></td>
      <td class="name"><a href="#/entreprise/${encodeURIComponent(c.t)}"><b>${esc(c.n)}</b></a><div class="src">${esc(c.t)}</div></td>
      <td class="muted">${esc(fixed.sector ? c.i : sectorLabel(c.s))}</td>
      <td class="muted nowrap">${esc(c.c)}</td>
      <td class="num nowrap">${capLabel(c.cap)}</td>
      <td class="num">${scorePill(c.sc)}</td>
      ${fams.map((f) => `<td class="num fam" style="color:${scoreColor(c["f_" + f.id])}">${fmt(c["f_" + f.id], 0)}</td>`).join("")}
      <td class="num nowrap ${pctCls(c.p1y)}">${signed(c.p1y)} %</td>
      <td class="num">${fmt(c.pe)}</td>
      <td class="num nowrap">${fmt(c.dy, 1)} %</td></tr>`).join("");
    document.getElementById("t-more").style.display = rows.length > st.limit ? "" : "none";
    document.querySelectorAll("#t-body input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => Pool.toggle(cb.dataset.t, cb.checked)));
  };
  const bind = (id, k, ev = "change") => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, () => { st[k] = el.value; st.limit = 100; if (k === "sector") { st.industry = ""; companyTable(box, fixed); } else draw(); });
  };
  bind("f-q", "q", "input"); bind("f-sector", "sector"); bind("f-industry", "industry"); bind("f-country", "country"); bind("f-size", "size");
  const minEl = document.getElementById("f-min");
  minEl.addEventListener("input", () => { st.min = +minEl.value; document.getElementById("f-min-v").textContent = st.min; draw(); });
  document.getElementById("t-more").addEventListener("click", () => { st.limit += 100; draw(); });
  draw();
}

function inSize(cap, bucket) {
  if (!bucket) return true;
  if (cap == null) return false;
  const [lo, hi] = bucket.split("-").map((x) => (x === "" ? Infinity : +x));
  return cap >= lo && cap < hi;
}

/* =====================================================================
   FICHE ENTREPRISE (version de base, enrichie à l'étape 3)
   ===================================================================== */
async function pageCompany(app, ticker) {
  app.innerHTML = '<div class="card">Chargement…</div>';
  let d;
  try { d = S.detailCache[ticker] ||= await getJSON(`data/companies/${safeName(ticker)}.json`); } catch { app.innerHTML = '<div class="card">Entreprise introuvable. <a href="#/entreprises">Retour</a></div>'; return; }
  const fams = S.companies.families;
  const cur = d.currency === "EUR" ? "€" : d.currency === "USD" ? "$" : d.currency;
  app.innerHTML = `
    <a class="back" href="#/secteur/${encodeURIComponent(d.sector)}">← ${d.sector_label}</a>
    <section class="sector-head card">
      <div>
        <div class="label">${esc(d.ticker)} · ${esc(d.country)} · ${esc(d.industry)}</div>
        <h1>${esc(d.long_name || d.name)}</h1>
        <div class="decomp"><span>Rang dans le secteur <b>${d.rank_sector ?? "–"}</b> / ${d.sector_size}</span>
          <label class="check"><input type="checkbox" id="add-pool" ${Pool.items.has(d.ticker) ? "checked" : ""}> Ajouter au pool</label></div>
      </div>
      <div class="big-score" style="color:${scoreColor(d.score)}">${fmt(d.score)}<small>/100</small></div>
    </section>
    <section class="kpis">
      ${kpi("Cours", fmt(d.price, 2) + " " + cur)}
      ${kpi("Capitalisation", capLabel(d.cap_usd / 1e9))}
      ${kpi("Performance 1 an", signed(d.perf.perf_1y) + " %", pctCls(d.perf.perf_1y))}
      ${kpi("Depuis le 1er janvier", signed(d.perf.perf_ytd) + " %", pctCls(d.perf.perf_ytd))}
      ${kpi("PER", fmt(d.metrics.pe.value) + " x")}
      ${kpi("Dividende", fmt(d.metrics.div_yield.value, 2) + " %")}
    </section>
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Cours sur 5 ans</h2></div><div id="c-price" class="chart chart-md"></div></div>
      <div class="card"><div class="card-head"><h2>Score par famille</h2></div><p class="hint">Note sur 100, relative aux entreprises du secteur ${esc(d.sector_label)}.</p><div id="c-fams" class="chart chart-md"></div></div>
    </section>
    <section class="card"><div class="card-head"><h2>Détail des critères</h2></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Famille</th><th>Critère</th><th class="num">Valeur</th><th class="num">Médiane du secteur</th><th class="num">Note /100</th></tr></thead>
      <tbody>${fams.map((f) => f.metrics.map((m, k) => { const x = d.metrics[m.id] || {}; return `<tr>
        <td>${k === 0 ? `<b>${f.label}</b>` : ""}</td><td>${m.label}</td>
        <td class="num">${fmt(x.value, 2)} ${m.unit}</td><td class="num muted">${fmt(x.sector_median, 2)} ${m.unit}</td><td class="num">${scorePill(x.score)}</td></tr>`; }).join("")).join("")}</tbody></table></div>
    </section>
    ${d.summary ? `<section class="card"><h2>Activité</h2><p class="muted summary">${esc(d.summary)}${d.summary.length >= 900 ? "…" : ""}</p>${d.website ? `<a href="${esc(d.website)}" target="_blank" rel="noopener">${esc(d.website)}</a>` : ""}</section>` : ""}`;
  document.getElementById("add-pool").addEventListener("change", (e) => Pool.toggle(d.ticker, e.target.checked));
  chart("c-price").setOption({
    grid: { left: 54, right: 16, top: 16, bottom: 40 }, tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v, 2) + " " + cur },
    xAxis: { type: "time", splitLine: { show: false } },
    yAxis: { type: "value", scale: true, splitLine: { lineStyle: { color: "#eef0f3" } } }, dataZoom: [{ type: "inside" }],
    series: [{ type: "line", data: d.prices.dates.map((x, k) => [x, d.prices.close[k]]), symbol: "none", lineStyle: { width: 2, color: "#1f4e8c" }, areaStyle: { color: "rgba(31,78,140,.07)" } }],
  });
  chart("c-fams").setOption({
    radar: { indicator: fams.map((f) => ({ name: f.label, max: 100 })), radius: "65%", splitArea: { show: false } },
    series: [{ type: "radar", data: [{ value: fams.map((f) => d.families[f.id] ?? 0), name: d.name, areaStyle: { color: "rgba(31,78,140,.18)" }, lineStyle: { color: "#1f4e8c" }, itemStyle: { color: "#1f4e8c" },
      label: { show: true, formatter: (p) => fmt(p.value, 0) } }] }],
  });
}

/* =====================================================================
   POOLS (rapport comparatif complet à l'étape 3)
   ===================================================================== */
function pagePools(app) {
  const rows = (S.companies?.companies || []).filter((c) => Pool.items.has(c.t));
  const fams = S.companies?.families || [];
  app.innerHTML = `<section class="card"><div class="card-head"><h2>Ma sélection (${rows.length})</h2>${rows.length ? '<button class="btn ghost" id="pool-clear-2">Vider la sélection</button>' : ""}</div>
    ${rows.length ? `<p class="hint">Le rapport comparatif complet (courbes superposées, comparaison des critères, score du pool) arrive à l'étape 3.</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Entreprise</th><th>Secteur</th><th class="num">Score</th>${fams.map((f) => `<th class="num">${f.label}</th>`).join("")}<th class="num">Perf. 1 an</th><th></th></tr></thead><tbody>
      ${rows.sort((a, b) => (b.sc ?? 0) - (a.sc ?? 0)).map((c) => `<tr><td><a href="#/entreprise/${encodeURIComponent(c.t)}"><b>${esc(c.n)}</b></a></td><td class="muted">${sectorLabel(c.s)}</td><td class="num">${scorePill(c.sc)}</td>
        ${fams.map((f) => `<td class="num fam" style="color:${scoreColor(c["f_" + f.id])}">${fmt(c["f_" + f.id], 0)}</td>`).join("")}<td class="num ${pctCls(c.p1y)}">${signed(c.p1y)} %</td>
        <td><button class="btn ghost small" data-t="${esc(c.t)}">Retirer</button></td></tr>`).join("")}</tbody></table></div>
      <p class="pool-avg">Score moyen de la sélection : <b>${fmt(rows.reduce((s, c) => s + (c.sc ?? 0), 0) / rows.length)}</b></p>`
    : '<p class="hint">Aucune entreprise sélectionnée. Cochez des entreprises dans la <a href="#/entreprises">liste</a> ou dans une page secteur.</p>'}</section>`;
  document.getElementById("pool-clear-2")?.addEventListener("click", () => Pool.clear());
  app.querySelectorAll("button[data-t]").forEach((b) => b.addEventListener("click", () => { Pool.toggle(b.dataset.t, false); route(); }));
}

/* =====================================================================
   BAROMÈTRE MACRO (page détaillée)
   ===================================================================== */
function viewIndicators() {
  const zones = { commun: ["US", "EZ", "MONDE"], US: ["US", "MONDE"], EZ: ["EZ", "MONDE"] }[S.view];
  return S.macro.indicators.filter((i) => zones.includes(i.zone));
}

function pageMacro(app) {
  app.innerHTML = `
    <section class="hero">
      <div class="card hero-score"><div class="label">Score du baromètre</div><div id="gauge" class="gauge"></div><div class="signal" id="signal"></div><div class="deltas" id="deltas"></div></div>
      <div class="pillars" id="pillars"></div>
    </section>
    <section class="card"><div class="card-head"><h2>Historique du score</h2>
      <label class="check"><input type="checkbox" id="show-pillars"> Afficher les piliers</label>
      <label class="check"><input type="checkbox" id="show-z"> Comparer au Z-score</label></div>
      <div id="history" class="chart chart-lg"></div></section>
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Ce qui pèse dans le score aujourd'hui</h2></div>
        <p class="hint">Barre pleine : points apportés au score. Barre claire : poids maximal de l'indicateur.</p><div id="contrib" class="chart chart-contrib"></div></div>
      <div class="card"><div class="card-head"><h2 id="detail-title">Détail d'un indicateur</h2></div>
        <p class="hint" id="detail-hint">Cliquez sur un indicateur dans le tableau ci-dessous.</p><div id="detail" class="chart chart-md"></div></div>
    </section>
    <section class="card"><div class="card-head"><h2>Les indicateurs</h2></div>
      <div class="table-wrap"><table class="table" id="ind-table"><thead><tr><th>Indicateur</th><th>Zone</th><th>Pilier</th><th class="num">Valeur</th>
        <th class="num">Score /100</th><th class="num">Poids réel</th><th>Source</th></tr></thead><tbody></tbody></table></div></section>
    <section class="card method"><h2>Méthode</h2>
      <p>Chaque indicateur est ramené sur une échelle de 0 à 100 par la méthode Min-Max, sur son historique depuis 2005 (les 2 % de valeurs les plus extrêmes sont écrêtées).
      Les indicateurs de risque (VIX, spreads, chômage, pétrole, incertitude) sont inversés ; l'inflation est notée selon son écart à la cible de 2 %.
      Les indicateurs sont moyennés par pilier, puis les piliers selon la grille 30 % croissance, 20 % inflation, 30 % marchés, 20 % risque.
      Un score élevé signale une économie en bonne santé et un risque faible.</p></section>`;
  document.getElementById("show-pillars").addEventListener("change", renderHistory);
  document.getElementById("show-z").addEventListener("change", renderHistory);
  renderGauge(); renderPillars(); renderHistory(); renderContrib(); renderTable();
  const inds = viewIndicators();
  if (!S.selected || !inds.find((i) => i.id === S.selected)) S.selected = inds[0].id;
  renderDetail();
}

function renderGauge() {
  const L = S.macro.views[S.view].latest;
  chart("gauge").setOption({ series: [{
    type: "gauge", startAngle: 210, endAngle: -30, min: 0, max: 100, radius: "100%", center: ["50%", "62%"],
    axisLine: { lineStyle: { width: 16, color: [[0.3, "#c0392b"], [0.45, "#c27c0e"], [0.55, "#b9bec6"], [0.7, "#5fae7e"], [1, "#1f8a5b"]] } },
    pointer: { length: "58%", width: 5, itemStyle: { color: "#16202e" } }, axisTick: { show: false }, splitLine: { show: false },
    axisLabel: { distance: -38, fontSize: 11, color: "#5d6878", formatter: (v) => (v % 25 === 0 ? v : "") },
    detail: { valueAnimation: true, offsetCenter: [0, "38%"], fontSize: 38, fontWeight: 700, color: "#16202e", formatter: (v) => fmt(v) },
    data: [{ value: L.score }] }] });
  const sig = document.getElementById("signal");
  sig.textContent = L.signal.label; sig.style.color = scoreColor(L.score);
  const d = (label, x) => `<span>${label} <b class="${pctCls(x)}">${signed(x)}</b></span>`;
  document.getElementById("deltas").innerHTML = d("1 mois", L.delta_1m) + d("3 mois", L.delta_3m) + d("12 mois", L.delta_12m);
}

function renderPillars() {
  const V = S.macro.views[S.view];
  document.getElementById("pillars").innerHTML = S.macro.pillars.map((p) => {
    const s = V.latest.pillars[p.id];
    return `<div class="card pillar"><div class="pillar-top"><span class="pillar-name">${p.label}</span><span class="pillar-weight">${p.weight} % du score</span></div>
      <div class="pillar-score" style="color:${scoreColor(s)}">${fmt(s)}<small> / 100</small></div>
      <div class="bar"><span style="width:${s ?? 0}%;background:${scoreColor(s)}"></span></div><div class="spark" id="pspark-${p.id}"></div></div>`;
  }).join("");
  S.macro.pillars.forEach((p) => chart("pspark-" + p.id).setOption({
    grid: { left: 0, right: 0, top: 4, bottom: 0 }, xAxis: { type: "category", show: false, data: S.macro.dates.slice(-36) },
    yAxis: { type: "value", show: false, min: 0, max: 100 },
    tooltip: { trigger: "axis", formatter: (a) => `${monthLabel(a[0].axisValue)} : <b>${fmt(a[0].value)}</b>` },
    series: [{ type: "line", data: V.history.pillars[p.id].slice(-36), symbol: "none", smooth: true, lineStyle: { width: 1.5, color: "#1f4e8c" }, areaStyle: { color: "rgba(31,78,140,.08)" } }],
  }));
}

function renderHistory() {
  const V = S.macro.views[S.view];
  const colors = ["#2a9d8f", "#e76f51", "#6c5ce7", "#c27c0e"];
  const series = [{ name: "Score", type: "line", data: V.history.score, symbol: "none", lineStyle: { width: 2.5, color: "#1f4e8c" }, itemStyle: { color: "#1f4e8c" },
    markArea: { silent: true, itemStyle: { color: "rgba(192,57,43,.07)" }, label: { color: "#8b3a30", fontSize: 11, position: "insideTop" }, data: CRISES.map(([a, b, n]) => [{ name: n, xAxis: a }, { xAxis: b }]) },
    markLine: { silent: true, symbol: "none", lineStyle: { color: "#b9bec6", type: "dashed" }, label: { show: false }, data: [{ yAxis: 50 }] } }];
  if (document.getElementById("show-z").checked) series.push({ name: "Score (Z-score)", type: "line", data: V.history.score_z, symbol: "none", lineStyle: { width: 1.5, type: "dashed", color: "#16202e" }, itemStyle: { color: "#16202e" } });
  if (document.getElementById("show-pillars").checked) S.macro.pillars.forEach((p, k) => series.push({ name: p.label, type: "line", data: V.history.pillars[p.id], symbol: "none", lineStyle: { width: 1.2, color: colors[k] }, itemStyle: { color: colors[k] } }));
  chart("history").setOption({ grid: { left: 40, right: 16, top: 30, bottom: 50 }, legend: { top: 0, icon: "roundRect", itemHeight: 4 },
    tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v) }, xAxis: { type: "category", data: S.macro.dates, axisLabel: { formatter: (v) => v.slice(0, 4) } },
    yAxis: { type: "value", min: 0, max: 100, splitLine: { lineStyle: { color: "#eef0f3" } } }, dataZoom: [{ type: "slider", height: 18, bottom: 8 }, { type: "inside" }], series }, true);
}

function indLabel(i) {
  const zone = i.zone === "MONDE" ? "" : ` (${i.zone === "US" ? "US" : "ZE"})`;
  return i.name.replace(", écart à 2 %", "").replace(" : écart à la moyenne 200 jours", "").replace("Pente de la courbe 10 ans – 2 ans", "Pente des taux 10 ans – 2 ans").replace("Indicateur avancé OCDE (CLI)", "Indicateur avancé OCDE") + zone;
}

function renderContrib() {
  const C = S.macro.views[S.view].latest.contributions;
  const inds = viewIndicators().filter((i) => C[i.id]).sort((a, b) => C[a.id].eff_weight - C[b.id].eff_weight);
  chart("contrib").setOption({ grid: { left: 210, right: 40, top: 8, bottom: 20 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (a) => `${a[0].name}<br>Apporte <b>${fmt(a[1].value)}</b> pt sur ${fmt(a[0].value)} possibles` },
    xAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f3" } } }, yAxis: { type: "category", data: inds.map(indLabel), axisLabel: { fontSize: 12, width: 200, overflow: "truncate" } },
    series: [{ type: "bar", data: inds.map((i) => C[i.id].eff_weight), barWidth: 14, itemStyle: { color: "#e6eef8", borderRadius: 3 } },
      { type: "bar", data: inds.map((i) => ({ value: C[i.id].points, itemStyle: { color: scoreColor(i.latest.score) } })), barWidth: 14, barGap: "-100%", itemStyle: { borderRadius: 3 },
        label: { show: true, position: "right", fontSize: 11, color: "#5d6878", formatter: (p) => fmt(p.value) } }] }, true);
}

function renderTable() {
  const C = S.macro.views[S.view].latest.contributions;
  const pl = Object.fromEntries(S.macro.pillars.map((p) => [p.id, p.label]));
  const tb = document.querySelector("#ind-table tbody");
  tb.innerHTML = viewIndicators().map((i) => {
    const warn = i.status === "cache" ? '<div class="warn">version précédente conservée</div>' : i.status === "stale" ? `<div class="warn">dernière donnée : ${i.last_obs}</div>` : i.status === "missing" ? '<div class="warn">indisponible</div>' : "";
    return `<tr data-id="${i.id}" class="clickable ${i.id === S.selected ? "sel" : ""}"><td>${i.name}${warn}</td><td><span class="pill">${ZONE_LABEL[i.zone]}</span></td><td>${pl[i.pillar]}</td>
      <td class="num">${fmt(i.latest.raw, 2)} <span class="src">${i.unit}</span></td><td class="num">${scorePill(i.latest.score)}</td>
      <td class="num">${C[i.id] ? fmt(C[i.id].eff_weight) + " %" : "–"}</td><td class="src">${esc(i.source)}</td></tr>`;
  }).join("");
  tb.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => { S.selected = tr.dataset.id; tb.querySelectorAll("tr").forEach((x) => x.classList.toggle("sel", x === tr)); renderDetail(); }));
}

function renderDetail() {
  const i = S.macro.indicators.find((x) => x.id === S.selected);
  document.getElementById("detail-title").textContent = indLabel(i);
  const how = { minmax: "plus c'est haut, mieux c'est", minmax_inverse: "indicateur de risque : plus c'est haut, plus le score baisse", target: `noté selon l'écart à la cible de ${fmt(i.target, 0)} %` }[i.method];
  document.getElementById("detail-hint").textContent = `Valeur brute (${i.unit}) et score sur 100 : ${how}.`;
  chart("detail").setOption({ grid: { left: 48, right: 40, top: 30, bottom: 30 }, legend: { top: 0, icon: "roundRect", itemHeight: 4 },
    tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v, 2) }, xAxis: { type: "category", data: S.macro.dates, axisLabel: { formatter: (v) => v.slice(0, 4) } },
    yAxis: [{ type: "value", name: i.unit, scale: true, splitLine: { lineStyle: { color: "#eef0f3" } } }, { type: "value", name: "score", min: 0, max: 100, splitLine: { show: false } }],
    series: [{ name: "Valeur brute", type: "line", data: i.history.raw, symbol: "none", lineStyle: { width: 2, color: "#1f4e8c" }, itemStyle: { color: "#1f4e8c" } },
      { name: "Score /100", type: "line", yAxisIndex: 1, data: i.history.score, symbol: "none", lineStyle: { width: 1.2, color: "#c27c0e", type: "dashed" }, itemStyle: { color: "#c27c0e" } }] }, true);
}

document.addEventListener("DOMContentLoaded", () => (window.echarts ? init() : window.addEventListener("load", init)));
