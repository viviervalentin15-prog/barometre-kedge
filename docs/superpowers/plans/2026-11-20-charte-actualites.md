# Charte « salle des marchés », mode sombre et actualités — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Appliquer la charte « salle des marchés » en clair et en sombre avec un bouton de bascule, et ajouter des actualités Google Actualités par entreprise et par secteur.

**Architecture:** Les couleurs CSS sont des variables, avec un bloc `[data-theme="dark"]`. Côté JS, un objet mutable `C` remplace les ~70 couleurs écrites en dur et deux thèmes ECharts sont enregistrés. À la bascule, on appelle `applyTheme()`, puis `disposeCharts()` et `route()`, ce qui redessine tout. Une fonction Vercel `api/actualites.js` lit le RSS de Google Actualités.

**Tech Stack:** HTML/CSS/JS sans build, ECharts déjà fourni localement, fonctions Node de Vercel, Google Fonts (IBM Plex).

**Spec:** `docs/superpowers/specs/2026-11-20-charte-actualites-design.md`

## Global Constraints
- Clair : bg `#f3f1ec`, card `#ffffff`, bandeau `#0f2a4a`, accent `#b8892b`.
- Sombre : bg `#0b1220`, card `#111b2e`, bandeau `#081020`, accent `#d8b45a`.
- IBM Plex Sans pour le texte, IBM Plex Mono pour les chiffres (`.num`, scores, tableaux, KPI). Coins à 6 px.
- Thème : `localStorage["theme"]` vaut `"light"` ou `"dark"`. Par défaut on suit `prefers-color-scheme`. Il est posé avant l'affichage par un script en ligne dans `<head>`.
- Actualités : titres, source, date et lien uniquement, jamais le texte des articles. Elles n'entrent dans aucun score.
- Une seule mise en ligne : tests locaux d'abord, puis un seul commit et un seul push.

## Review Focus
- Bascule de thème sur une page avec graphiques (macro, fiche entreprise, pools) : tous les graphiques sont redessinés dans la nouvelle palette, sans graphique vide.
- `localStorage` indisponible (navigation privée) : la bascule fonctionne quand même pour la session.
- Google Actualités injoignable ou sans résultat : un message clair « Aucune actualité trouvée », pas d'erreur JS.
- Paramètre `q` absent, vide ou de plus de 80 caractères : réponse 400, sans appel externe.
- Titres contenant `&amp;` ou `<` : ils sont décodés puis échappés à l'affichage, sans injection HTML.

---

### Task 1: Charte CSS, polices et bouton de thème

**Files:**
- Modify: `site/style.css` : variables `:root`, nouveau bloc `[data-theme="dark"]`, remplacement des couleurs écrites en dur (lignes 35, 43, 86, 101, 106, 166-167, 190, 218, 221, 224, 228-229) par des variables, classe `.num`.
- Modify: `site/index.html` : lien Google Fonts, script de thème dans `<head>`, `<button id="theme-btn">` dans `.topbar`.

**Interfaces:**
- Produces: les variables CSS `--bg --card --ink --muted --line --accent --gold --accent-soft --good --neutral --warning --critical --topbar --topbar-ink --font-num`. L'attribut `document.documentElement.dataset.theme` vaut `"light"` ou `"dark"`.

- [ ] Remplacer toutes les couleurs littérales de `style.css` par des variables, sauf le bloc `@media print`.
- [ ] Vérifier : `grep -n "#[0-9a-fA-F]\{3,6\}" site/style.css` ne doit trouver des couleurs que dans `:root`, `[data-theme="dark"]` et `@media print`.

### Task 2: Couleurs JS et thèmes ECharts

**Files:**
- Modify: `site/app.js` : objet `C`, fonctions `applyTheme(theme)`, `alpha(hex, a)` et `toggleTheme()`, dans `chart(id)`, `echarts.init(el, S.theme === "dark" ? "sombre" : "clair", …)`. Toutes les couleurs `"#xxxxxx"` et `rgba(31,78,140,…)` / `rgba(192,57,43,…)` remplacées par `C.<clé>` et `alpha(C.<clé>, a)`. Nouvelle valeur de `PALETTE`, lisible dans les deux modes.
- Test: `tests/theme.test.mjs` (node, assert).

**Interfaces:**
- Consumes: `dataset.theme` (Task 1).
- Produces: `C` avec les clés `main main2 grid warn bad good good2 teal violet coral ink neutral muted na surface soft badInk line2 card`. Fonctions `applyTheme("light"|"dark")` et `toggleTheme()`.

- [ ] Écrire le test : il lit `site/app.js`, retire la ligne `PALETTE` et le bloc `THEMES`, puis vérifie qu'il ne reste aucune couleur `#xxxxxx`. Il vérifie aussi que `THEMES.light` et `THEMES.dark` ont exactement les mêmes clés.
- [ ] Lancer `node tests/theme.test.mjs` : le test doit ÉCHOUER (couleurs restantes).
- [ ] Faire le remplacement à l'aide d'une table ancienne couleur → clé, puis le bouton : `toggleTheme` → `applyTheme` → `disposeCharts()` → `route()`.
- [ ] `node --check site/app.js && node tests/theme.test.mjs` : OK.
- [ ] Captures Playwright des pages accueil, macro, fiche entreprise et pools, en clair et en sombre, sans erreur de page.

### Task 3: Actualités

**Files:**
- Create: `api/actualites.js` : `export default async function handler(req, res)` et `export function parseRss(xml) -> [{title, source, url, date}]`.
- Modify: `site/app.js` : 5ᵉ onglet `actualites` sur la fiche entreprise (chargé au premier clic), section « Actualités du secteur » dans `pageSector`, et `newsBlock(query) -> Promise<string>`.
- Test: `tests/actualites.test.mjs`.

**Interfaces:**
- Produces: `GET /api/actualites?q=<texte>` renvoie `200 {items:[{title,source,url,date}]}` (10 au maximum, les plus récents d'abord). `q` invalide renvoie `400`. Un échec de la source renvoie `502 {items:[]}`. En-tête `Cache-Control: s-maxage=3600, stale-while-revalidate=86400`.

- [ ] Écrire le test : sur un RSS d'exemple de 2 éléments, `parseRss` doit renvoyer le titre sans le suffixe « - Source », le champ `source`, un `url` en http(s) et une date ISO, avec `&amp;` décodé. Le handler appelé avec `q=""` doit répondre 400.
- [ ] Lancer le test : il doit ÉCHOUER (module absent).
- [ ] Implémenter. L'URL est `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:30d")}&hl=fr&gl=FR&ceid=FR:fr`, avec un délai maximal de 8 s.
- [ ] Lancer le test : il doit RÉUSSIR. Les requêtes sont `"<nom court>"` pour une entreprise et `"secteur <libellé> bourse"` pour un secteur.
- [ ] Commit et push uniques (tâches 1 à 3), puis vérification sur le site en ligne : bascule de thème, onglet Actualités d'une entreprise, actualités d'un secteur.
