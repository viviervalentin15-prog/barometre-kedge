// Cohérence : avec le profil par défaut, le calcul du navigateur redonne les notes du serveur.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const grab = (name) => { const m = app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)); assert.ok(m, `${name} absente`); return m[0]; };
const { profileScore, rescaleZ, sectorItems, rankInSector } = Function(
  [grab("profileScore"), grab("rescaleZ"), grab("sectorItems"), grab("rankInSector")].join("\n") +
  "; return { profileScore, rescaleZ, sectorItems, rankInSector };")();

const data = (f) => JSON.parse(readFileSync(new URL(`../site/data/${f}`, import.meta.url), "utf8"));
const comp = data("companies.json"), sect = data("sectors.json");
assert.ok(comp.profiles?.length === 3, "3 profils publiés");
const def = comp.profiles.find((p) => p.id === comp.default_profile);
assert.deepEqual(def.weights, { valorisation: 20, dynamique: 30, risque: 20, qualite: 30 });
const cs = comp.companies;
assert.ok(cs.every((c) => "u_dynamique" in c), "notes univers publiées");

let worst = 0;
for (const c of cs) {
  const s = profileScore(c, def.weights, "f_"), u = profileScore(c, def.weights, "u_");
  if (c.sc == null) { assert.equal(s, null, c.t); continue; }
  worst = Math.max(worst, Math.abs(s - c.sc), Math.abs(u - c.su));
}
assert.ok(worst <= 0.11, `écart max entreprises ${worst}`);

const ranks = rankInSector(cs.map((c) => ({ ...c, sc: profileScore(c, def.weights, "f_") })));
assert.ok(cs.every((c) => c.rk == null || ranks[c.t] === c.rk), "rangs identiques");

const VIEW_ZONES = { commun: ["US", "EZ"], US: ["US"], EZ: ["EZ"] };
const m = sect.method;
for (const [view, v] of Object.entries(sect.views)) {
  const scored = cs.map((c) => ({ ...c, su: profileScore(c, def.weights, "u_") }));
  const items = sectorItems(v.sectors, scored, VIEW_ZONES[view], m);
  for (const it of items) {
    const ref = v.sectors.find((x) => x.id === it.id);
    assert.ok(Math.abs(it.company_score - ref.company_score) <= 0.25, `${view} ${it.id} part entreprises ${it.company_score} vs ${ref.company_score}`);
    assert.ok(Math.abs(it.score - ref.score) <= 0.35, `${view} ${it.id} score ${it.score} vs ${ref.score}`);
  }
}
// un autre profil change bien les notes
const perf = comp.profiles.find((p) => p.id === "performance");
assert.ok(cs.some((c) => c.sc != null && Math.abs(profileScore(c, perf.weights, "f_") - c.sc) > 1));
console.log("profiles.test : OK");
