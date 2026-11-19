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
/* nom court pour les graphiques et tableaux comparatifs */
function shortName(n) {
  let x = String(n || "").split(" - ")[0].replace(/,?\s*(Société Européenne|Société en commandite par actions|Société anonyme|S\.p\.A\.|S\.A\.|SA|SE|S\.E\.|N\.V\.|NV|AG|plc|PLC|Inc\.?|Corporation|Corp\.?|Company|Co\.|Ltd\.?|Holding(s)?|Group|Aktiengesellschaft|Oyj|ASA)(?=$|[\s,])/g, "").replace(/^The\s+/, "").replace(/\s{2,}/g, " ").trim();
  x = x.replace(/[,\-–\s]+$/, "");
  return x.length > 26 ? x.slice(0, 25).trim() + "…" : x || n;
}
/* valeur + unité, ou un simple tiret si la donnée manque */
const fu = (x, d, unit) => (x == null || Number.isNaN(x) ? "–" : fmt(x, d) + (unit ? " " + unit : ""));
const sp = (x, d = 1) => (x == null ? "–" : signed(x, d) + " %");
const pctCls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeName = (t) => t.replace(/[^A-Za-z0-9]/g, "_");
const scorePill = (s) => `<span class="score-pill" style="background:${scoreColor(s)}">${fmt(s, 0)}</span>`;
/* score d'une entreprise de la liste : n.d. si données insuffisantes, * si des critères manquants ont reçu une note neutre */
function companyScore(c) {
  if (c.sc == null) return `<span class="score-pill na" title="Données insuffisantes : plus de 3 critères manquants">n.d.</span>`;
  const notes = [c.miss ? `${c.miss} critère${c.miss > 1 ? "s" : ""} manquant${c.miss > 1 ? "s" : ""} : note neutre de 50 appliquée` : "", c.loss ? "entreprise en perte : PER noté 0" : ""].filter(Boolean).join(" · ");
  return scorePill(c.sc) + (notes ? `<sup class="flag" title="${notes}">${c.miss ? "*" : "†"}</sup>` : "");
}
const STATUS_LABEL = { manquant: "manquant → 50", perte: "en perte → 0", "non applicable": "non applicable", "fonds propres négatifs": "fonds propres négatifs" };
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

