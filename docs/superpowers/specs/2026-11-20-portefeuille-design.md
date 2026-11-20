# Portefeuille personnel et compte rendu par mail

## Intention
Valentin veut enregistrer des positions en actions (action, montant, plateforme, date d'achat) et recevoir un compte rendu par mail après chaque mise à jour des données. Le portefeuille est fictif aujourd'hui, mais il pourra servir à investir pour de vrai plus tard, une fois le site rendu privé. La protection doit donc être bonne dès maintenant, pour ne rien avoir à refaire.

## Objectifs
- **Page `#/portefeuille` :**
  - accès par code ;
  - ajout d'une ligne : action choisie par recherche, montant en €, plateforme en texte libre avec des suggestions tirées des plateformes déjà saisies, date d'achat (aujourd'hui par défaut, sans date future) ;
  - suppression d'une ligne ;
  - affichage pour chaque ligne : cours d'achat, nombre d'actions, valeur actuelle, performance, score, conseil des analystes, prévisions 1 an et 3 ans ;
  - totaux : total investi, valeur, plus-value, répartition par plateforme.
- **Calculs :**
  - cours d'achat = dernier cours de clôture à la date d'achat ou juste avant ;
  - performance = cours actuel ÷ cours d'achat − 1, dans la devise de l'action ;
  - valeur en € = montant × (1 + performance) ;
  - nombre d'actions indicatif = montant ÷ (cours d'achat en €, au taux EUR/USD courant).
  - Limite affichée : l'effet de change euro/dollar n'est pas compté, car seul le taux du jour est collecté.
- **Mail :**
  - il part après chaque mise à jour (lundi et bouton), seulement s'il y a au moins une ligne ;
  - objet : « Baromètre KEDGE · Portefeuille au <date> : <valeur> € (<perf>) » ;
  - contenu :
    - totaux et contexte macro (score commun, signal, tendance à 3 mois) ;
    - un bloc par action : plateforme, investi → valeur (perf), score et son évolution depuis la mise à jour précédente, analystes (recommandation, objectif, potentiel), prévisions 1 an et 3 ans avec leur fiabilité ;
    - les totaux par plateforme et un lien vers la page.
  - Le mail se lit bien sur téléphone : un bloc par action, pas de tableau large.

## Non-objectifs
Ventes et gains réalisés, dividendes, frais de courtage, plusieurs utilisateurs. Le portefeuille n'entre dans aucun score.

## Anti-objectifs
- Positions lisibles publiquement : pas de stockage dans le dépôt, ni dans `site/data`, ni dans le navigateur au-delà de la session.
- Code ou mots de passe qui circulent dans le chat ou dans le code.
- Mail envoyé alors que le portefeuille est vide.
- Échec du mail qui ferait échouer la collecte des données.

## Contraintes
- Le site et le dépôt sont publics.
- Hébergement Vercel Hobby, collecte sur GitHub Actions, aucun nouveau service payant.
- Économie de crédits : un seul commit, puis une seule collecte de vérification.

## Approches
- **Retenue :** une variable de dépôt GitHub `PORTFOLIO` (JSON, limite de 48 Ko), non publique même sur un dépôt public.
  - La fonction Vercel `api/portefeuille.js` la lit et l'écrit, protégée par `PORTFOLIO_CODE`, avec le jeton GitHub déjà présent (droit « Variables : lecture et écriture » à ajouter).
  - La collecte la lit via `vars.PORTFOLIO`.
- Écartée : le stockage de fichiers Vercel (Blob), accessible par simple lien.
- Écartée : un fichier chiffré dans le dépôt, plus complexe pour la même protection.
- **Mail :** SMTP Gmail avec un mot de passe d'application (secrets `MAIL_USER`, `MAIL_APP_PASSWORD`, `MAIL_TO`).
  - Écartés : Resend et équivalents (nouveau compte), ainsi que l'envoi depuis Vercel, puisque la collecte est déjà sur GitHub.

## Choix faits par Claude (à corriger si besoin)
- Une action vendue est simplement supprimée.
- Les lignes sont indépendantes : deux achats de la même action font deux lignes.
- Le code saisi est gardé seulement pour la session du navigateur (`sessionStorage`).
- 5 essais de code faux au plus par quart d'heure et par adresse.
- Cours historiques : ceux des fiches entreprises (`site/data/companies/<ticker>.json`, 5 ans). Un achat antérieur à 5 ans est refusé.

## Laissé au constructeur
Mise en page exacte de la page, version HTML du mail (texte brut en secours), messages d'erreur.
