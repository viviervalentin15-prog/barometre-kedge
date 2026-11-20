"""Tests du compte rendu de portefeuille (lancer : python3 tests/test_portfolio.py)."""
import json, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import portfolio as pf

# 1. lecture de la variable
for raw in ("", "[]", "{pas du json", None, "{}"):
    assert pf.load_holdings(raw) == [], raw

# 2. valorisation sur des données de test
d = Path(tempfile.mkdtemp())
(d / "companies").mkdir(); (d / "predictions").mkdir()
(d / "companies.json").write_text(json.dumps({"eurusd": 1.10, "companies": []}))
(d / "macro.json").write_text(json.dumps({"views": {"commun": {"latest": {"date": "2026-11", "score": 64.4, "signal": {"label": "Plutôt favorable"}, "trend": {"label": "En dégradation"}, "delta_3m": -8.7}}}}))
(d / "companies" / "TTE_PA.json").write_text(json.dumps({
    "ticker": "TTE.PA", "name": "TotalEnergies SE", "currency": "EUR", "price": 110.0, "score": 70.3,
    "score_history": {"dates": ["2026-11-13", "2026-11-20"], "score": [69.1, 70.3]},
    "recommendation": "buy", "target_price": 121.0,
    "prices": {"dates": ["2026-10-30", "2026-11-06", "2026-11-13"], "close": [100.0, 104.0, 108.0]}}))
(d / "predictions" / "TTE_PA.json").write_text(json.dumps({"h": {"1a": {"p": 0.54, "fiabilite": 0.52}, "3a": {"p": 0.61, "fiabilite": 0.58}}}))
holdings = [
    {"id": "1", "ticker": "TTE.PA", "amount": 3000, "platform": "Boursorama", "date": "2026-11-01"},   # dimanche -> cours du 30/10
    {"id": "2", "ticker": "TTE.PA", "amount": 1000, "platform": "Trade Republic", "date": "2020-01-02"}, # avant l'historique
    {"id": "3", "ticker": "XXX", "amount": 500, "platform": "Boursorama", "date": "2026-11-02"},         # plus de fiche
]
rep = pf.valuate(holdings, d)
l1, l2, l3 = rep["lines"]
assert l1["status"] == "ok" and l1["buy_price"] == 100.0, l1
assert abs(l1["perf"] - 0.10) < 1e-9 and abs(l1["value"] - 3300) < 1e-6, l1
assert l1["score"] == 70.3 and abs(l1["score_delta"] - 1.2) < 1e-9
assert l1["reco"] == "Achat" and abs(l1["upside"] - 0.10) < 1e-9
assert l1["pred"]["1a"]["p"] == 0.54 and l1["pred"]["3a"]["fiabilite"] == 0.58
assert l2["status"] == "cours d'achat indisponible", l2
assert l3["status"] == "indisponible", l3
assert rep["totals"]["invested"] == 3000 and abs(rep["totals"]["value"] - 3300) < 1e-6, rep["totals"]
assert abs(rep["platforms"]["Boursorama"] - 3300) < 1e-6 and "Trade Republic" not in rep["platforms"]

# 3. mise en forme du mail
subject, text, html = pf.render(rep)
assert subject.startswith("Baromètre KEDGE · Portefeuille au "), subject
for s in ("TotalEnergies", "Boursorama", "Analystes", "Prévisions", "indisponible", "change"):
    assert s in text, s
assert "<html" in html.lower() and "TotalEnergies" in html

# 4. portefeuille vide : aucun envoi
class Boom:
    def __init__(self, *a, **k): raise AssertionError("SMTP ne doit pas être appelé")
pf.smtplib.SMTP_SSL = Boom
os.environ["PORTFOLIO"] = "[]"
assert pf.main(data_dir=d) == 0
print("test_portfolio : OK")
