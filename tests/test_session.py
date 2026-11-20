"""Indicateur de séance (ouverture -> clôture). Lancer : python3 tests/test_session.py"""
import sys
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_companies import session_metrics

idx = pd.date_range("2026-11-02", periods=14, freq="B")
o = pd.Series([100.0] * 14, index=idx)
c = pd.Series([101.0] * 12 + [99.0, 102.0], index=idx)
m = session_metrics(o, c)
assert m["date"] == "2026-11-19", m
assert abs(m["last"] - 2.0) < 1e-9, m                               # 100 -> 102
assert abs(m["avg12"] - (10 * 1.0 - 1.0 + 2.0) / 12) < 1e-9, m       # 12 dernières séances

# séance du jour incomplète (ouverture connue, clôture manquante) : on garde la dernière séance complète
o2 = o.copy(); c2 = c.copy(); c2.iloc[-1] = np.nan
m2 = session_metrics(o2, c2)
assert m2["date"] == "2026-11-18" and abs(m2["last"] + 1.0) < 1e-9, m2

# ouverture nulle ou aberrante ignorée ; moins de 12 séances -> moyenne sur ce qui existe ; rien -> {}
o3 = pd.Series([0.0, 100.0, 100.0], index=idx[:3]); c3 = pd.Series([5.0, 103.0, 97.0], index=idx[:3])
m3 = session_metrics(o3, c3)
assert abs(m3["last"] + 3.0) < 1e-9 and abs(m3["avg12"] - 0.0) < 1e-9 and m3["n"] == 2, m3
assert session_metrics(pd.Series(dtype=float), pd.Series(dtype=float)) == {}
print("test_session : OK")

# séance du jour en cours (collecte lancée avant la fermeture des marchés) : exclue
from datetime import datetime, timezone
day = pd.Timestamp("2026-11-19")
m4 = session_metrics(o, c, now=datetime(2026, 11, 19, 14, 40, tzinfo=timezone.utc))
assert m4["date"] == "2026-11-18", m4
m5 = session_metrics(o, c, now=datetime(2026, 11, 19, 22, 30, tzinfo=timezone.utc))
assert m5["date"] == "2026-11-19", m5
print("test_session (séance en cours) : OK")
