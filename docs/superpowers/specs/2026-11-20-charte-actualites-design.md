# Charte « salle des marchés », mode clair/sombre et onglet Actualités

## Intention
Rendre le site plus lisible et agréable (charte graphique cohérente), permettre de passer en mode sombre, et ajouter des actualités récentes par entreprise et par secteur. Tout part en une seule mise en ligne (économie de crédits).

## Objectifs
- Charte « salle des marchés » (direction 2, choisie par Valentin sur maquettes) :
  - clair : fond `#f3f1ec`, cartes blanches, bandeau `#0f2a4a`, accent doré `#b8892b` ;
  - sombre : fond `#0b1220`, cartes `#111b2e`, bandeau `#081020`, accent `#d8b45a` ;
  - IBM Plex Sans pour le texte, IBM Plex Mono pour les chiffres (Google Fonts, repli système) ;
  - vert/rouge/gris lisibles dans les deux modes ; palette des pools revue ; coins 6 px ; tableaux plus aérés ; titres de cartes en petites capitales grises.
- Bouton lune/soleil dans le bandeau : suit le réglage du système au premier passage, retient le choix (localStorage), pas de clignotement au chargement.
- Onglet « Actualités » sur la fiche entreprise et la page secteur : titres Google Actualités en français (titre, source, date, lien), chargés à la demande.

## Non-objectifs
Pas de nouvelles pages, pas de changement de calculs, pas de PDF. Les actualités n'entrent dans aucun score.

## Anti-objectifs
Couleurs illisibles dans un des deux modes ; graphiques restés dans l'ancienne palette après bascule ; reproduction du texte des articles (titres + liens seulement).

## Approches
- **Retenue :** variables CSS uniques avec bloc `[data-theme="dark"]`, couleurs des graphiques lues dans ces variables et graphiques redessinés à la bascule.
- Écartée : second fichier de styles sombre (chaque couleur en double).
- Écartée : thème sombre intégré d'ECharts (ne suit pas la charte).
- Actualités, retenue : fonction Vercel `api/actualites.js` qui lit le flux RSS Google Actualités (`hl=fr`), mise en cache 1 h. Écartées : API AFP (contrat payant pour un site public), Yahoo via la collecte du lundi (anglais, jusqu'à une semaine de retard).

## Laissé au constructeur
Détail des teintes secondaires, requête exacte par secteur, nombre de titres affichés (≈ 10).
