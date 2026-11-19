/* Baromètre des marchés : page du baromètre macro.
   Lit data/macro.json (produit par scripts/build_macro.py) et dessine la page. */

const state = { data: null, view: "commun", selected: null, charts: {} };

const ZONE_LABEL = { US: "États-Unis", EZ: "Zone euro", MONDE: "Monde" };
const CRISES = [
  ["2008-09", "2009-06", "Crise financière"],
  ["2020-02", "2020-06", "Covid"],
  ["2022-02", "2022-10", "Choc d'inflation"],
];

function scoreColor(s) {
  if (s == null) return "#c7ccd4";
  if (s >= 70) return "#1f8a5b";
  if (s >= 55) return "#5fae7e";
  if (s >= 45) return "#8a8f98";
  if (s >= 30) return "#c27c0e";
  return "#c0392b";
}
const fmt = (x, d = 1) => (x == null ? "–" : x.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + fmt(x));
const chart = (id) => {
  if (!state.charts[id]) state.charts[id] = echarts.init(document.getElementById(id), null, { renderer: "svg" });
  return state.charts[id];
};

async function init() {
  try {
    const res = await fetch("data/macro.json", { cache: "no-store" });
    state.data = await res.json();
  } catch (e) {
    document.querySelector(".page").innerHTML =
      '<div class="banner">Impossible de charger les données (data/macro.json).</div>';
    return;
  }
  document.getElementById("demo-banner").hidden = !state.data.demo;
  const upd = new Date(state.data.updated);
  document.getElementById("updated").textContent =
    "Dernière mise à jour : " + upd.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }) +
    " · données au " + monthLabel(state.data.dates.at(-1));

  document.querySelectorAll("#zone-switch button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#zone-switch button").forEach((x) => x.classList.toggle("on", x === b));
      state.view = b.dataset.view;
      render();
    }));
  document.getElementById("show-pillars").addEventListener("change", renderHistory);
  document.getElementById("show-z").addEventListener("change", renderHistory);
  window.addEventListener("resize", () => Object.values(state.charts).forEach((c) => c.resize()));
  render();
}

function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

function viewIndicators() {
  const zones = { commun: ["US", "EZ", "MONDE"], US: ["US", "MONDE"], EZ: ["EZ", "MONDE"] }[state.view];
  return state.data.indicators.filter((i) => zones.includes(i.zone));
}

function render() {
  renderGauge();
  renderPillars();
  renderHistory();
  renderContrib();
  renderTable();
  const inds = viewIndicators();
  if (!state.selected || !inds.find((i) => i.id === state.selected)) state.selected = inds[0].id;
  renderDetail();
}

/* ---------- Jauge ---------- */
function renderGauge() {
  const L = state.data.views[state.view].latest;
  chart("gauge").setOption({
    series: [{
      type: "gauge", startAngle: 210, endAngle: -30, min: 0, max: 100, radius: "100%", center: ["50%", "62%"],
      axisLine: { lineStyle: { width: 16, color: [[0.3, "#c0392b"], [0.45, "#c27c0e"], [0.55, "#b9bec6"], [0.7, "#5fae7e"], [1, "#1f8a5b"]] } },
      pointer: { length: "58%", width: 5, itemStyle: { color: "#16202e" } },
      axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { distance: -38, fontSize: 11, color: "#5d6878", formatter: (v) => (v % 25 === 0 ? v : "") },
      detail: { valueAnimation: true, offsetCenter: [0, "38%"], fontSize: 38, fontWeight: 700, color: "#16202e", formatter: (v) => fmt(v) },
      data: [{ value: L.score }],
    }],
  });
  const sig = document.getElementById("signal");
  sig.textContent = L.signal.label;
  sig.style.color = scoreColor(L.score);
  const d = (label, x) => `<span>${label} <b class="${x > 0 ? "up" : x < 0 ? "down" : ""}">${signed(x)}</b></span>`;
  document.getElementById("deltas").innerHTML = d("1 mois", L.delta_1m) + d("3 mois", L.delta_3m) + d("12 mois", L.delta_12m);
}

