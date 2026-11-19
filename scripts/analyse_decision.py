"""
Les scores aident-ils à décider ? Tests sur le passé.

1. Baromètre macro (2005 -> aujourd'hui) : performance des actions dans les 12 mois
   qui suivent selon le niveau du score, stratégie simple « investi si score >= seuil ».
   Deux versions du score : celle du site (Min-Max sur tout l'historique, qui « connaît
   l'avenir ») et une version « en temps réel » (Min-Max sur les seules données passées).
2. Entreprises : test des critères de marché (dynamique et risque), seuls critères dont on
   a l'historique (5 ans de cours) : les mieux notées ont-elles mieux performé ensuite ?
3. Contrôles sur les données actuelles (lien avec les analystes, poids de la tendance...).

Écrit site/data/analyse.json et affiche un résumé.
Lancer : python scripts/analyse_decision.py           (tout)
         python scripts/analyse_decision.py --local   (sans téléchargement : parties 2 et 3)
"""

from __future__ import annotations

import argparse
import glob
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "site" / "data"
OUT = DATA / "analyse.json"


def r(x, n=2):
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else round(float(x), n)


def spearman(a: pd.Series, b: pd.Series) -> float:
    """Corrélation de rang (Spearman) sans dépendre de scipy."""
    m = a.notna() & b.notna()
    return a[m].rank().corr(b[m].rank())


def perf_stats(monthly_ret: pd.Series) -> dict:
    m = monthly_ret.dropna()
    if m.empty:
        return {}
    wealth = (1 + m).cumprod()
    years = len(m) / 12
    cagr = wealth.iloc[-1] ** (1 / years) - 1
    vol = m.std() * math.sqrt(12)
    dd = (wealth / wealth.cummax() - 1).min()
    return {"rendement_annuel": r(cagr * 100, 1), "volatilite": r(vol * 100, 1), "pire_baisse": r(dd * 100, 1),
            "ratio_rendement_risque": r(cagr / vol if vol else None, 2), "mois_investis_pct": None}


# ---------------------------------------------------------------------------
# 1. Baromètre macro
# ---------------------------------------------------------------------------
def realtime_score(macro: dict, zones: list[str], burn_in: int = 36) -> pd.Series:
    """Recalcule le score commun mois par mois avec un Min-Max sur les seules données
    disponibles à cette date (pas de connaissance du futur)."""
    dates = pd.to_datetime(macro["dates"])
    pillars = {p["id"]: p["weight"] for p in macro["pillars"]}
    per_pillar: dict[str, list] = {p: [] for p in pillars}
    for ind in macro["indicators"]:
        if ind["zone"] not in zones:
            continue
        x = pd.Series(ind["history"]["raw"], index=dates, dtype=float)
        if ind["method"] == "target":
            x = (x - ind["target"]).abs()
        lo, hi = x.expanding(burn_in).min(), x.expanding(burn_in).max()
        s = (x - lo) / (hi - lo) * 100
        if ind["method"] in ("target", "minmax_inverse"):
            s = 100 - s
        per_pillar[ind["pillar"]].append((s, ind["weight"]))
    pillar_scores = {}
    for p, items in per_pillar.items():
        if not items:
            continue
        num = sum(s.fillna(0) * w for s, w in items)
        den = sum(s.notna() * w for s, w in items)
        pillar_scores[p] = num / den.replace(0, np.nan)
    ps = pd.DataFrame(pillar_scores)
    w = pd.DataFrame({p: ps[p].notna() * pillars[p] for p in ps})
    return (ps.fillna(0) * w).sum(axis=1) / w.sum(axis=1).replace(0, np.nan)


