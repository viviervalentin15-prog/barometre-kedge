import assert from "node:assert/strict";
import handler, { parseRss } from "../api/actualites.js";

const xml = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>TotalEnergies relève son dividende &amp; rachète des actions - Les Echos</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Thu, 19 Nov 2026 08:30:00 GMT</pubDate><source url="https://www.lesechos.fr">Les Echos</source></item>
<item><title><![CDATA[Pétrole : le Brent recule <encore> - Boursorama]]></title><link>https://news.google.com/rss/articles/def</link><pubDate>Fri, 20 Nov 2026 07:00:00 GMT</pubDate><source url="https://www.boursorama.com">Boursorama</source></item>
<item><title>Lien douteux - X</title><link>javascript:alert(1)</link><pubDate>Fri, 20 Nov 2026 07:00:00 GMT</pubDate><source url="x">X</source></item>
</channel></rss>`;

const items = parseRss(xml);
assert.equal(items.length, 2, "le lien non http(s) doit être écarté");
assert.equal(items[0].title, "Pétrole : le Brent recule <encore>", "plus récent d'abord, suffixe source retiré, CDATA lu");
assert.equal(items[1].title, "TotalEnergies relève son dividende & rachète des actions");
assert.equal(items[1].source, "Les Echos");
assert.match(items[1].url, /^https:\/\//);
assert.equal(items[1].date, "2026-11-19T08:30:00.000Z");

function fakeRes() {
  return { code: 0, headers: {}, body: null,
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } };
}
for (const q of [undefined, "", "   ", "x".repeat(81)]) {
  const res = fakeRes();
  await handler({ method: "GET", query: { q } }, res);
  assert.equal(res.code, 400, `q=${JSON.stringify(q)} doit donner 400`);
}
console.log("actualites.test : OK");