/* ---------- Cartes piliers ---------- */
function renderPillars() {
  const V = state.data.views[state.view];
  const box = document.getElementById("pillars");
  box.innerHTML = state.data.pillars.map((p) => {
    const s = V.latest.pillars[p.id];
    return `<div class="card pillar">
      <div class="pillar-top"><span class="pillar-name">${p.label}</span><span class="pillar-weight">${p.weight} % du score</span></div>
      <div class="pillar-score" style="color:${scoreColor(s)}">${fmt(s)}<small> / 100</small></div>
      <div class="bar"><span style="width:${s ?? 0}%;background:${scoreColor(s)}"></span></div>
      <div class="spark" id="spark-${p.id}"></div>
    </div>`;
  }).join("");
  const n = 36;
  state.data.pillars.forEach((p) => {
    delete state.charts["spark-" + p.id];
    chart("spark-" + p.id).setOption({
      grid: { left: 0, right: 0, top: 4, bottom: 0 },
      xAxis: { type: "category", show: false, data: state.data.dates.slice(-n) },
      yAxis: { type: "value", show: false, min: 0, max: 100 },
      tooltip: { trigger: "axis", formatter: (a) => `${monthLabel(a[0].axisValue)} : <b>${fmt(a[0].value)}</b>` },
      series: [{ type: "line", data: V.history.pillars[p.id].slice(-n), symbol: "none", smooth: true,
        lineStyle: { width: 1.5, color: "#1f4e8c" }, areaStyle: { color: "rgba(31,78,140,.08)" } }],
    });
  });
}

/* ---------- Historique ---------- */
function renderHistory() {
  const V = state.data.views[state.view];
  const showP = document.getElementById("show-pillars").checked;
  const showZ = document.getElementById("show-z").checked;
  const colors = ["#2a9d8f", "#e76f51", "#6c5ce7", "#c27c0e"];
  const series = [{
    name: "Score", type: "line", data: V.history.score, symbol: "none", lineStyle: { width: 2.5, color: "#1f4e8c" },
    itemStyle: { color: "#1f4e8c" },
    markArea: { silent: true, itemStyle: { color: "rgba(192,57,43,.07)" },
      label: { color: "#8b3a30", fontSize: 11, position: "insideTop" },
      data: CRISES.map(([a, b, n]) => [{ name: n, xAxis: a }, { xAxis: b }]) },
    markLine: { silent: true, symbol: "none", lineStyle: { color: "#b9bec6", type: "dashed" }, label: { show: false }, data: [{ yAxis: 50 }] },
  }];
  if (showZ) series.push({ name: "Score (Z-score)", type: "line", data: V.history.score_z, symbol: "none",
    lineStyle: { width: 1.5, type: "dashed", color: "#16202e" }, itemStyle: { color: "#16202e" } });
  if (showP) state.data.pillars.forEach((p, k) => series.push({ name: p.label, type: "line", data: V.history.pillars[p.id],
    symbol: "none", lineStyle: { width: 1.2, color: colors[k] }, itemStyle: { color: colors[k] } }));
  chart("history").setOption({
    grid: { left: 40, right: 16, top: 30, bottom: 50 },
    legend: { top: 0, icon: "roundRect", itemHeight: 4 },
    tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v) },
    xAxis: { type: "category", data: state.data.dates, axisLabel: { formatter: (v) => v.slice(0, 4) } },
    yAxis: { type: "value", min: 0, max: 100, splitLine: { lineStyle: { color: "#eef0f3" } } },
    dataZoom: [{ type: "slider", height: 18, bottom: 8 }, { type: "inside" }],
    series,
  }, true);
}

/* ---------- Contributions ---------- */
function indLabel(i) {
  const zone = i.zone === "MONDE" ? "" : ` (${i.zone === "US" ? "US" : "ZE"})`;
  return i.name.replace(", écart à 2 %", "").replace(" : écart à la moyenne 200 jours", "")
    .replace("Pente de la courbe 10 ans – 2 ans", "Pente des taux 10 ans – 2 ans")
    .replace("Indicateur avancé OCDE (CLI)", "Indicateur avancé OCDE") + zone;
}