def macro_tests(macro: dict) -> dict:
    import yfinance as yf
    out = {}
    tickers = {"US": "^GSPC", "EZ": "^STOXX50E"}
    px = {}
    for z, t in tickers.items():
        c = yf.download(t, start="2004-01-01", interval="1mo", auto_adjust=True, progress=False)["Close"]
        c = c.iloc[:, 0] if isinstance(c, pd.DataFrame) else c
        c.index = pd.to_datetime(c.index).to_period("M").to_timestamp()
        px[z] = c.groupby(level=0).last()
    prices = pd.DataFrame(px)
    prices["commun"] = prices[["US", "EZ"]].pct_change().mean(axis=1).add(1).cumprod()
    dates = pd.to_datetime(macro["dates"])
    for view, col in (("commun", "commun"), ("US", "US"), ("EZ", "EZ")):
        p = prices[col].dropna()
        ret_m = p.pct_change()
        fwd12 = p.shift(-12) / p - 1
        fwd6 = p.shift(-6) / p - 1
        # pire baisse dans les 12 mois suivants
        fwd_dd = pd.Series({d: (p.loc[d:].iloc[:13] / p.loc[d] - 1).min() for d in p.index}, dtype=float)
        site = pd.Series(macro["views"][view]["history"]["score"], index=dates, dtype=float)
        zones = {"commun": ["US", "EZ", "MONDE"], "US": ["US", "MONDE"], "EZ": ["EZ", "MONDE"]}[view]
        rt = realtime_score(macro, zones)
        res = {}
        for name, score in (("site", site), ("temps_reel", rt)):
            df = pd.DataFrame({"score": score, "fwd12": fwd12, "fwd6": fwd6, "dd": fwd_dd, "ret_next": ret_m.shift(-1)}).dropna(subset=["score"])
            d12 = df.dropna(subset=["fwd12"])
            buckets = pd.cut(d12["score"], [-1, 45, 55, 65, 101], labels=["< 45", "45-55", "55-65", "> 65"])
            table = d12.groupby(buckets, observed=False).agg(mois=("fwd12", "size"), perf_12m=("fwd12", "mean"),
                                                             pct_positif=("fwd12", lambda x: (x > 0).mean()),
                                                             pire_baisse_12m=("dd", "mean"))
            strategies = {"achat_conservation": perf_stats(df["ret_next"])}
            for th in (45, 50, 55):
                invested = (df["score"] >= th).astype(float)
                st = perf_stats(df["ret_next"] * invested)
                st["mois_investis_pct"] = r(invested.mean() * 100, 0)
                strategies[f"investi_si_score_{th}"] = st
            res[name] = {
                "correlation_score_perf12m": r(spearman(d12["score"], d12["fwd12"])),
                "correlation_variation3m_perf12m": r(spearman(d12["score"].diff(3), d12["fwd12"])),
                "par_niveau": [{"tranche": str(k), "mois": int(v.mois), "perf_12m": r(v.perf_12m * 100, 1),
                                "pct_positif": r(v.pct_positif * 100, 0), "pire_baisse_12m": r(v.pire_baisse_12m * 100, 1)}
                               for k, v in table.iterrows()],
                "strategies": strategies,
            }
        out[view] = res
    return out


