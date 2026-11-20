import assert from "node:assert/strict";
process.env.PORTFOLIO_CODE = "abc";
process.env.GITHUB_TOKEN = "jeton-de-test";
const api = await import("../api/portefeuille.js");
const { validateItem, _store } = api;

// validation d'une ligne
const ok = validateItem({ ticker: "TTE.PA", amount: 3000, platform: "Boursorama", date: "2026-11-02" });
assert.equal(ok.ok, true); assert.equal(ok.item.amount, 3000);
const today = new Date(); const future = new Date(today.getTime() + 3 * 864e5).toISOString().slice(0, 10);
for (const bad of [
  { ticker: "TTE.PA", amount: 0, platform: "B", date: "2026-11-02" },
  { ticker: "TTE.PA", amount: 10, platform: "B", date: future },
  { ticker: "TTE.PA", amount: 10, platform: "B", date: "1999-12-31" },
  { ticker: "TTE.PA", amount: 10, platform: "x".repeat(41), date: "2026-11-02" },
  { ticker: "", amount: 10, platform: "B", date: "2026-11-02" },
  { ticker: "TTE.PA", amount: 10, platform: "B", date: "2026-02-30" },
]) assert.equal(validateItem(bad).ok, false, JSON.stringify(bad));

// cycle complet avec un stockage en mémoire
let mem = [];
_store.read = async () => structuredClone(mem);
_store.write = async (items) => { mem = structuredClone(items); };
const call = async (method, { code = "abc", body, query = "", ip = "1.1.1.1" } = {}) => {
  const r = await api[method](new Request(`https://x/api/portefeuille${query}`, {
    method, headers: { "x-code": code, "content-type": "application/json", "x-forwarded-for": ip }, body: body ? JSON.stringify(body) : undefined }));
  return { status: r.status, body: await r.json(), cache: r.headers.get("cache-control") };
};
let r = await call("GET"); assert.equal(r.status, 200); assert.deepEqual(r.body.items, []); assert.equal(r.cache, "no-store");
r = await call("POST", { body: { ticker: "TTE.PA", amount: 3000, platform: "Boursorama", date: "2026-11-02" } });
assert.equal(r.status, 201); assert.equal(r.body.items.length, 1); assert.ok(r.body.items[0].id);
const id = r.body.items[0].id;
r = await call("POST", { body: { ticker: "", amount: 3000, platform: "B", date: "2026-11-02" } }); assert.equal(r.status, 400);
r = await call("GET"); assert.equal(r.body.items.length, 1);
r = await call("DELETE", { query: `?id=${id}` }); assert.equal(r.status, 200); assert.equal(r.body.items.length, 0);

// mauvais code : 401 sans données, puis 429 au 6e essai faux depuis la même adresse
for (let k = 1; k <= 5; k++) { r = await call("GET", { code: "faux", ip: "9.9.9.9" }); assert.equal(r.status, 401); assert.equal(r.body.items, undefined); }
r = await call("GET", { code: "faux", ip: "9.9.9.9" }); assert.equal(r.status, 429);
r = await call("GET", { code: "abc", ip: "9.9.9.9" }); assert.equal(r.status, 429, "bloqué même avec le bon code pendant la pénalité");
r = await call("GET", { code: "abc", ip: "2.2.2.2" }); assert.equal(r.status, 200, "une autre adresse n'est pas bloquée");

// 200 lignes au plus
mem = Array.from({ length: 200 }, (_, k) => ({ id: String(k), ticker: "A", amount: 1, platform: "B", date: "2026-11-02" }));
r = await call("POST", { body: { ticker: "TTE.PA", amount: 1, platform: "B", date: "2026-11-02" } }); assert.equal(r.status, 400);

// sans code propre : le code de mise à jour sert de code du portefeuille
delete process.env.PORTFOLIO_CODE;
process.env.UPDATE_CODE = "maj-123";
r = await call("GET", { code: "maj-123", ip: "4.4.4.4" }); assert.equal(r.status, 200, "le code de mise à jour doit ouvrir le portefeuille");
r = await call("GET", { code: "abc", ip: "4.4.4.5" }); assert.equal(r.status, 401);
process.env.PORTFOLIO_CODE = "propre";
r = await call("GET", { code: "maj-123", ip: "4.4.4.6" }); assert.equal(r.status, 401, "un code propre prend le dessus");

// non configuré
delete process.env.PORTFOLIO_CODE; delete process.env.UPDATE_CODE;
r = await call("GET", { ip: "3.3.3.3" }); assert.equal(r.status, 503);
console.log("portefeuille-api.test : OK");