/* ---------- bouton « Mettre à jour » (fonction Vercel /api/mise-a-jour) ---------- */
const Updater = {
  api: "/api/mise-a-jour", timer: null,
  async init() {
    let st;
    try { const r = await fetch(this.api, { cache: "no-store" }); if (!r.ok) return; st = await r.json(); } catch { return; }
    const btn = document.getElementById("update-btn");
    btn.hidden = false;
    const dlg = document.getElementById("update-dialog");
    btn.addEventListener("click", () => { document.getElementById("update-error").textContent = ""; dlg.showModal(); document.getElementById("update-code").focus(); });
    document.getElementById("update-cancel").addEventListener("click", () => dlg.close());
    document.getElementById("update-form").addEventListener("submit", (e) => { e.preventDefault(); this.launch(); });
    if (!st.configured) btn.title = "Le bouton doit encore être configuré dans Vercel";
    if (st.run && st.run.status !== "completed") this.watch(st.run);
  },
  async launch() {
    const go = document.getElementById("update-go"), err = document.getElementById("update-error");
    go.disabled = true; err.textContent = "";
    try {
      const r = await fetch(this.api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: document.getElementById("update-code").value }) });
      const res = await r.json();
      if (!r.ok) { err.textContent = res.error || "Erreur"; if (r.status === 409 && res.run) { document.getElementById("update-dialog").close(); this.watch(res.run); } return; }
      document.getElementById("update-dialog").close();
      document.getElementById("update-code").value = "";
      this.watch({ status: "queued", created_at: new Date().toISOString() });
    } catch { err.textContent = "Impossible de joindre le serveur."; } finally { go.disabled = false; }
  },
  show(html) { const b = document.getElementById("update-status"); b.hidden = !html; b.innerHTML = html || ""; },
  watch(run) {
    const btn = document.getElementById("update-btn");
    btn.disabled = true;
    const startedAt = Date.parse(run.created_at), before = S.sectors?.updated || S.macro?.updated;
    const tick = async () => {
      const min = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
      this.show(`⟳ Mise à jour des données en cours depuis ${min} min (environ 20 min au total). Vous pouvez continuer à naviguer.`);
      let st; try { st = await (await fetch(this.api, { cache: "no-store" })).json(); } catch { return; }
      const r = st.run;
      if (!r || r.status !== "completed" || Date.parse(r.created_at) < startedAt - 120000) return;
      clearInterval(this.timer);
      if (r.conclusion !== "success") { this.show(`La mise à jour a échoué. <a href="${r.url}" target="_blank" rel="noopener">Voir le détail sur GitHub</a>.`); btn.disabled = false; return; }
      this.show("Collecte terminée : publication des nouvelles données sur le site…");
      for (let k = 0; k < 20; k++) {           // Vercel republie le site en moins d'une minute en général
        await new Promise((ok) => setTimeout(ok, 15000));
        try { const s2 = await getJSON("data/sectors.json"); if (s2.updated !== before) { location.reload(); return; } } catch { /* on réessaie */ }
      }
      this.show("Collecte terminée. Rechargez la page pour voir les nouvelles données."); btn.disabled = false;
    };
    tick(); this.timer = setInterval(tick, 20000);
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
  try { S.analyse = await getJSON("data/analyse.json"); } catch { S.analyse = null; }
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
  Updater.init();
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
        <div class="trend ${M.trend?.tone || ""}">Tendance 3 mois : <b>${M.trend?.label || "–"}</b> (${signed(M.delta_3m)})</div>
        <div class="deltas"><span>12 mois <b class="${pctCls(M.delta_12m)}">${signed(M.delta_12m)}</b></span><span>1 mois <b class="${pctCls(M.delta_1m)}">${signed(M.delta_1m)}</b></span></div>
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
      <p class="hint">Score = ${fmt(S.sectors.method.company_weight * 100, 0)} % note des entreprises (critères comparés à tout l'univers) + ${fmt(S.sectors.method.trend_weight * 100, 0)} % tendance de marché + ajustement selon le baromètre macro (cycliques favorisés quand le macro est au-dessus de 50, défensifs sinon).</p>
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
  const trendTxt = M.trend ? ` Sur 3 mois, il est <b>${M.trend.label.toLowerCase()}</b> (${signed(M.delta_3m)} points) : d'après nos tests depuis 2005, c'est cette tendance, plus que le niveau, qui accompagne la suite des marchés.` : "";
  return `<p>Le baromètre macro est à <b>${fmt(M.score)}</b> (${M.signal.label.toLowerCase()}), ${M.delta_12m < 0 ? "en recul" : "en hausse"} de ${fmt(Math.abs(M.delta_12m))} points sur un an.${trendTxt} Ce contexte ${tilt}.</p>
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
      ${kpi("PER médian", fu(s.pe_median, 1, "x"))}
      ${kpi("Rendement moyen du dividende", fmt(s.div_yield_avg, 2) + " %")}
    </section>
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Indice du secteur sur 5 ans</h2></div>
        <p class="hint">Moyenne équipondérée des cours des entreprises du secteur, base 100.</p><div id="sector-index" class="chart chart-md"></div></div>
      <div class="card"><div class="card-head"><h2>Les 4 familles de critères</h2></div>
        <p class="hint">Moyenne pondérée par la capitalisation. Notes sur 100 face à l'ensemble des entreprises analysées, pour comparer les secteurs entre eux.</p><div id="sector-fams" class="chart chart-md"></div></div>
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

function familyGuide() {
  const fams = S.companies?.families || [];
  return `<section class="fam-guide">${fams.map((f, k) => `<div class="card fam-card"><div class="fam-name"><i style="background:${["#1f4e8c", "#2a9d8f", "#c27c0e", "#6c5ce7"][k]}"></i>${f.label} · ${f.weight} points</div><p>${esc(f.description || "")}</p></div>`).join("")}</section>`;
}

function kpi(label, value, cls = "", sub = "") { return `<div class="card kpi"><div class="label">${label}</div><div class="kpi-value ${cls}">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`; }

/* =====================================================================
   LISTE DES ENTREPRISES (page globale et page secteur)
   ===================================================================== */
const SIZE_BUCKETS = [["", "Toutes tailles"], ["200-", "Plus de 200 Md$"], ["50-200", "50 à 200 Md$"], ["10-50", "10 à 50 Md$"], ["0-10", "Moins de 10 Md$"]];

function pageCompanies(app) {
  if (!S.companies) { app.innerHTML = '<div class="card">Les données des entreprises arriveront après la prochaine collecte.</div>'; return; }
  app.innerHTML = `<section class="card"><div class="card-head"><h2>Toutes les entreprises, classées par score</h2></div>
    <p class="hint">Chaque critère est noté par rapport aux entreprises du même secteur. Cochez des entreprises pour les comparer dans un pool.<br>
    <b>*</b> critère(s) manquant(s) remplacé(s) par une note neutre de 50 · <b>†</b> entreprise en perte (PER noté 0) · <b>n.d.</b> plus de 3 critères manquants : pas de score.</p>
    <div id="table"></div></section>${familyGuide()}`;
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
      <td class="num nowrap">${companyScore(c)}</td>
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
   OUTILS DE COMPARAISON (fiche et pools)
   ===================================================================== */
const PERIODS = [["1a", 52, "1 an"], ["3a", 156, "3 ans"], ["5a", 400, "5 ans"]];
const PALETTE = ["#1f4e8c", "#e76f51", "#2a9d8f", "#c27c0e", "#6c5ce7", "#d63384", "#3d8bfd", "#8a6d3b", "#20c997", "#6f42c1", "#fd7e14", "#495057"];
const RECO = { strong_buy: "Achat fort", buy: "Achat", hold: "Conserver", underperform: "Sous-performance", sell: "Vente", outperform: "Surperformance", none: "–" };

/* Aligne des séries hebdomadaires sur une liste de dates et les rebase à 100 au début de la période. */
function rebase(dates, values, start) {
  const out = []; let base = null;
  for (let k = 0; k < dates.length; k++) {
    if (dates[k] < start) continue;
    const v = values[k];
    if (v == null) { out.push([dates[k], null]); continue; }
    if (base == null) base = v;
    out.push([dates[k], +(v / base * 100).toFixed(2)]);
  }
  return out;
}
function seriesByDate(dates, values) { const m = new Map(); dates.forEach((d, k) => m.set(d, values[k])); return m; }
function startDate(weeks) { const d = new Date(); d.setDate(d.getDate() - weeks * 7); return d.toISOString().slice(0, 10); }
function periodButtons(id, cur) {
  return `<div class="segmented small" id="${id}">${PERIODS.map(([k, , l]) => `<button data-p="${k}" class="${k === cur ? "on" : ""}">${l}</button>`).join("")}</div>`;
}
function bindPeriod(id, onChange) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b)); onChange(b.dataset.p);
  }));
}
const weeksOf = (p) => PERIODS.find((x) => x[0] === p)[1];
async function loadDetails(tickers) {
  return Promise.all(tickers.map(async (t) => { try { return (S.detailCache[t] ||= await getJSON(`data/companies/${safeName(t)}.json`)); } catch { return null; } }));
}
function sectorAverage(sectorId) {
  return S.sectors?.views.commun.sectors.find((x) => x.id === sectorId);
}
/* Concurrents : même sous-industrie d'abord, puis même secteur, taille la plus proche. */
function peersOf(d, n = 6) {
  const all = S.companies.companies.filter((c) => c.t !== d.ticker && c.s === d.sector && c.sc != null);
  const cap = (d.cap_usd || 0) / 1e9;
  const dist = (c) => (c.i === d.industry ? 0 : 1000) + Math.abs(Math.log((c.cap || 0.1) / (cap || 0.1)));
  return all.sort((a, b) => dist(a) - dist(b)).slice(0, n);
}
function weeklyReturns(closes) {
  const r = []; for (let k = 1; k < closes.length; k++) r.push(closes[k] != null && closes[k - 1] != null ? closes[k] / closes[k - 1] - 1 : null); return r;
}
function std(xs) { const v = xs.filter((x) => x != null); if (v.length < 3) return null; const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); }
function corr(a, b) {
  const p = a.map((x, k) => [x, b[k]]).filter(([x, y]) => x != null && y != null);
  if (p.length < 10) return null;
  const mx = p.reduce((s, [x]) => s + x, 0) / p.length, my = p.reduce((s, [, y]) => s + y, 0) / p.length;
  let sxy = 0, sx = 0, sy = 0; p.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sx += (x - mx) ** 2; sy += (y - my) ** 2; });
  return sx && sy ? sxy / Math.sqrt(sx * sy) : null;
}

/* =====================================================================
   FICHE ENTREPRISE
   ===================================================================== */
async function pageCompany(app, ticker) {
  app.innerHTML = '<div class="card">Chargement…</div>';
  const [d] = await loadDetails([ticker]);
  if (!d) { app.innerHTML = '<div class="card">Entreprise introuvable. <a href="#/entreprises">Retour</a></div>'; return; }
  const fams = S.companies.families;
  const cur = d.currency === "EUR" ? "€" : d.currency === "USD" ? "$" : d.currency;
  const upside = d.target_price && d.price ? (d.target_price / d.price - 1) * 100 : null;
  const sec = sectorAverage(d.sector);
  const bench = S.sectors?.benchmarks?.[d.zone];
  const peers = peersOf(d);
  app.innerHTML = `
    <a class="back" href="#/secteur/${encodeURIComponent(d.sector)}">← ${d.sector_label}</a>
    <section class="sector-head card">
      <div>
        <div class="label">${esc(d.ticker)} · ${esc(d.country)} · ${esc(d.industry)}</div>
        <h1>${esc(d.long_name || d.name)}</h1>
        <div class="decomp"><span>Rang dans le secteur <b>${d.rank_sector ?? "–"}</b> / ${d.sector_size}</span>
          <label class="check"><input type="checkbox" id="add-pool" ${Pool.items.has(d.ticker) ? "checked" : ""}> Ajouter au pool</label>
          <button class="btn ghost small" id="cmp-peers">Comparer avec ses concurrents</button></div>
      </div>
      <div class="big-score" style="color:${scoreColor(d.score)}">${d.score == null ? "n.d." : fmt(d.score)}<small>/100</small></div>
    </section>
    ${d.score == null ? `<div class="banner">Score non calculé : ${d.n_missing} critères sur 13 sont manquants chez Yahoo Finance (entreprise récemment cotée ou données incomplètes). Les critères disponibles restent affichés.</div>`
      : d.n_missing || d.loss ? `<div class="banner info">${d.n_missing ? `${d.n_missing} critère${d.n_missing > 1 ? "s" : ""} manquant${d.n_missing > 1 ? "s" : ""} : note neutre de 50 appliquée, pour ne pas avantager ni pénaliser l'entreprise. ` : ""}${d.loss ? "L'entreprise est en perte : son PER n'existe pas et reçoit la note 0." : ""}</div>` : ""}
    <section class="kpis">
      ${kpi("Cours", fmt(d.price, 2) + " " + cur)}
      ${kpi("Capitalisation", capLabel(d.cap_usd / 1e9))}
      ${kpi("Performance 1 an", signed(d.perf.perf_1y) + " %", pctCls(d.perf.perf_1y))}
      ${kpi("Depuis le 1er janvier", signed(d.perf.perf_ytd) + " %", pctCls(d.perf.perf_ytd))}
      ${kpi("PER", d.loss && d.metrics.pe.value == null ? "en perte" : fu(d.metrics.pe.value, 1, "x"), "", `secteur ${fu(d.metrics.pe.sector_median, 1, "x")}`)}
      ${kpi("Dividende", fu(d.metrics.div_yield.value, 2, "%"), "", `secteur ${fu(d.metrics.div_yield.sector_median, 2, "%")}`)}
    </section>
    <section class="kpis">
      ${kpi("Objectif moyen des analystes", d.target_price ? fmt(d.target_price, 2) + " " + cur : "–", "", upside != null ? `<span class="${pctCls(upside)}">${signed(upside)} % de potentiel</span>` : "")}
      ${kpi("Recommandation des analystes", RECO[d.recommendation] || "–")}
      ${kpi("PER prévisionnel", fu(d.forward_pe, 1, "x"))}
      ${kpi("VE / EBITDA", fu(d.ev_ebitda, 1, "x"))}
      ${kpi("Marge nette", fu(d.net_margin, 1, "%"))}
      ${kpi("Salariés", d.employees ? Number(d.employees).toLocaleString("fr-FR") : "–")}
    </section>
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Performance comparée</h2>${periodButtons("c-period", "1a")}</div>
        <p class="hint">Base 100 au début de la période : l'entreprise, son secteur et ${bench ? bench.name : "le marché"}.</p><div id="c-perf" class="chart chart-md"></div></div>
      <div class="card"><div class="card-head"><h2>Profil face au secteur</h2></div>
        <p class="hint">Notes sur 100 par famille : l'entreprise et la moyenne de son secteur.</p><div id="c-fams" class="chart chart-md"></div></div>
    </section>
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Position dans le secteur</h2></div>
        <p class="hint">Chaque point est une entreprise du secteur ${esc(d.sector_label)}, placée selon son score et sa capitalisation.</p><div id="c-pos" class="chart chart-md"></div></div>
      <div class="card"><div class="card-head"><h2>Critères face à la médiane du secteur</h2></div>
        <p class="hint">Note sur 100 de chaque critère ; le trait gris marque 50, le niveau d'une entreprise médiane.</p><div id="c-metrics" class="chart chart-md"></div></div>
    </section>
    <section class="card"><div class="card-head"><h2>Détail des critères</h2></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Famille</th><th>Critère</th><th class="num">Valeur</th><th class="num">Médiane du secteur</th><th class="num">Note /100</th></tr></thead>
      <tbody>${fams.map((f) => f.metrics.map((m, k) => { const x = d.metrics[m.id] || {}; return `<tr>
        <td>${k === 0 ? `<b>${f.label}</b> ${scorePill(d.families[f.id])}` : ""}</td><td>${m.label}${m.direction === "bas" ? ' <span class="src">(plus bas = mieux)</span>' : ""}</td>
        <td class="num">${x.status && x.status !== "ok" ? `<span class="status">${STATUS_LABEL[x.status] || x.status}</span>` : fu(x.value, 2, m.unit)}</td><td class="num muted">${fu(x.sector_median, 2, m.unit)}</td><td class="num">${x.status === "non applicable" || x.status === "fonds propres négatifs" ? "–" : scorePill(x.score)}</td></tr>`; }).join("")).join("")}</tbody></table></div>
    </section>
    ${familyGuide()}
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Concurrents les plus proches</h2></div>
        <p class="hint">Même sous-industrie en priorité, puis même secteur, taille comparable.</p>
        <div class="table-wrap"><table class="table"><thead><tr><th>Entreprise</th><th>Pays</th><th class="num">Capi.</th><th class="num">Score</th><th class="num">Perf. 1 an</th></tr></thead><tbody>
        <tr class="sel"><td><b>${esc(d.name)}</b></td><td class="muted">${esc(d.country)}</td><td class="num">${capLabel(d.cap_usd / 1e9)}</td><td class="num">${scorePill(d.score)}</td><td class="num ${pctCls(d.perf.perf_1y)}">${signed(d.perf.perf_1y)} %</td></tr>
        ${peers.map((c) => `<tr><td><a href="#/entreprise/${encodeURIComponent(c.t)}">${esc(c.n)}</a><div class="src">${esc(c.i)}</div></td><td class="muted">${esc(c.c)}</td><td class="num">${capLabel(c.cap)}</td><td class="num">${scorePill(c.sc)}</td><td class="num ${pctCls(c.p1y)}">${signed(c.p1y)} %</td></tr>`).join("")}
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><h2>Évolution du score</h2></div><div id="c-hist" class="chart chart-sm"></div><p class="hint" id="c-hist-note"></p>
        ${d.summary ? `<h2 class="mt">Activité</h2><p class="muted summary">${esc(d.summary)}${d.summary.length >= 900 ? "…" : ""}</p>${d.website ? `<a href="${esc(d.website)}" target="_blank" rel="noopener">${esc(d.website)}</a>` : ""}` : ""}</div>
    </section>`;

  document.getElementById("add-pool").addEventListener("change", (e) => Pool.toggle(d.ticker, e.target.checked));
  document.getElementById("cmp-peers").addEventListener("click", () => {
    Pool.items = new Set([d.ticker, ...peers.slice(0, 4).map((c) => c.t)]); Pool.save(); location.hash = "#/pools";
  });

  // Performance comparée
  const secView = S.sectors?.views[d.zone]?.sectors.find((x) => x.id === d.sector);
  const drawPerf = (p) => {
    const start = startDate(weeksOf(p));
    const series = [{ name: d.name, type: "line", symbol: "none", lineStyle: { width: 2.5, color: "#1f4e8c" }, itemStyle: { color: "#1f4e8c" }, data: rebase(d.prices.dates, d.prices.close, start) }];
    if (secView) series.push({ name: `Secteur ${d.sector_label} (${ZONE_LABEL[d.zone]})`, type: "line", symbol: "none", lineStyle: { width: 1.5, color: "#2a9d8f" }, itemStyle: { color: "#2a9d8f" }, data: rebase(S.sectors.index_dates, secView.index, start) });
    if (bench) series.push({ name: bench.name, type: "line", symbol: "none", lineStyle: { width: 1.5, color: "#8a8f98", type: "dashed" }, itemStyle: { color: "#8a8f98" }, data: rebase(S.sectors.index_dates, bench.values, start) });
    chart("c-perf").setOption({ grid: { left: 44, right: 16, top: 40, bottom: 30 }, legend: { top: 0, type: "scroll" }, tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v) },
      xAxis: { type: "time", splitLine: { show: false } }, yAxis: { type: "value", scale: true, splitLine: { lineStyle: { color: "#eef0f3" } } }, series }, true);
  };
  drawPerf("1a"); bindPeriod("c-period", drawPerf);

  // Radar entreprise vs secteur
  chart("c-fams").setOption({
    legend: { bottom: 0 }, tooltip: {},
    radar: { indicator: fams.map((f) => ({ name: f.label, max: 100 })), radius: "62%", splitArea: { show: false } },
    series: [{ type: "radar", data: [
      { value: fams.map((f) => d.families[f.id] ?? 0), name: d.name, areaStyle: { color: "rgba(31,78,140,.2)" }, lineStyle: { color: "#1f4e8c" }, itemStyle: { color: "#1f4e8c" }, label: { show: true, formatter: (p) => fmt(p.value, 0) } },
      ...(sec ? [{ value: fams.map((f) => (sec.families_in_sector || sec.families)[f.id] ?? 0), name: "Moyenne du secteur", lineStyle: { color: "#c27c0e", type: "dashed" }, itemStyle: { color: "#c27c0e" } }] : []),
    ] }],
  });

  // Position dans le secteur
  const mates = S.companies.companies.filter((c) => c.s === d.sector && c.sc != null && c.cap);
  chart("c-pos").setOption({
    grid: { left: 50, right: 20, top: 34, bottom: 44 },
    tooltip: { formatter: (p) => `${esc(p.data[2])}<br>Score ${fmt(p.data[1])} · ${capLabel(p.data[0])}` },
    xAxis: { type: "log", name: "Capitalisation (Md$, échelle log.)", nameLocation: "middle", nameGap: 28, splitLine: { show: false } },
    yAxis: { type: "value", name: "Score", min: 0, max: 100, splitLine: { lineStyle: { color: "#eef0f3" } } },
    series: [
      { type: "scatter", symbolSize: 7, itemStyle: { color: "rgba(138,143,152,.45)" }, data: mates.filter((c) => c.t !== d.ticker).map((c) => [c.cap, c.sc, c.n]) },
      { type: "scatter", symbolSize: 16, itemStyle: { color: "#1f4e8c", borderColor: "#fff", borderWidth: 2 }, data: [[d.cap_usd / 1e9, d.score, d.name]],
        label: { show: true, position: "top", formatter: () => d.name, fontWeight: 600, color: "#16202e" } },
    ],
  });

  // Critères (barres centrées sur 50)
  const ms = fams.flatMap((f) => f.metrics.map((m) => ({ ...m, fam: f.label, s: d.metrics[m.id]?.score })));
  const rev = [...ms].reverse();
  chart("c-metrics").setOption({
    grid: { left: 200, right: 30, top: 10, bottom: 20 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (a) => `${a[0].name}<br>Note ${fmt(a[0].value, 0)} / 100` },
    xAxis: { type: "value", min: 0, max: 100, splitLine: { lineStyle: { color: "#eef0f3" } } },
    yAxis: { type: "category", data: rev.map((m) => m.label), axisLabel: { fontSize: 11, width: 190, overflow: "truncate" } },
    series: [{ type: "bar", barWidth: 10, data: rev.map((m) => ({ value: m.s, itemStyle: { color: scoreColor(m.s), borderRadius: 2 } })),
      markLine: { silent: true, symbol: "none", lineStyle: { color: "#8a8f98", type: "dashed" }, label: { show: false }, data: [{ xAxis: 50 }] } }],
  });

  // Historique du score
  const h = d.score_history;
  const note = document.getElementById("c-hist-note");
  if (h && h.dates.length >= 2) {
    chart("c-hist").setOption({ grid: { left: 36, right: 16, top: 10, bottom: 24 }, tooltip: { trigger: "axis" },
      xAxis: { type: "time" }, yAxis: { type: "value", min: 0, max: 100, splitLine: { lineStyle: { color: "#eef0f3" } } },
      series: [{ type: "line", data: h.dates.map((x, k) => [x, h.score[k]]), lineStyle: { color: "#1f4e8c" }, itemStyle: { color: "#1f4e8c" } }] });
    note.textContent = "Un point par mise à jour des données.";
  } else {
    document.getElementById("c-hist").style.display = "none";
    note.textContent = `L'historique du score se construit à chaque mise à jour hebdomadaire${h ? ` (premier relevé le ${new Date(h.dates[0]).toLocaleDateString("fr-FR")} : ${fmt(h.score[0])}/100)` : ""}.`;
  }
}

/* =====================================================================
   POOLS : sélection, pools enregistrés et rapport comparatif
   ===================================================================== */
const SavedPools = {
  all() { try { return JSON.parse(localStorage.getItem("pools-saved") || "{}"); } catch { return {}; } },
  set(obj) { try { localStorage.setItem("pools-saved", JSON.stringify(obj)); } catch { /* stockage indisponible */ } },
  save(name, tickers) { const a = this.all(); a[name] = tickers; this.set(a); },
  remove(name) { const a = this.all(); delete a[name]; this.set(a); },
};

async function pagePools(app) {
  const byT = new Map((S.companies?.companies || []).map((c) => [c.t, c]));
  const rows = [...Pool.items].map((t) => byT.get(t)).filter(Boolean);
  const saved = SavedPools.all();
  app.innerHTML = `
    <section class="card pool-manager">
      <div class="card-head"><h2>Composer un pool</h2></div>
      <div class="pool-tools">
        <div class="add-box"><input type="search" id="pool-search" placeholder="Ajouter une entreprise : nom ou code…" autocomplete="off"><div class="suggest" id="pool-suggest" hidden></div></div>
        <input type="text" id="pool-name" placeholder="Nom du pool (ex. Luxe européen)">
        <button class="btn" id="pool-save" ${rows.length ? "" : "disabled"}>Enregistrer</button>
        ${rows.length ? '<button class="btn ghost" id="pool-clear-2">Vider</button>' : ""}
        <button class="btn ghost" id="pool-print" ${rows.length >= 2 ? "" : "disabled"}>Imprimer le rapport</button>
      </div>
      <div class="chips">${rows.map((c, k) => `<span class="chip"><i style="background:${PALETTE[k % PALETTE.length]}"></i>${esc(shortName(c.n))}<button data-t="${esc(c.t)}" title="Retirer">×</button></span>`).join("") || '<span class="hint">Aucune entreprise : cherchez-en une ci-dessus, ou cochez-en dans la <a href="#/entreprises">liste</a>.</span>'}</div>
      ${Object.keys(saved).length ? `<div class="saved"><span class="hint">Pools enregistrés :</span> ${Object.entries(saved).map(([n, ts]) => `<span class="chip saved-chip"><a href="#" data-load="${esc(n)}">${esc(n)} (${ts.length})</a><button data-del="${esc(n)}" title="Supprimer">×</button></span>`).join("")}</div>` : ""}
    </section>
    <div id="pool-report">${rows.length >= 2 ? '<div class="card">Préparation du rapport…</div>' : rows.length === 1 ? '<div class="card hint">Ajoutez au moins une autre entreprise pour obtenir le rapport comparatif.</div>' : ""}</div>`;

  // Gestion du pool
  const search = document.getElementById("pool-search"), sug = document.getElementById("pool-suggest");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    if (q.length < 2) { sug.hidden = true; return; }
    const hits = S.companies.companies.filter((c) => !Pool.items.has(c.t) && (c.n.toLowerCase().includes(q) || c.t.toLowerCase().startsWith(q))).slice(0, 8);
    sug.innerHTML = hits.map((c) => `<div data-t="${esc(c.t)}"><b>${esc(c.n)}</b> <span class="src">${esc(c.t)} · ${esc(sectorLabel(c.s))}</span></div>`).join("") || '<div class="src">Aucun résultat</div>';
    sug.hidden = false;
    sug.querySelectorAll("div[data-t]").forEach((el) => el.addEventListener("mousedown", () => { Pool.toggle(el.dataset.t, true); route(); }));
  });
  search.addEventListener("blur", () => setTimeout(() => (sug.hidden = true), 150));
  app.querySelectorAll(".chips button[data-t]").forEach((b) => b.addEventListener("click", () => { Pool.toggle(b.dataset.t, false); route(); }));
  document.getElementById("pool-clear-2")?.addEventListener("click", () => Pool.clear());
  document.getElementById("pool-print")?.addEventListener("click", () => window.print());
  document.getElementById("pool-save").addEventListener("click", () => {
    const name = document.getElementById("pool-name").value.trim() || `Pool du ${new Date().toLocaleDateString("fr-FR")}`;
    SavedPools.save(name, [...Pool.items]); route();
  });
  app.querySelectorAll("[data-load]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); Pool.items = new Set(saved[a.dataset.load]); Pool.save(); route(); }));
  app.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { SavedPools.remove(b.dataset.del); route(); }));

  if (rows.length >= 2) await poolReport(document.getElementById("pool-report"), rows);
}

