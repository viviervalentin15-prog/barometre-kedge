// Actualités récentes (titres, source, date, lien) depuis le flux RSS de Google Actualités.
// GET /api/actualites?q=<texte>  ->  { items: [{ title, source, url, date }] }
// Seuls les titres et les liens sont repris : jamais le texte des articles. N'entre dans aucun score.

const MAX_ITEMS = 10;
const MAX_QUERY = 120;
const QUOTE_PAGE = /cours action .*cotation bourse/i; // pages de cotation automatiques, sans information

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};

export function parseRss(xml) {
  const items = [];
  for (const [, block] of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const source = tag(block, "source");
    let title = tag(block, "title");
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const url = tag(block, "link");
    const t = Date.parse(tag(block, "pubDate"));
    if (!title || QUOTE_PAGE.test(title) || !/^https?:\/\//i.test(url) || Number.isNaN(t)) continue;
    items.push({ title, source, url, date: new Date(t).toISOString() });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ITEMS);
}

const MAX_QUERIES = 5;
const MAX_MERGED = 12;

// Mélange plusieurs listes à tour de rôle (1er de chaque liste, puis 2e…), sans doublon :
// un secteur n'est pas accaparé par l'actualité d'une seule entreprise.
export function mergeRoundRobin(lists, max = MAX_MERGED) {
  const out = [], seen = new Set();
  const key = (i) => i.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const pos = lists.map(() => 0);
  while (out.length < max && lists.some((l, j) => pos[j] < l.length)) {
    for (let j = 0; j < lists.length && out.length < max; j++) {
      while (pos[j] < lists[j].length) {        // un doublon ne fait pas perdre son tour à la liste
        const it = lists[j][pos[j]++];
        if (seen.has(it.url) || seen.has(key(it))) continue;
        seen.add(it.url); seen.add(key(it)); out.push(it);
        break;
      }
    }
  }
  return out;
}

async function search(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:30d`)}&hl=fr&gl=FR&ceid=FR:fr`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 (barometre-kedge)" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseRss(await r.text());
}

export default async function handler(req, res) {
  const raw = req.query?.q;
  const qs = (Array.isArray(raw) ? raw : [raw]).map((q) => (typeof q === "string" ? q.trim() : ""));
  if (req.method !== "GET" || !qs.length || qs.length > MAX_QUERIES || qs.some((q) => !q || q.length > MAX_QUERY)) {
    return res.status(400).json({ error: `Paramètre q requis (${MAX_QUERIES} recherches de ${MAX_QUERY} caractères au plus).`, items: [] });
  }
  const results = await Promise.allSettled(qs.map(search));
  const lists = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!lists.length) {
    res.setHeader("Cache-Control", "s-maxage=300");
    return res.status(502).json({ error: "Source d'actualités indisponible.", items: [] });
  }
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json({ items: lists.length === 1 ? lists[0] : mergeRoundRobin(lists) });
}
