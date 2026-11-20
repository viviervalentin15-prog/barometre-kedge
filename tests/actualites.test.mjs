import assert from "node:assert/strict";
import handler, { parseRss } from "../api/actualites.js";

const xml = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>TotalEnergies relève son dividende &amp; rachète des actions - Les Echos</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Thu, 19 Nov 2026 08:30:00 GMT</pubDate><source url="https://www.lesechos.fr">Les Echos</source></item>
<item><title><![CDATA[Pétrole : le Brent recule <encore> - Boursorama]]></title><link>https://news.google.com/rss/articles/def</link><pubDate>Fri, 20 Nov 2026 07:00:00 GMT</pubDate><source url="https://www.boursorama.com">Boursorama</source></item>
<item><title>APPLE Cours Action AAPL, Cotation Bourse NASDAQ - Boursorama</title><link>https://www.boursorama.com/x</link><pubDate>Fri, 20 Nov 2026 09:00:00 GMT</pubDate><source url="https://www.boursorama.com">Boursorama</source></item>
<item><title>actualites Costco DWRT 900C 0227 (MR4ZQS) - Warrant | DE000MR4ZQS1 - Cotation BOERSE STUTTGART - Bourse Direct</title><link>https://www.boursedirect.fr/x</link><pubDate>Fri, 20 Nov 2026 09:00:00 GMT</pubDate><source url="https://www.boursedirect.fr">Bourse Direct</source></item>
<item><title>Lien douteux - X</title><link>javascript:alert(1)</link><pubDate>Fri, 20 Nov 2026 07:00:00 GMT</pubDate><source url="x">X</source></item>
</channel></rss>`;

const items = parseRss(xml);
assert.equal(items.length, 2, "le lien non http(s), les pages de cotation et de warrants doivent être écartés");
assert.equal(items[0].title, "Pétrole : le Brent recule <encore>", "plus récent d'abord, suffixe source retiré, CDATA lu");
assert.equal(items[1].title, "TotalEnergies relève son dividende & rachète des actions");
assert.equal(items[1].source, "Les Echos");
assert.match(items[1].url, /^https:\/\//);
assert.equal(items[1].date, "2026-11-19T08:30:00.000Z");

function fakeRes() {
  return { code: 0, headers: {}, body: null,
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } };
}
for (const q of [undefined, "", "   ", "x".repeat(121)]) {
  const res = fakeRes();
  await handler({ method: "GET", query: { q } }, res);
  assert.equal(res.code, 400, `q=${JSON.stringify(q)} doit donner 400`);
}
console.log("actualites.test : OK");

// plusieurs recherches : mélange à tour de rôle, sans doublon, 12 titres au plus
const { mergeRoundRobin } = await import("../api/actualites.js");
const L = (p, n) => Array.from({ length: n }, (_, k) => ({ title: `${p}${k}`, source: "S", url: "https://x/" + p + k, date: new Date(Date.UTC(2026, 10, 20, 12 - k)).toISOString() }));
const merged = mergeRoundRobin([L("a", 10), L("b", 2), [{ ...L("a", 1)[0] }, ...L("c", 1)]], 12);
assert.deepEqual(merged.slice(0, 6).map((i) => i.title), ["a0", "b0", "c0", "a1", "b1", "a2"], "à tour de rôle, doublon a0 retiré");
assert.equal(new Set(merged.map((i) => i.url)).size, merged.length, "pas de doublon");
assert.ok(merged.length <= 12);

const resMany = fakeRes();
await handler({ method: "GET", query: { q: ["a", "b", "c", "d", "e", "f"] } }, resMany);
assert.equal(resMany.code, 400, "plus de 5 recherches -> 400");
console.log("actualites.test (plusieurs recherches) : OK");

// nom court : pas de « & » orphelin en fin de nom
const app = (await import("node:fs")).readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const shortName = Function(app.match(/function shortName\(n\) \{[\s\S]*?\n\}/)[0] + "; return shortName;")();
assert.equal(shortName("JPMorgan Chase & Co."), "JPMorgan Chase");
assert.equal(shortName("Procter & Gamble Company"), "Procter & Gamble");
console.log("actualites.test (noms) : OK");