function renderContrib() {
  const C = state.data.views[state.view].latest.contributions;
  const inds = viewIndicators().filter((i) => C[i.id]).sort((a, b) => C[a.id].eff_weight - C[b.id].eff_weight);
  chart("contrib").setOption({
    grid: { left: 210, right: 40, top: 8, bottom: 20 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (a) => `${a[0].name}<br>Apporte <b>${fmt(a[1].value, 1)}</b> pt sur ${fmt(a[0].value, 1)} possibles` },
    xAxis: { type: "value", splitLine: { lineStyle: { color: "#eef0f3" } } },
    yAxis: { type: "category", data: inds.map(indLabel), axisLabel: { fontSize: 12, width: 200, overflow: "truncate" } },
    series: [
      { type: "bar", data: inds.map((i) => C[i.id].eff_weight), barWidth: 14, itemStyle: { color: "#e6eef8", borderRadius: 3 } },
      { type: "bar", data: inds.map((i) => ({ value: C[i.id].points, itemStyle: { color: scoreColor(i.latest.score) } })),
        barWidth: 14, barGap: "-100%", itemStyle: { borderRadius: 3 },
        label: { show: true, position: "right", fontSize: 11, color: "#5d6878", formatter: (p) => fmt(p.value, 1) } },
    ],
  }, true);
}

/* ---------- Tableau ---------- */
function renderTable() {
  const C = state.data.views[state.view].latest.contributions;
  const pl = Object.fromEntries(state.data.pillars.map((p) => [p.id, p.label]));
  const tb = document.querySelector("#ind-table tbody");
  tb.innerHTML = viewIndicators().map((i) => {
    const warn = i.status === "cache" ? '<div class="warn">version précédente conservée</div>'
      : i.status === "stale" ? `<div class="warn">dernière donnée : ${i.last_obs}</div>`
      : i.status === "missing" ? '<div class="warn">indisponible</div>' : "";
    return `<tr data-id="${i.id}" class="${i.id === state.selected ? "sel" : ""}">
      <td>${i.name}${warn}</td>
      <td><span class="pill">${ZONE_LABEL[i.zone]}</span></td>
      <td>${pl[i.pillar]}</td>
      <td class="num">${fmt(i.latest.raw, 2)} <span class="src">${i.unit}</span></td>
      <td class="num"><span class="score-pill" style="background:${scoreColor(i.latest.score)}">${fmt(i.latest.score, 0)}</span></td>
      <td class="num">${C[i.id] ? fmt(C[i.id].eff_weight, 1) + " %" : "–"}</td>
      <td class="src">${i.source}</td></tr>`;
  }).join("");
  tb.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => {
    state.selected = tr.dataset.id;
    tb.querySelectorAll("tr").forEach((x) => x.classList.toggle("sel", x === tr));
    renderDetail();
  }));
}

/* ---------- Détail d'un indicateur ---------- */
function renderDetail() {
  const i = state.data.indicators.find((x) => x.id === state.selected);
  document.getElementById("detail-title").textContent = indLabel(i);
  const how = { minmax: "plus c'est haut, mieux c'est", minmax_inverse: "indicateur de risque : plus c'est haut, plus le score baisse",
    target: `noté selon l'écart à la cible de ${fmt(i.target, 0)} %` }[i.method];
  document.getElementById("detail-hint").textContent = `Valeur brute (${i.unit}) et score sur 100 : ${how}.`;
  chart("detail").setOption({
    grid: { left: 48, right: 40, top: 30, bottom: 30 },
    legend: { top: 0, icon: "roundRect", itemHeight: 4 },
    tooltip: { trigger: "axis", valueFormatter: (v) => fmt(v, 2) },
    xAxis: { type: "category", data: state.data.dates, axisLabel: { formatter: (v) => v.slice(0, 4) } },
    yAxis: [
      { type: "value", name: i.unit, scale: true, splitLine: { lineStyle: { color: "#eef0f3" } } },
      { type: "value", name: "score", min: 0, max: 100, splitLine: { show: false } },
    ],
    series: [
      { name: "Valeur brute", type: "line", data: i.history.raw, symbol: "none", lineStyle: { width: 2, color: "#1f4e8c" }, itemStyle: { color: "#1f4e8c" } },
      { name: "Score /100", type: "line", yAxisIndex: 1, data: i.history.score, symbol: "none",
        lineStyle: { width: 1.2, color: "#c27c0e", type: "dashed" }, itemStyle: { color: "#c27c0e" } },
    ],
  }, true);
}

document.addEventListener("DOMContentLoaded", () => {
  if (window.echarts) init();
  else window.addEventListener("load", init);
});
