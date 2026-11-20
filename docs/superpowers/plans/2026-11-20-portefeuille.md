# Portefeuille et compte rendu par mail — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enregistrer des positions fictives (action, montant, plateforme, date) dans un stockage privé et envoyer un compte rendu par mail après chaque mise à jour.

**Architecture:**
- Les positions sont stockées en JSON dans la variable de dépôt GitHub `PORTFOLIO`.
- `api/portefeuille.js` (Vercel) la lit et l'écrit derrière `PORTFOLIO_CODE`.
- `scripts/portfolio.py` (GitHub Actions) valorise les positions à partir de `site/data` et envoie le mail par SMTP Gmail.
- La page `#/portefeuille` de `site/app.js` est l'interface.

**Tech Stack:** Node (fonctions Vercel, `fetch`, `crypto`), Python 3 de la bibliothèque standard (`smtplib`, `email`, `json`), JS sans build.

**Spec:** `docs/superpowers/specs/2026-11-20-portefeuille-design.md`

## Global Constraints
- Aucune position dans le dépôt, dans `site/data` ou dans `localStorage`. Le code est gardé uniquement en `sessionStorage`.
- Variables d'environnement Vercel : `GITHUB_TOKEN` (droit « Variables : lecture et écriture » en plus) et `PORTFOLIO_CODE`. Dépôt : `viviervalentin15-prog/barometre-kedge`.
- Secrets GitHub : `MAIL_USER`, `MAIL_APP_PASSWORD`, `MAIL_TO`. Envoi par `smtp.gmail.com:465` en SSL.
- Ligne : `{id, ticker, amount, platform, date}`. `amount` est en € (1 à 10 000 000) ; `platform` fait au plus 40 caractères ; `date` est au format `AAAA-MM-JJ`, entre 2000-01-01 et aujourd'hui. 200 lignes au plus.
- Performance = cours actuel ÷ cours d'achat − 1 (devise de l'action), valeur = montant × (1 + perf). L'effet de change n'est pas compté, et c'est affiché.
- Le mail n'est envoyé que s'il y a au moins une ligne. Un échec du mail ne fait pas échouer la collecte (`continue-on-error`).
- Un seul commit et un seul push, puis une seule collecte de vérification.

## Review Focus
- Une action sortie de l'univers (plus de fiche) : la ligne reste listée avec « données indisponibles » et n'entre pas dans les totaux, ni sur la page ni dans le mail.
- Date d'achat un week-end ou un jour férié : on prend le dernier cours connu avant. Date antérieure à l'historique : « cours d'achat indisponible ».
- Variable `PORTFOLIO` absente, vide, `[]` ou JSON invalide : aucun mail, sortie 0, une ligne de journal.
- Mauvais code : réponse 401 sans aucune donnée. Au 6ᵉ essai faux en 15 minutes depuis la même adresse : 429.
- Deux requêtes d'ajout simultanées : la seconde ne doit pas effacer la première. On relit la variable juste avant d'écrire, et on accepte le risque résiduel d'une seule personne qui saisit.

---

### Task 1: API privée `api/portefeuille.js`

**Files:**
- Create: `api/portefeuille.js`
- Test: `tests/portefeuille-api.test.mjs`

