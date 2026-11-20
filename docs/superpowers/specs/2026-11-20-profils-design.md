# Sélecteur de profil pour la note des entreprises

## Intention
Les coefficients des 4 familles ne peuvent pas être réglés objectivement (le test 2023-2025 ne couvre que Dynamique et Risque, sur une période haussière). Valentin choisit donc un profil d'investisseur, et le site recalcule les notes en conséquence.

## Profils (Dynamique / Qualité / Valorisation / Risque)
- Équilibré long terme (par défaut) : 30 / 30 / 20 / 20
- Performance : 40 / 25 / 20 / 15
- Prudent : 20 / 30 / 15 / 35

## Comportement
- La collecte calcule toujours les notes par famille. Le profil par défaut fixe les poids côté serveur (historique, tests, prévisions).
- Le navigateur recalcule la note de chaque entreprise (moyenne pondérée des familles), son rang dans le secteur, la partie « entreprises » des secteurs (moyenne pondérée par la capitalisation des notes « univers », puis Z-score entre secteurs) et le score des secteurs (0,6 / 0,4 + ajustement macro), ainsi que les 3 meilleures et 3 moins bonnes entreprises.
- Sélecteur dans la barre d'outils, choix retenu dans le navigateur. Il s'applique partout où une note apparaît.
- Les courbes d'historique restent calculées avec le profil par défaut, et c'est signalé. Les prévisions et le baromètre macro ne changent pas.

## Approches
Retenue : calcul dans le navigateur à partir des notes par famille publiées. Écartée : une version des données par profil côté serveur (3 fois plus de données et de mises en ligne).

## Contrôle
Avec le profil par défaut, le calcul du navigateur doit redonner les notes du serveur (entreprises, rangs, secteurs) à l'arrondi près.