async function poolReport(box, rows) {
  const details = await loadDetails(rows.map((c) => c.t));
  const items = rows.map((c, k) => ({ c, d: details[k], nm: shortName(c.n), color: PALETTE[k % PALETTE.length] })).filter((x) => x.d);
  const fams = S.companies.families;
  const avg = (f) => { const v = items.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const poolScore = avg((x) => x.c.sc);
  const capW = items.reduce((s, x) => s + (x.c.cap || 0), 0);
  const poolScoreCap = capW ? items.reduce((s, x) => s + (x.c.sc || 0) * (x.c.cap || 0), 0) / capW : null;
  const ranked = [...items].sort((a, b) => (b.c.sc ?? -1) - (a.c.sc ?? -1));

  // Diversification sur 1 an (rendements hebdomadaires)
  const start = startDate(52);
  const rets = items.map((x) => {
    const m = seriesByDate(x.d.prices.dates, x.d.prices.close);
    const dates = S.sectors.index_dates.filter((dt) => dt >= start);
    return weeklyReturns(dates.map((dt) => m.get(dt) ?? null));
  });
  const vols = rets.map((r) => (std(r) != null ? std(r) * Math.sqrt(52) * 100 : null));
  const poolRet = rets[0].map((_, k) => { const v = rets.map((r) => r[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });
  const poolVol = std(poolRet) != null ? std(poolRet) * Math.sqrt(52) * 100 : null;
  const okVols = vols.filter((v) => v != null);
  const avgVol = okVols.length ? okVols.reduce((a, b) => a + b, 0) / okVols.length : null;
  const C = items.map((_, i) => items.map((_, j) => (i === j ? 1 : corr(rets[i], rets[j]))));
  const offDiag = C.flatMap((r, i) => r.filter((_, j) => j > i)).filter((x) => x != null);
  const avgCorr = offDiag.length ? offDiag.reduce((a, b) => a + b, 0) / offDiag.length : null;
  const perf1y = avg((x) => x.c.p1y);

  box.innerHTML = `
    <section class="sector-head card">
      <div><div class="label">Rapport comparatif · ${items.length} entreprises · ${new Set(items.map((x) => x.c.s)).size} secteur(s)</div>
        <h1>Score du pool</h1>
        <div class="decomp"><span>Moyenne simple <b>${fmt(poolScore)}</b></span><span>Pondérée par la capitalisation <b>${fmt(poolScoreCap)}</b></span>
          <span>Meilleure note <b>${esc(ranked[0].nm)}</b></span></div></div>
      <div class="big-score" style="color:${scoreColor(poolScore)}">${fmt(poolScore)}<small>/100</small></div>
    </section>
    <section class="kpis">
      ${kpi("Performance moyenne 1 an", signed(perf1y) + " %", pctCls(perf1y))}
      ${kpi("PER moyen", fu(avg((x) => x.c.pe), 1, "x"))}
      ${kpi("Dividende moyen", fmt(avg((x) => x.c.dy), 2) + " %")}
      ${kpi("Volatilité du pool (1 an)", fmt(poolVol) + " %", "", `moyenne des titres ${fmt(avgVol)} %`)}
      ${kpi("Corrélation moyenne", fmt(avgCorr, 2), "", "entre les titres, sur 1 an")}
    </section>
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Classement interne</h2></div><p class="hint">Score sur 100 et contribution des 4 familles (25 points chacune).</p><div id="p-rank" class="chart" style="height:${items.length * 34 + 70}px"></div></div>
      <div class="card"><div class="card-head"><h2>Profils comparés</h2></div><p class="hint">Notes par famille, relatives au secteur de chaque entreprise.</p><div id="p-radar" class="chart chart-md"></div></div>
    </section>
    <section class="card"><div class="card-head"><h2>Courbes superposées</h2>${periodButtons("p-period", "1a")}</div>
      <p class="hint">Base 100 au début de la période. Trait épais noir : le pool équipondéré. Pointillés : les indices de référence.</p><div id="p-perf" class="chart chart-lg"></div></section>
    <section class="card"><div class="card-head"><h2>Comparaison des indicateurs</h2></div>
      <p class="hint">Couleur = note sur 100 du critère dans le secteur de l'entreprise ; ★ = meilleure note du pool sur la ligne.</p>
      <div class="table-wrap"><table class="table compare" id="p-table"></table></div></section>
    <section class="grid-2">
      <div class="card"><div class="card-head"><h2>Corrélations sur 1 an</h2></div><p class="hint">Rendements hebdomadaires. Plus les titres sont peu corrélés, plus le pool est diversifié.</p><div id="p-corr" class="chart" style="height:${Math.max(300, items.length * 40 + 90)}px"></div></div>
      <div class="card"><div class="card-head"><h2>Diversification</h2></div>
        <p class="diversif">${diversificationText(poolVol, avgVol, avgCorr, items)}</p>
        <div id="p-risk" class="chart chart-sm"></div></div>
    </section>`;

  // Classement interne : barres empilées par famille
  const rev = [...ranked].reverse();
  chart("p-rank").setOption({
    grid: { left: 170, right: 50, top: 30, bottom: 10 }, legend: { top: 0 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v) => fmt(v) },
    xAxis: { type: "value", max: 100, splitLine: { lineStyle: { color: "#eef0f3" } } },
    yAxis: { type: "category", data: rev.map((x) => x.nm), axisLabel: { width: 160, overflow: "truncate" } },
    series: [...fams.map((f, k) => ({ name: f.label, type: "bar", stack: "s", barWidth: 16,
      itemStyle: { color: ["#1f4e8c", "#2a9d8f", "#c27c0e", "#6c5ce7"][k] },
      data: rev.map((x) => (x.c["f_" + f.id] != null ? +(x.c["f_" + f.id] * f.weight / 100).toFixed(1) : 0)) })),
      { type: "scatter", symbolSize: 0, tooltip: { show: false }, data: rev.map((x) => x.c.sc), label: { show: true, position: "right", fontWeight: 600, formatter: (p) => fmt(p.value) } }],
  });

  // Radar superposé
  chart("p-radar").setOption({
    legend: { bottom: 0, type: "scroll" }, tooltip: {},
    radar: { indicator: fams.map((f) => ({ name: f.label, max: 100 })), radius: "60%", splitArea: { show: false } },
    series: [{ type: "radar", data: items.map((x) => ({ name: x.nm, value: fams.map((f) => x.c["f_" + f.id] ?? 0), lineStyle: { color: x.color, width: 2 }, itemStyle: { color: x.color }, areaStyle: { color: x.color, opacity: 0.06 } })) }],
  });

  // Courbes superposées
  const zones = [...new Set(items.map((x) => x.c.z))];
  const drawPerf = (p) => {
    const st = startDate(weeksOf(p));
    const curves = items.map((x) => rebase(x.d.prices.dates, x.d.prices.close, st));
    const allDates = S.sectors.index_dates.filter((dt) => dt >= st);
    const maps = curves.map((c) => new Map(c));
    const pool = allDates.map((dt) => { const v = maps.map((m) => m.get(dt)).filter((x) => x != null); return [dt, v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null]; });
    const series = items.map((x, k) => ({ name: x.nm, type: "line", symbol: "none", lineStyle: { width: 1.5, color: x.color }, itemStyle: { color: x.color }, data: curves[k] }));
    series.push({ name: "Pool équipondéré", type: "line", symbol: "none", lineStyle: { width: 3.5, color: "#16202e" }, itemStyle: { color: "#16202e" }, data: pool, z: 5 });
    zones.forEach((z) => { const b = S.sectors.benchmarks?.[z]; if (b) series.push({ name: b.name, type: "line", symbol: "none", lineStyle: { width: 1.5, type: "dashed", color: "#8a8f98" }, itemStyle: { color: "#8a8f98" }, data: rebase(S.sectors.index_dates, b.values, st) }); });
    chart("p-perf").setOption({ grid: { left: 44, right: 16, top: 50, bottom: 30 }, legend: { top: 0, type: "scroll" },
      tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v) }, xAxis: { type: "time", splitLine: { show: false } },
      yAxis: { type: "value", scale: true, splitLine: { lineStyle: { color: "#eef0f3" } } }, dataZoom: [{ type: "inside" }], series }, true);
  };
  drawPerf("1a"); bindPeriod("p-period", drawPerf);

  // Tableau comparatif
  const cell = (val, score, best) => `<td class="num" style="background:${score == null ? "transparent" : scoreColor(score) + "22"}">${val}${best ? " ★" : ""}</td>`;
  const bestIdx = (vals) => { let b = -1, bv = -Infinity; vals.forEach((v, k) => { if (v != null && v > bv) { bv = v; b = k; } }); return b; };
  const head = `<thead><tr><th>Indicateur</th>${items.map((x) => `<th class="num"><i class="dot" style="background:${x.color}"></i><a href="#/entreprise/${encodeURIComponent(x.c.t)}">${esc(x.nm)}</a></th>`).join("")}</tr></thead>`;
  const line = (label, vals, scores, fmtv) => { const b = bestIdx(scores); return `<tr><td>${label}</td>${vals.map((v, k) => cell(fmtv(v), scores[k], k === b)).join("")}</tr>`; };
  const group = (label) => `<tr class="group"><td colspan="${items.length + 1}">${label}</td></tr>`;
  let body = group("Synthèse");
  body += line("<b>Score global</b>", items.map((x) => x.c.sc), items.map((x) => x.c.sc), (v) => `<b>${fmt(v)}</b>`);
  body += `<tr><td>Secteur</td>${items.map((x) => `<td class="num muted wrap">${esc(sectorLabel(x.c.s))}</td>`).join("")}</tr>`;
  body += `<tr><td>Rang dans le secteur</td>${items.map((x) => `<td class="num">${x.d.rank_sector ?? "–"} / ${x.d.sector_size}</td>`).join("")}</tr>`;
  body += `<tr><td>Capitalisation</td>${items.map((x) => `<td class="num">${capLabel(x.c.cap)}</td>`).join("")}</tr>`;
  body += line("Performance 1 an", items.map((x) => x.c.p1y), items.map((x) => x.c.p1y), (v) => `<span class="${pctCls(v)}">${sp(v)}</span>`);
  fams.forEach((f) => {
    body += group(`${f.label} (25 points)`);
    body += line(`<b>Note ${f.label.toLowerCase()}</b>`, items.map((x) => x.c["f_" + f.id]), items.map((x) => x.c["f_" + f.id]), (v) => `<b>${fmt(v, 0)}</b>`);
    f.metrics.forEach((m) => {
      body += line(`${m.label}`, items.map((x) => x.d.metrics[m.id]?.value), items.map((x) => x.d.metrics[m.id]?.score), (v) => fu(v, m.unit === "%" ? 1 : 2, m.unit));
    });
  });
  body += group("Analystes");
  const ups = items.map((x) => (x.d.target_price && x.d.price ? (x.d.target_price / x.d.price - 1) * 100 : null));
  body += line("Potentiel vs objectif moyen", ups, ups, (v) => `<span class="${pctCls(v)}">${sp(v)}</span>`);
  body += `<tr><td>Recommandation</td>${items.map((x) => `<td class="num">${RECO[x.d.recommendation] || "–"}</td>`).join("")}</tr>`;
  document.getElementById("p-table").innerHTML = head + `<tbody>${body}</tbody>`;

  // Corrélations
  const names = items.map((x) => x.nm);
  chart("p-corr").setOption({
    grid: { left: 150, right: 20, top: 10, bottom: 80 }, tooltip: { formatter: (p) => `${esc(names[p.data[1]])} / ${esc(names[p.data[0]])} : <b>${fmt(p.data[2], 2)}</b>` },
    xAxis: { type: "category", data: names, axisLabel: { rotate: 35, width: 110, overflow: "truncate", fontSize: 11 } },
    yAxis: { type: "category", inverse: true, data: names, axisLabel: { width: 140, overflow: "truncate", fontSize: 11 } },
    visualMap: { show: false, min: -1, max: 1, inRange: { color: ["#2a9d8f", "#f5f6f8", "#c0392b"] } },
    series: [{ type: "heatmap", data: C.flatMap((r, i) => r.map((v, j) => [j, i, v == null ? null : +v.toFixed(2)])), label: { show: items.length <= 10, fontSize: 10, formatter: (p) => fmt(p.data[2], 2) } }],
  });

  // Risque / rendement
  chart("p-risk").setOption({
    grid: { left: 50, right: 20, top: 34, bottom: 40 },
    tooltip: { formatter: (p) => `${esc(p.data[2])}<br>Volatilité ${fmt(p.data[0])} % · perf. ${signed(p.data[1])} %` },
    xAxis: { type: "value", name: "Volatilité 1 an (%)", nameLocation: "middle", nameGap: 26, scale: true, splitLine: { show: false } },
    yAxis: { type: "value", name: "Perf. 1 an (%)", scale: true, splitLine: { lineStyle: { color: "#eef0f3" } } },
    series: [{ type: "scatter", symbolSize: 11, data: items.map((x, k) => ({ value: [vols[k], x.c.p1y, x.nm], itemStyle: { color: x.color } })) },
      { type: "scatter", symbol: "diamond", symbolSize: 18, itemStyle: { color: "#16202e" }, data: [[poolVol, perf1y, "Pool équipondéré"]], label: { show: true, position: "right", formatter: "Pool" } }],
  });
}