# ---------------------------------------------------------------------------
# 2. Entreprises : test des critères de marché sur 5 ans de cours hebdomadaires
# ---------------------------------------------------------------------------
def company_tests() -> dict:
    closes, sectors = {}, {}
    for f in glob.glob(str(DATA / "companies" / "*.json")):
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        if len(d["prices"]["dates"]) > 150:
            closes[d["ticker"]] = pd.Series(d["prices"]["close"], index=pd.to_datetime(d["prices"]["dates"]), dtype=float)
            sectors[d["ticker"]] = d["sector"]
    W = pd.DataFrame(closes).sort_index()
    sec = pd.Series(sectors)
    rets = W.pct_change(fill_method=None)
    results = []
    for k in range(60, len(W) - 52, 4):  # une date tous les 4 semaines, avec 52 semaines d'avenir
        p = W.iloc[: k + 1]
        last = p.iloc[-1]
        f = pd.DataFrame({
            "mom": p.iloc[-5] / p.iloc[-53] - 1,                      # 12 mois hors dernier mois
            "m3": last / p.iloc[-14] - 1,
            "ma": last / p.iloc[-40:].mean() - 1,                     # ~200 jours
            "vol": rets.iloc[k - 51: k + 1].std(),
            "dd": (p.iloc[-52:] / p.iloc[-52:].cummax() - 1).min(),
            "fwd": W.iloc[k + 52] / last - 1,
            "sector": sec,
        }).dropna()
        if len(f) < 200:
            continue
        rank = lambda c, asc=True: f.groupby("sector")[c].rank(pct=True, ascending=asc)  # noqa: E731
        f["dynamique"] = (rank("mom") + rank("m3") + rank("ma")) / 3
        f["risque"] = (rank("vol", False) + rank("dd")) / 2
        f["combine"] = (f["dynamique"] + f["risque"]) / 2
        f["fwd_rel"] = f["fwd"] - f.groupby("sector")["fwd"].transform("median")   # perf. relative au secteur
        row = {"date": W.index[k].strftime("%Y-%m-%d")}
        for c in ("dynamique", "risque", "combine"):
            q = pd.qcut(f[c], 5, labels=False, duplicates="drop")
            g = f.groupby(q)
            row[c] = {"ic": spearman(f[c], f["fwd"]),
                      "top_moins_bas": g["fwd"].mean().iloc[-1] - g["fwd"].mean().iloc[0],
                      "top_moins_bas_relatif": g["fwd_rel"].mean().iloc[-1] - g["fwd_rel"].mean().iloc[0],
                      "vol_top": f.loc[q == q.max(), "fwd"].std(), "vol_bas": f.loc[q == q.min(), "fwd"].std()}
        results.append(row)
    out = {"nb_dates": len(results), "periode": [results[0]["date"], results[-1]["date"]] if results else None}
    for c in ("dynamique", "risque", "combine"):
        ics = [x[c]["ic"] for x in results]
        spread = [x[c]["top_moins_bas"] for x in results]
        rel = [x[c]["top_moins_bas_relatif"] for x in results]
        out[c] = {"correlation_moyenne": r(np.mean(ics), 3), "pct_dates_correlation_positive": r(np.mean(np.array(ics) > 0) * 100, 0),
                  "ecart_quintiles_perf12m": r(np.mean(spread) * 100, 1), "ecart_quintiles_relatif_secteur": r(np.mean(rel) * 100, 1),
                  "dispersion_top": r(np.mean([x[c]["vol_top"] for x in results]) * 100, 1),
                  "dispersion_bas": r(np.mean([x[c]["vol_bas"] for x in results]) * 100, 1)}
    return out


# ---------------------------------------------------------------------------
# 3. Contrôles sur les données actuelles
# ---------------------------------------------------------------------------
def current_checks() -> dict:
    rows = []
    for f in glob.glob(str(DATA / "companies" / "*.json")):
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        up = (d["target_price"] / d["price"] - 1) * 100 if d.get("target_price") and d.get("price") else np.nan
        rows.append({"score": d["score"], "upside": up, "p1y": d["perf"]["perf_1y"], "reco": d.get("recommendation"),
                     **{f"f_{k}": v for k, v in d["families"].items()}})
    df = pd.DataFrame(rows).dropna(subset=["score"])
    sectors = json.loads((DATA / "sectors.json").read_text(encoding="utf-8"))
    s = pd.DataFrame(sectors["views"]["commun"]["sectors"])
    m = sectors["method"]
    alt = s["company_score"]  # classement 100 % entreprises
    fam = df[[c for c in df if c.startswith("f_")]]
    return {
        "correlation_score_potentiel_analystes": r(spearman(df["score"], df["upside"])),
        "correlation_score_perf_passee_1an": r(spearman(df["score"], df["p1y"])),
        "score_moyen_par_recommandation": {k: r(v, 1) for k, v in df.groupby("reco")["score"].mean().items()},
        "correlations_entre_familles": {f"{a}/{b}": r(fam[a].corr(fam[b]), 2) for i, a in enumerate(fam) for b in list(fam)[i + 1:]},
        "secteurs_poids_tendance": m["trend_weight"],
        "secteurs_correlation_classement_avec_vs_sans_tendance": r(spearman(s["score"], alt)),
        "secteurs_ecart_type_part_entreprises": r(s["company_score"].std(), 1),
        "secteurs_ecart_type_part_tendance": r(s["trend_score"].std(), 1),
    }


def main(local: bool) -> None:
    out = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if not local:
        macro = json.loads((DATA / "macro.json").read_text(encoding="utf-8"))
        out["macro"] = macro_tests(macro)
    out["entreprises"] = company_tests()
    out["controles"] = current_checks()
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--local", action="store_true")
    main(p.parse_args().local)
