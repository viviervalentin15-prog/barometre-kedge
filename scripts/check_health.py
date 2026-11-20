"""
Contrôle de santé après chaque collecte.

Vérifie que chaque bloc de données vient d'être mis à jour et qu'aucune source n'est
tombée en panne. Écrit un rapport (Markdown) et sort avec le code 1 en cas de problème :
le workflow GitHub ouvre alors un ticket « alerte-donnees », ce qui envoie un e-mail
au propriétaire du dépôt.

Lancer : python scripts/check_health.py --report sante.md
"""

from __future__ import annotations

import argparse
import glob
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "site" / "data"


def age_hours(iso: str) -> float:
    t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - t).total_seconds() / 3600


def main(report: str, max_age: float) -> int:
    problems, warnings, ok = [], [], []

    def load(path):
        try:
            return json.loads((DATA / path).read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            problems.append(f"Fichier `{path}` illisible ou absent ({e}).")
            return None

    # --- baromètre macro ---
    m = load("macro.json")
    if m:
        if age_hours(m["updated"]) > max_age:
            problems.append(f"Baromètre macro non mis à jour depuis {age_hours(m['updated']):.0f} h.")
        for i in m["indicators"]:
            if i["status"] in ("cache", "missing"):
                problems.append(f"Indicateur **{i['name']}** ({i['zone']}) : source en panne, "
                                f"{'version précédente conservée' if i['status'] == 'cache' else 'aucune donnée'} "
                                f"(dernière donnée : {i.get('last_obs') or '–'}).")
            elif i["status"] == "stale":
                warnings.append(f"Indicateur {i['name']} ({i['zone']}) : dernière donnée ancienne ({i.get('last_obs')}).")
        if not m.get("recession"):
            warnings.append("Probabilité de récession indisponible.")
        ok.append(f"Baromètre : score {m['views']['commun']['latest']['score']} au {m['dates'][-1]}.")

    # --- entreprises ---
    c = load("companies.json")
    if c:
        n = len(c["companies"])
        scored = sum(1 for x in c["companies"] if x.get("sc") is not None)
        if c.get("demo"):
            problems.append("Les données entreprises sont des données simulées.")
        if age_hours(c["updated"]) > max_age:
            problems.append(f"Données entreprises non mises à jour depuis {age_hours(c['updated']):.0f} h.")
        if n < 700:
            problems.append(f"Seulement {n} entreprises dans l'univers (attendu : environ 790).")
        if n and scored / n < 0.95:
            problems.append(f"Seulement {scored}/{n} entreprises notées.")
        limit = (datetime.now(timezone.utc) - timedelta(days=10)).strftime("%Y-%m-%d")
        stale = []
        for f in glob.glob(str(DATA / "companies" / "*.json")):
            d = json.loads(Path(f).read_text(encoding="utf-8"))
            dates = d["prices"]["dates"]
            if not dates or dates[-1] < limit:
                stale.append(d["ticker"])
        if n and len(stale) / n > 0.05:
            problems.append(f"{len(stale)} entreprises ont un cours vieux de plus de 10 jours (ex. : {', '.join(stale[:5])}).")
        elif stale:
            warnings.append(f"{len(stale)} entreprise(s) avec un cours ancien : {', '.join(stale[:10])}.")
        ok.append(f"Entreprises : {scored}/{n} notées.")

    s = load("sectors.json")
    if s and len(s["views"]["commun"]["sectors"]) < 11:
        problems.append(f"Seulement {len(s['views']['commun']['sectors'])} secteurs sur 11.")

    # --- prévisions ---
    p = load("predictions/meta.json")
    if p:
        if p.get("demo"):
            problems.append("Les prévisions sont des données simulées.")
        if age_hours(p["updated"]) > max_age:
            problems.append(f"Prévisions non mises à jour depuis {age_hours(p['updated']):.0f} h (l'étape a probablement échoué).")
        else:
            ok.append("Prévisions recalculées.")

    status = "PROBLÈME" if problems else "OK"
    lines = [f"## Contrôle de santé des données : {status}", f"_{datetime.now(timezone.utc):%d/%m/%Y %H:%M} UTC_", ""]
    if problems:
        lines += ["### Problèmes", *[f"- {x}" for x in problems], ""]
    if warnings:
        lines += ["### Points d'attention", *[f"- {x}" for x in warnings], ""]
    lines += ["### Ce qui fonctionne", *[f"- {x}" for x in ok], "",
              "Le site continue d'afficher les dernières données valides. Relancez la collecte depuis l'onglet "
              "Actions (ou le bouton « Mettre à jour ») une fois la source rétablie ; ce ticket se fermera tout seul "
              "à la prochaine collecte sans problème."]
    text = "\n".join(lines)
    Path(report).write_text(text, encoding="utf-8")
    print(text)
    return 1 if problems else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default="sante.md")
    ap.add_argument("--max-age", type=float, default=3.0, help="âge maximal des fichiers, en heures")
    a = ap.parse_args()
    raise SystemExit(main(a.report, a.max_age))