function diversificationText(poolVol, avgVol, avgCorr, items) {
  if (poolVol == null || avgVol == null) return "Pas assez d'historique commun pour mesurer la diversification.";
  const gain = (1 - poolVol / avgVol) * 100;
  const sectors = new Set(items.map((x) => x.c.s)).size, zones = new Set(items.map((x) => x.c.z)).size;
  return `Le pool équipondéré a une volatilité de <b>${fmt(poolVol)} %</b>, contre <b>${fmt(avgVol)} %</b> en moyenne pour ses titres pris un à un :
    la diversification réduit le risque de <b>${fmt(gain, 0)} %</b>. La corrélation moyenne entre les titres est de <b>${fmt(avgCorr, 2)}</b>
    (${avgCorr > 0.6 ? "élevée : les titres évoluent souvent ensemble" : avgCorr > 0.3 ? "modérée" : "faible : bonne diversification"}).
    Le pool couvre ${sectors} secteur${sectors > 1 ? "s" : ""} et ${zones} zone${zones > 1 ? "s" : ""}.`;
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
      <p>Chaque indicateur est ramené sur une échelle de 0 à 100 par la méthode Min-Max <b>en temps réel</b> : à chaque date, le minimum et le maximum ne sont calculés qu'avec les données déjà connues (les 2 % de valeurs les plus extrêmes sont écrêtées). Le score d'un mois passé est donc celui qu'on aurait obtenu à l'époque, sans connaître les crises à venir.
      Les indicateurs de risque (VIX, spreads, chômage, pétrole, incertitude) sont inversés ; l'inflation est notée selon son écart à la cible de 2 %.
      Les indicateurs sont moyennés par pilier, puis les piliers selon la grille 30 % croissance, 20 % inflation, 30 % marchés, 20 % risque.
      Un score élevé signale une économie en bonne santé et un risque faible.</p>
      ${howToUse()}</section>`;
  document.getElementById("show-pillars").addEventListener("change", renderHistory);
  document.getElementById("show-z").addEventListener("change", renderHistory);
  renderGauge(); renderPillars(); renderHistory(); renderContrib(); renderTable();
  const inds = viewIndicators();
  if (!S.selected || !inds.find((i) => i.id === S.selected)) S.selected = inds[0].id;
  renderDetail();
}

/* « Comment s'en servir ? » : chiffres lus dans data/analyse.json (scripts/analyse_decision.py) */
function howToUse() {
  const a = S.analyse?.macro?.US?.site;
  if (!a) return "";
  const bh = a.strategies.achat_conservation, s45 = a.strategies.investi_si_score_45, s55 = a.strategies.investi_si_score_55;
  return `<p><b>Comment s'en servir ?</b> Testé depuis 2005 sur le S&P 500, le baromètre est surtout un <b>filtre de risque</b>.
    N'être investi que lorsque le score dépasse 45 aurait ramené la pire baisse de ${fmt(bh.pire_baisse)} % à ${fmt(s45.pire_baisse)} %
    pour un rendement annuel équivalent (${fmt(s45.rendement_annuel)} % contre ${fmt(bh.rendement_annuel)} %) ; au-dessus de 55, la pire baisse tombe à ${fmt(s55.pire_baisse)} %.
    Le niveau du score prédit mal les hausses (corrélation ${fmt(a.correlation_score_perf12m, 2)}) ; sa <b>tendance sur 3 mois</b> est plus parlante (corrélation ${fmt(a.correlation_variation3m_perf12m, 2)}).</p>`;
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
  sig.innerHTML = `${L.signal.label}<div class="trend ${L.trend?.tone || ""}">Tendance 3 mois : <b>${L.trend?.label || "–"}</b></div>`; sig.style.color = scoreColor(L.score);
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
