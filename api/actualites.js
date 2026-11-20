// Actualités récentes (titres, source, date, lien) depuis le flux RSS de Google Actualités.
// GET /api/actualites?q=<texte>  ->  { items: [{ title, source, url, date }] }
// Seuls les titres et les liens sont repris : jamais le texte des articles. N'entre dans aucun score.

const MAX_ITEMS = 10;
const MAX_QUERY = 80;

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
    if (!title || !/^https?:\/\//i.test(url) || Number.isNaN(t)) continue;
    items.push({ title, source, url, date: new Date(t).toISOString() });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ITEMS);
}

export default async function handler(req, res) {
  const q = typeof req.query?.q === "string" ? req.query.q.trim() : "";
  if (req.method !== "GET" || !q || q.length > MAX_QUERY) {
    return res.status(400).json({ error: "Paramètre q requis (80 caractères au plus).", items: [] });
  }
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:30d`)}&hl=fr&gl=FR&ceid=FR:fr`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 (barometre-kedge)" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const items = parseRss(await r.text());
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ items });
  } catch (e) {
    res.setHeader("Cache-Control", "s-maxage=300");
    return res.status(502).json({ error: "Source d'actualités indisponible.", items: [] });
  }
}
