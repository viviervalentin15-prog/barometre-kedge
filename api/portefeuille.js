// Portefeuille privé (fictif pour l'instant). Les lignes sont rangées dans la variable de dépôt
// GitHub « PORTFOLIO » : elle n'est pas publique, même si le dépôt l'est. Rien n'est stocké dans le site.
//   GET    /api/portefeuille                 -> { items }
//   POST   /api/portefeuille {ticker, amount, platform, date}  -> { items }
//   DELETE /api/portefeuille?id=<id>         -> { items }
// En-tête obligatoire : x-code (le code du portefeuille).
//
// Variables à définir dans Vercel (Project > Settings > Environment Variables) :
//   PORTFOLIO_CODE : (facultatif) le code à taper sur la page Portefeuille ;
//                    à défaut, c'est le code du bouton de mise à jour (UPDATE_CODE) qui sert
//   GITHUB_TOKEN   : le même jeton que pour le bouton de mise à jour, avec en plus le droit
//                    « Variables : Read and write » sur ce dépôt

import { timingSafeEqual, randomUUID } from "node:crypto";

const REPO = process.env.GITHUB_REPO || "viviervalentin15-prog/barometre-kedge";
const VAR = "PORTFOLIO";
const MAX_ITEMS = 200;
const MAX_FAILS = 5;
const PENALTY_MS = 15 * 60 * 1000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function github(path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "barometre-kedge",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      ...(init.headers || {}),
    },
  });
}

// Stockage remplaçable (les tests le remplacent par un stockage en mémoire)
export const _store = {
  async read() {
    const r = await github(`/actions/variables/${VAR}`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`lecture GitHub ${r.status}`);
    try { const v = JSON.parse((await r.json()).value); return Array.isArray(v) ? v : []; } catch { return []; }
  },
  async write(items) {
    const value = JSON.stringify(items);
    let r = await github(`/actions/variables/${VAR}`, { method: "PATCH", body: JSON.stringify({ name: VAR, value }) });
    if (r.status === 404) r = await github(`/actions/variables`, { method: "POST", body: JSON.stringify({ name: VAR, value }) });
    if (!r.ok) throw new Error(`écriture GitHub ${r.status}`);
  },
};

export function validateItem(o) {
  const ticker = typeof o?.ticker === "string" ? o.ticker.trim().toUpperCase() : "";
  const platform = typeof o?.platform === "string" ? o.platform.trim() : "";
  const amount = Number(o?.amount);
  const date = typeof o?.date === "string" ? o.date : "";
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(ticker)) return { ok: false, error: "Action invalide." };
  if (!Number.isFinite(amount) || amount < 1 || amount > 10_000_000) return { ok: false, error: "Montant entre 1 et 10 000 000 €." };
  if (!platform || platform.length > 40) return { ok: false, error: "Plateforme requise (40 caractères au plus)." };
  const d = new Date(`${date}T00:00:00Z`);
  const today = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(d) || d.toISOString().slice(0, 10) !== date || date < "2000-01-01" || date > today) {
    return { ok: false, error: "Date d'achat invalide (entre 2000 et aujourd'hui)." };
  }
  return { ok: true, item: { ticker, amount: Math.round(amount * 100) / 100, platform, date } };
}

// Limiteur d'essais faux, par adresse (au mieux : la mémoire est propre à chaque instance)
const fails = new Map();
const ipOf = (req) => (req.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > PENALTY_MS) { fails.delete(ip); return false; }
  return f.n >= MAX_FAILS;
}
const expectedCode = () => process.env.PORTFOLIO_CODE || process.env.UPDATE_CODE || "";
function codeOk(given) {
  const a = Buffer.from(String(given || "")), b = Buffer.from(expectedCode());
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req) {
  if (!expectedCode() || !process.env.GITHUB_TOKEN) return json({ error: "Portefeuille non configuré." }, 503);
  const ip = ipOf(req);
  if (blocked(ip)) return json({ error: "Trop d'essais. Réessayez dans un quart d'heure." }, 429);
  if (!codeOk(req.headers.get("x-code"))) {
    const f = fails.get(ip) || { n: 0, first: Date.now() };
    f.n += 1; fails.set(ip, f);
    return json({ error: "Code incorrect." }, f.n > MAX_FAILS ? 429 : 401);
  }
  try {
    if (req.method === "GET") return json({ items: await _store.read() });
    if (req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch { /* corps vide ou invalide */ }
      const v = validateItem(body);
      if (!v.ok) return json({ error: v.error }, 400);
      const items = await _store.read();           // relue juste avant l'écriture
      if (items.length >= MAX_ITEMS) return json({ error: `${MAX_ITEMS} lignes au plus.` }, 400);
      items.push({ id: randomUUID(), ...v.item });
      await _store.write(items);
      return json({ items }, 201);
    }
    if (req.method === "DELETE") {
      const id = new URL(req.url).searchParams.get("id");
      const items = (await _store.read()).filter((i) => i.id !== id);
      await _store.write(items);
      return json({ items });
    }
    return json({ error: "Méthode non prise en charge." }, 405);
  } catch {
    return json({ error: "Stockage GitHub indisponible. Vérifiez le droit « Variables » du jeton." }, 502);
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
