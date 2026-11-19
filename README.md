# Baromètre des marchés – KEDGE, Gestion d'actifs 2025-2026

Un baromètre synthétique de l'état de l'économie et des marchés (États-Unis + zone euro),
construit à partir de données récupérées automatiquement sur le web, puis (étapes suivantes)
un scoring des secteurs et des entreprises du S&P 500 et de l'Euro Stoxx.

## Organisation du dépôt

| Dossier / fichier | Rôle |
| --- | --- |
| `config/macro.yaml` | Les indicateurs, leurs sources et leurs coefficients : **c'est ici qu'on ajuste les poids** |
| `scripts/sources.py` | Récupération des données (FRED, OCDE, Eurostat, BCE, Yahoo Finance) |
| `scripts/build_macro.py` | Normalisation, calcul des scores, écriture de `site/data/macro.json` |
| `site/` | Le site web (HTML, CSS, JavaScript, graphiques ECharts) |
| `data/raw/` | Dernière version valide de chaque série, réutilisée si une source tombe en panne |
| `.github/workflows/mise-a-jour.yml` | Collecte automatique sur GitHub Actions |

## Mettre à jour les données

Onglet **Actions** du dépôt → **Mise à jour des données** → **Run workflow**.
La collecte tourne aussi automatiquement chaque lundi.

La clé API FRED est rangée dans **Settings → Secrets and variables → Actions** sous le nom `FRED_API_KEY`.

## Méthode (résumé)

1. Chaque indicateur est mis en fréquence mensuelle depuis 2005.
2. Normalisation Min-Max sur 0–100 (2 % des valeurs extrêmes écrêtées de chaque côté).
   Les indicateurs de risque sont inversés ; l'inflation est notée selon son écart à la cible de 2 %.
3. Moyenne pondérée des indicateurs par pilier, puis des piliers : 30 % croissance, 20 % inflation,
   30 % marchés, 20 % risque.
4. Un Z-score est calculé en parallèle comme test de robustesse.

Tester sans internet : `python scripts/build_macro.py --demo` (données simulées).
