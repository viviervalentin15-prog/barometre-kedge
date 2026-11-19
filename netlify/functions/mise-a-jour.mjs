// Fonction Netlify derrière le bouton « Mettre à jour » du site.
//   GET  /api/mise-a-jour        -> état de la dernière collecte (en cours, terminée...)
//   POST /api/mise-a-jour {code} -> lance la collecte sur GitHub Actions si le code est bon
//
// Variables à définir dans Netlify (Site configuration > Environment variables) :
//   GITHUB_TOKEN : jeton GitHub limité à ce dépôt, droit « Actions : Read and write »
//   UPDATE_CODE  : le code à taper sur le site pour lancer une mise à jour
//   GITHUB_REPO  : (facultatif) propriétaire/dépôt, par défaut celui du projet

import { timingSafeEqual } from "node:crypto";

const REPO = process.env.GITHUB_REPO || "viviervalentin15-prog/barometre-kedge";
const WORKFLOW = "mise-a-jour.yml";
const MIN_MINUTES_BETWEEN_RUNS = 15;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function github(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "barometre-kedge",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
}

async function lastRun() {
  const r = await github(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!r.ok) return null;
  const run = (await r.json()).workflow_runs?.[0];
  if (!run) return null;
  return { status: run.status, conclusion: run.conclusion, created_at: run.created_at, updated_at: run.updated_at, url: run.html_url };
}

function sameCode(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export default async (req) => {
  if (req.method === "GET") {
    return json({ configured: Boolean(process.env.GITHUB_TOKEN && process.env.UPDATE_CODE), run: await lastRun() });
  }
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  if (!process.env.GITHUB_TOKEN || !process.env.UPDATE_CODE) {
    return json({ error: "Le bouton n'est pas encore configuré (variables GITHUB_TOKEN et UPDATE_CODE manquantes dans Netlify)." }, 503);
  }
  let code = "";
  try { code = (await req.json()).code || ""; } catch { /* corps vide */ }
  if (!sameCode(code, process.env.UPDATE_CODE)) {
    await new Promise((r) => setTimeout(r, 800)); // ralentit les essais au hasard
    return json({ error: "Code incorrect." }, 401);
  }
  const run = await lastRun();
  if (run && run.status !== "completed") return json({ error: "Une mise à jour est déjà en cours.", run }, 409);
  if (run && Date.now() - Date.parse(run.created_at) < MIN_MINUTES_BETWEEN_RUNS * 60000) {
    return json({ error: `La dernière mise à jour date de moins de ${MIN_MINUTES_BETWEEN_RUNS} minutes. Réessayez un peu plus tard.`, run }, 429);
  }
  const r = await github(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
  if (r.status !== 204) return json({ error: `GitHub a refusé la demande (${r.status}). Vérifiez le jeton GITHUB_TOKEN.` }, 502);
  return json({ ok: true, message: "Mise à jour lancée." }, 202);
};

export const config = { path: "/api/mise-a-jour" };
