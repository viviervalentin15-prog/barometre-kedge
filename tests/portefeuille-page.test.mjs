import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const src = app.match(/function valuateLine\(item, detail\) \{[\s\S]*?\n\}/);
assert.ok(src, "valuateLine absente de app.js");
const valuateLine = Function(src[0] + "; return valuateLine;")();
const detail = { price: 110, currency: "EUR", prices: { dates: ["2026-10-30", "2026-11-06"], close: [100, 104] } };
let r = valuateLine({ amount: 3000, date: "2026-11-01" }, detail);           // dimanche -> cours du 30/10
assert.equal(r.status, "ok"); assert.equal(r.buyPrice, 100);
assert.ok(Math.abs(r.perf - 0.1) < 1e-9 && Math.abs(r.value - 3300) < 1e-6);
r = valuateLine({ amount: 1000, date: "2020-01-02" }, detail);
assert.equal(r.status, "cours d'achat indisponible"); assert.equal(r.value, null);
r = valuateLine({ amount: 500, date: "2026-11-02" }, null);
assert.equal(r.status, "indisponible"); assert.equal(r.value, null);
console.log("portefeuille-page.test : OK");