**Interfaces:**
- Produces :
  - `GET /api/portefeuille` avec l'en-tête `x-code` → `200 {items:[…]}`.
  - `POST` avec le corps `{ticker, amount, platform, date}` → `201 {items}`, l'`id` étant généré par `crypto.randomUUID()`.
  - `DELETE ?id=` → `200 {items}`.
  - Erreurs : 401 (code faux), 429 (trop d'essais), 400 (ligne invalide), 503 (code ou jeton non configuré), 502 (GitHub en échec).
  - Exports pour les tests : `validateItem(obj) -> {ok, item?, error?}`, `handler(req, res)`, `_store` (stockage remplaçable).

- [ ] Test : `validateItem` refuse un montant de 0, une date future, une date « 1999-12-31 », une plateforme de 41 caractères et un ticker vide. Il accepte `{ticker:"TTE.PA", amount:3000, platform:"Boursorama", date:"2026-11-02"}`.
- [ ] Test : le handler, avec `_store` remplacé en mémoire et `PORTFOLIO_CODE="abc"`, enchaîne GET → POST → GET (1 ligne) → DELETE → GET (0 ligne). Un code faux donne 401. Le 6ᵉ code faux donne 429. Sans `PORTFOLIO_CODE`, la réponse est 503.
- [ ] Lancer `node tests/portefeuille-api.test.mjs` : il doit ÉCHOUER (module absent).
- [ ] Implémenter :
  - `_store.read()` : `GET https://api.github.com/repos/<repo>/actions/variables/PORTFOLIO`, 404 donnant `[]`.
  - `_store.write(items)` : `PATCH` sur la variable, ou `POST …/actions/variables` si elle n'existe pas encore.
  - Comparaison du code avec `timingSafeEqual`.
  - Limiteur d'essais en mémoire, par adresse (`x-forwarded-for`), au mieux par instance.
  - En-tête `Cache-Control: no-store`.
- [ ] `node tests/portefeuille-api.test.mjs` : OK.

### Task 2: Valorisation et mail `scripts/portfolio.py`

**Files:**
- Create: `scripts/portfolio.py`
- Modify: `.github/workflows/mise-a-jour.yml` : nouvelle étape « Compte rendu du portefeuille » après le contrôle de santé, avec `if: always()`, `continue-on-error: true` et l'env `PORTFOLIO: ${{ vars.PORTFOLIO }}` plus les 3 secrets `MAIL_*`.
- Test: `tests/test_portfolio.py` (assertions simples, lancé par `python3`).

**Interfaces:**
- Consumes :
  - `site/data/companies/<ticker avec . et / remplacés par _>.json` (`prices.dates`, `prices.close`, `price`, `currency`, `score`, `score_history`, `recommendation`, `target_price`, `name`) ;
  - `site/data/predictions/<idem>.json` (`h["1a"|"3a"].p`, `.fiabilite`) ;
  - `site/data/macro.json` (`views.commun.latest`) ;
  - `site/data/companies.json` (`eurusd`).
- Produces :
  - `load_holdings(raw: str) -> list[dict]` ;
  - `valuate(holdings, data_dir: Path) -> dict` (`{lines:[…], totals:{invested,value,gain,perf}, platforms:{nom: valeur}, macro:{…}, date}`) ;
  - `render(report) -> tuple[str, str, str]` (objet, texte, html) ;
  - `main() -> int`.

- [ ] Test : `load_holdings` renvoie `[]` pour `""`, `"[]"` et `"{pas du json"`.
- [ ] Test : sur un dossier temporaire contenant une fiche dont les cours sont 100 (2026-11-02, un lundi) puis 110, une ligne de 3 000 € achetée le 2026-11-01 (un dimanche) donne un cours d'achat de 100 seulement si un cours existe avant. Sinon, statut « cours d'achat indisponible ». Avec un cours de 100 au 2026-10-30, la ligne vaut 3 300 € et perf 0,10. Une ligne dont le ticker n'a pas de fiche donne `status == "indisponible"` et n'entre pas dans `totals`.
- [ ] Test : l'objet produit par `render` commence par « Baromètre KEDGE · Portefeuille au ». Le texte contient le nom, la plateforme, « Analystes » et « Prévisions ».
- [ ] Test : `main()` avec `PORTFOLIO="[]"` renvoie 0 sans appeler SMTP (smtplib remplacé par un objet qui échoue s'il est appelé).
- [ ] Lancer `python3 tests/test_portfolio.py` : il doit ÉCHOUER.
- [ ] Implémenter :
  - le score de la mise à jour précédente est l'avant-dernière valeur de `score_history` ;
  - les libellés des recommandations reprennent ceux du site (Achat fort, Achat, Conserver, Vente, Vente forte) ;
  - HTML : un bloc par action, texte brut en secours ;
  - pied de mail avec le lien vers `https://barometre-kedge-valentin-vivier.vercel.app/#/portefeuille` et la mention de l'effet de change non compté.
- [ ] `python3 tests/test_portfolio.py` : OK.

### Task 3: Page `#/portefeuille`

**Files:**
- Modify: `site/index.html` : lien de navigation « Portefeuille ».
- Modify: `site/app.js` : route `#/portefeuille`, `pagePortfolio(app)`, `portfolioApi(method, body?, query?) -> Promise<{items}>`, `valuateLine(item, detail) -> {buyPrice, perf, value, status}` (même règle que `valuate`, une clé de plus pour le test).
- Modify: `site/style.css` : styles du formulaire et des lignes.
- Test: `tests/theme.test.mjs` doit rester vert, et l'ajout se vérifie dans `tests/portefeuille-page.test.mjs` (extraction de `valuateLine`, mêmes cas que la Task 2).

**Interfaces:**
- Consumes : l'API de la Task 1 ; `loadPredictions`, `shortName`, `kpi`, `scorePill`, `getJSON` déjà présents ; les fichiers de la Task 2.

- [ ] Test : `valuateLine` reproduit les cas de la Task 2 (week-end, date trop ancienne, fiche absente).
- [ ] Lancer le test : il doit ÉCHOUER.
- [ ] Implémenter :
  - sans code en session, un champ « Code du portefeuille », puis appel à l'API. Si la réponse est 401, message « Code incorrect » et le code est effacé ;
  - formulaire d'ajout : recherche d'action comme dans les pools, montant, plateforme avec une `datalist` des plateformes déjà saisies, date (max = aujourd'hui) ;
  - indicateurs clés : investi, valeur, plus-value. Répartition par plateforme, tableau des lignes avec un bouton supprimer qui demande confirmation ;
  - note sur l'effet de change et sur la séparation avec le score.
- [ ] Lancer le test de la page et `node tests/theme.test.mjs` : OK. Captures Playwright en clair et en sombre sans erreur (API simulée par `page.route`).
- [ ] Commit et push uniques (tâches 1 à 3).
- [ ] Après la configuration faite par Valentin, vérifier en ligne : ajout d'une ligne, puis lancement d'une collecte. Le mail doit être reçu et l'étape au vert. La page publique ne doit exposer aucune position sans code.
