"""
Prévisions à 6 mois, 1 an et 3 ans — SÉPARÉES du score.

Question posée à chaque modèle, pour chaque horizon :
    « Quelle est la probabilité que l'entreprise fasse mieux que la médiane de son secteur ? »

Modèles
  Fondés sur les cours (20 ans d'historique hebdomadaire, testés hors échantillon) :
    dynamique      : tendance sur 12 mois hors dernier mois (momentum)
    retournement   : performance sur 3 ans (les grands gagnants tendent à se retourner)
    faible_risque  : volatilité et pire baisse sur 1 an (faibles = mieux)
    apprentissage  : gradient boosting (scikit-learn) sur tous les signaux de cours + baromètre macro
  Fondés sur les comptes annuels (4-5 ans d'historique Yahoo, testés quand c'est possible) :
    valeur         : rendement des bénéfices, des ventes et de l'actif net (inverse des multiples)
    qualite        : rentabilité, marge, faible endettement, stabilité de la rentabilité, croissance

Méthode
  - à chaque date passée, chaque signal est classé dans le secteur (rang 0 à 1) ;
  - une régression logistique transforme ce rang en probabilité de surperformer, apprise
    UNIQUEMENT sur des dates dont le résultat était déjà connu (pas de connaissance du futur) ;
  - fiabilité = part de bonnes prévisions sur ces tests hors échantillon (+ AUC) ;
  - synthèse = moyenne des modèles pondérée par leur pouvoir prédictif mesuré (AUC - 0,5).
  - cône de cours : volatilité EWMA (méthode RiskMetrics) et rendement historique du marché.

Limites (affichées sur le site) : univers actuel (biais du survivant), capitalisations passées
approchées par l'évolution du cours, peu de recul sur les comptes à 3 ans.

Lancer : python scripts/build_predictions.py [--demo]
"""

from __future__ import annotations

import argparse
import json
import math
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "site" / "data"
RAW = ROOT / "data" / "raw"
OUT = DATA / "predictions.json"

HORIZONS = {"6m": 26, "1a": 52, "3a": 156}          # en semaines
HORIZON_LABEL = {"6m": "6 mois", "1a": "1 an", "3a": "3 ans"}
STEP = 4                                             # une date de test toutes les 4 semaines
MODELS = {
    "dynamique": "Dynamique (momentum 12 mois)",
    "retournement": "Retournement de long terme (3 ans)",
    "faible_risque": "Faible risque (volatilité, pire baisse)",
    "apprentissage": "Apprentissage automatique (gradient boosting)",
    "valeur": "Valeur (bénéfices, ventes, actif net / prix)",
    "qualite": "Qualité (rentabilité, marge, dette, stabilité, croissance)",
}
PRICE_MODELS = ["dynamique", "retournement", "faible_risque", "apprentissage"]
FUND_MODELS = ["valeur", "qualite"]


def log(*a):
    print(*a, flush=True)


def rnd(x, n=3):
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else round(x, n)


def sector_rank(values: pd.Series, sectors: pd.Series, ascending: bool = True) -> pd.Series:
    return values.groupby(sectors).rank(pct=True, ascending=ascending)


# ---------------------------------------------------------------------------
# Données
# ---------------------------------------------------------------------------
def load_universe() -> pd.DataFrame:
    c = json.loads((DATA / "companies.json").read_text(encoding="utf-8"))
    df = pd.DataFrame(c["companies"])[["t", "n", "s", "z", "cap"]]
    return df.set_index("t")


def weekly_prices(tickers: list[str], demo: bool) -> pd.DataFrame:
    if demo:
        idx = pd.date_range(end=pd.Timestamp.today(), periods=1040, freq="W-FRI")
        out = {}
        for t in tickers:
            rng = np.random.default_rng(zlib.crc32(t.encode()))
            mu, vol = rng.normal(0.0015, 0.001), rng.uniform(0.02, 0.05)
            # un peu de persistance pour que la dynamique ait un léger pouvoir prédictif
            shocks = rng.normal(0, vol, len(idx))
            drift = np.convolve(shocks, np.ones(20) / 20, mode="same") * 0.15
            out[t] = 100 * np.exp(np.cumsum(mu + shocks + drift))
        return pd.DataFrame(out, index=idx)
    import yfinance as yf
    yf.set_tz_cache_location("/tmp/yf-cache")
    frames = []
    for k in range(0, len(tickers), 100):
        chunk = tickers[k:k + 100]
        for attempt in range(3):
            try:
                px = yf.download(chunk, period="20y", interval="1wk", auto_adjust=True, progress=False, threads=False)["Close"]
                frames.append(px if isinstance(px, pd.DataFrame) else px.to_frame(chunk[0]))
                break
            except Exception as e:  # noqa: BLE001
                log(f"  cours 20 ans, lot {k}: {e}")
                time.sleep(5 * (attempt + 1))
        log(f"  cours 20 ans : {min(k + 100, len(tickers))}/{len(tickers)}")
    p = pd.concat(frames, axis=1)
    p.index = pd.to_datetime(p.index).tz_localize(None)
    p = p.resample("W-FRI").last()
    return p.loc[:, ~p.columns.duplicated()]


STATEMENT_FIELDS = {
    "income": {"Net Income": "ni", "Total Revenue": "rev"},
    "balance": {"Stockholders Equity": "eq", "Common Stock Equity": "eq2", "Total Debt": "debt"},
}


def fetch_statements(tickers: list[str], demo: bool, max_age_days: int = 30) -> dict:
    """Comptes annuels (4-5 ans) : résultat net, chiffre d'affaires, fonds propres, dette.
    Mis en cache 30 jours : les comptes ne changent qu'une fois par an."""
    path = RAW / "statements.json"
    cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if demo:
        out = {}
        for t in tickers:
            rng = np.random.default_rng(zlib.crc32(("s" + t).encode()))
            years = [f"{y}-12-31" for y in range(2021, 2026)]
            rev = 1e9 * rng.uniform(1, 50) * np.cumprod(1 + rng.normal(0.05, 0.08, 5))
            margin = rng.normal(0.1, 0.06)
            eq = rev * rng.uniform(0.3, 1.5)
            out[t] = {d: {"ni": float(r * (margin + rng.normal(0, 0.02))), "rev": float(r), "eq": float(e), "debt": float(e * rng.uniform(0, 1.5))}
                      for d, r, e in zip(years, rev, eq)}
        return out
    import yfinance as yf
    now = time.time()
    todo = [t for t in tickers if now - cache.get(t, {}).get("_fetched", 0) > max_age_days * 86400]
    log(f"Comptes annuels : {len(todo)} entreprises à interroger ({len(tickers) - len(todo)} en cache)")
    fails = 0
    for k, t in enumerate(todo, 1):
        try:
            tk = yf.Ticker(t)
            rows = {}
            for kind, df in (("income", tk.income_stmt), ("balance", tk.balance_sheet)):
                if df is None or df.empty:
                    continue
                for label, key in STATEMENT_FIELDS[kind].items():
                    if label in df.index:
                        for col, v in df.loc[label].items():
                            if pd.notna(v):
                                rows.setdefault(pd.Timestamp(col).strftime("%Y-%m-%d"), {})[key] = float(v)
            for d in rows.values():
                if "eq" not in d and "eq2" in d:
                    d["eq"] = d["eq2"]
                d.pop("eq2", None)
            cache[t] = {"_fetched": now, **rows}
        except Exception:  # noqa: BLE001
            fails += 1
        if k % 100 == 0:
            log(f"  {k}/{len(todo)} (échecs : {fails})")
            path.write_text(json.dumps(cache), encoding="utf-8")
        time.sleep(0.2)
    RAW.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache), encoding="utf-8")
    return {t: {d: v for d, v in cache.get(t, {}).items() if d != "_fetched"} for t in tickers}


# ---------------------------------------------------------------------------
# Signaux à une date (indice k de la grille hebdomadaire)
# ---------------------------------------------------------------------------
def price_features(P: pd.DataFrame, R: pd.DataFrame, k: int) -> pd.DataFrame:
    last = P.iloc[k]
    f = pd.DataFrame({
        "mom": P.iloc[k - 4] / P.iloc[k - 52] - 1,
        "m6": last / P.iloc[k - 26] - 1,
        "rev36": last / P.iloc[k - 156] - 1,
        "vol": R.iloc[k - 51:k + 1].std(),
        "dd": (P.iloc[k - 51:k + 1] / P.iloc[k - 51:k + 1].cummax() - 1).min(),
        "ma": last / P.iloc[k - 39:k + 1].mean() - 1,
        "hi52": last / P.iloc[k - 51:k + 1].max() - 1,
    })
    return f


def fundamental_features(stmts: dict, caps_now: pd.Series, P: pd.DataFrame, k: int, sectors: pd.Series) -> pd.DataFrame:
    """Signaux comptables connus à la date k : derniers comptes publiés depuis plus de 90 jours."""
    date = P.index[k]
    rows = {}
    for t, years in stmts.items():
        if t not in P or pd.isna(P[t].iloc[k]) or pd.isna(P[t].iloc[-1]) or t not in caps_now.index:
            continue
        known = sorted(d for d in years if pd.Timestamp(d) <= date - pd.Timedelta(days=90))
        if not known:
            continue
        cur = years[known[-1]]
        cap = caps_now[t] * 1e9 * P[t].iloc[k] / P[t].iloc[-1]   # capitalisation approchée à la date
        if not cap or cap <= 0:
            continue
        roes = [years[d]["ni"] / years[d]["eq"] for d in known if years[d].get("eq") and years[d].get("ni") is not None and years[d]["eq"] > 0]
        revs = [years[d].get("rev") for d in known if years[d].get("rev")]
        rows[t] = {
            "ey": cur.get("ni", np.nan) / cap,
            "sy": cur.get("rev", np.nan) / cap,
            "by": cur.get("eq", np.nan) / cap,
            "roe": roes[-1] if roes else np.nan,
            "margin": cur.get("ni", np.nan) / cur["rev"] if cur.get("rev") else np.nan,
            "lev": cur.get("debt", np.nan) / cur["eq"] if cur.get("eq") and cur["eq"] > 0 else np.nan,
            "roe_stab": -np.std(roes) if len(roes) >= 3 else np.nan,
            "growth": (revs[-1] / revs[0]) ** (1 / (len(revs) - 1)) - 1 if len(revs) >= 3 and revs[0] > 0 else np.nan,
        }
    return pd.DataFrame.from_dict(rows, orient="index", dtype=float)


def model_signals(pf: pd.DataFrame | None, ff: pd.DataFrame | None, sectors: pd.Series) -> pd.DataFrame:
    """Rang dans le secteur (0 à 1, haut = favorable) de chaque modèle simple."""
    out = {}
    if pf is not None and not pf.empty:
        s = sectors.reindex(pf.index)
        out["dynamique"] = sector_rank(pf["mom"], s)
        out["retournement"] = sector_rank(pf["rev36"], s, ascending=False)     # grands gagnants = défavorable
        out["faible_risque"] = (sector_rank(pf["vol"], s, False) + sector_rank(pf["dd"], s)) / 2
    if ff is not None and not ff.empty:
        s = sectors.reindex(ff.index)
        out["valeur"] = pd.concat([sector_rank(ff[c], s) for c in ("ey", "sy", "by")], axis=1).mean(axis=1)
        out["qualite"] = pd.concat([sector_rank(ff["roe"], s), sector_rank(ff["margin"], s), sector_rank(ff["lev"], s, False),
                                    sector_rank(ff["roe_stab"], s), sector_rank(ff["growth"], s)], axis=1).mean(axis=1)
    return pd.DataFrame(out)


def ml_matrix(pf: pd.DataFrame, sectors: pd.Series, macro_score: float) -> pd.DataFrame:
    s = sectors.reindex(pf.index)
    X = pd.DataFrame({c: sector_rank(pf[c], s) for c in pf.columns})
    X["macro"] = macro_score
    return X


# ---------------------------------------------------------------------------
# Calibration et tests hors échantillon
# ---------------------------------------------------------------------------
def fit_logit(x: np.ndarray, y: np.ndarray):
    from sklearn.linear_model import LogisticRegression
    m = LogisticRegression(C=1.0)
    m.fit((x - 0.5).reshape(-1, 1), y)
    return m


def evaluate(p: np.ndarray, y: np.ndarray) -> dict:
    from sklearn.metrics import roc_auc_score
    if len(y) < 200 or len(set(y)) < 2:
        return {"acc": None, "auc": None, "n": int(len(y))}
    return {"acc": float(((p > 0.5) == (y == 1)).mean()), "auc": float(roc_auc_score(y, p)), "n": int(len(y))}


def run(demo: bool) -> None:
    from sklearn.ensemble import HistGradientBoostingClassifier

    uni = load_universe()
    tickers = uni.index.tolist()
    sectors = uni["s"]
    log(f"{len(tickers)} entreprises")
    P = weekly_prices(tickers, demo)
    P = P[[t for t in tickers if t in P]].dropna(how="all")
    R = P.pct_change(fill_method=None).clip(-0.6, 1.5)
    stmts = fetch_statements(tickers, demo)
    log(f"Cours hebdomadaires : {P.shape[0]} semaines ({P.index[0]:%Y-%m} -> {P.index[-1]:%Y-%m}), comptes pour {sum(bool(v) for v in stmts.values())} entreprises")

    macro = json.loads((DATA / "macro.json").read_text(encoding="utf-8"))
    mseries = pd.Series(macro["views"]["commun"]["history"]["score"], index=pd.to_datetime(macro["dates"]), dtype=float)

    def macro_at(date):
        x = mseries[mseries.index <= date].dropna()
        return float(x.iloc[-1]) if len(x) else 50.0

    n = len(P)
    first = 160
    dates_k = sorted(range(n - 1, first - 1, -STEP))   # grille alignée sur aujourd'hui
    # Signaux et résultats à chaque date
    snapshots = {}
    for k in dates_k:
        pf = price_features(P, R, k).dropna()
        ff = fundamental_features(stmts, uni["cap"], P, k, sectors) if (n - 1 - k) % 12 == 0 else None   # trimestriel
        sig = model_signals(pf, ff, sectors)
        X = ml_matrix(pf, sectors, macro_at(P.index[k])) if not pf.empty else None
        outcomes = {}
        for h, w in HORIZONS.items():
            if k + w < n:
                fwd = P.iloc[k + w] / P.iloc[k] - 1
                s = sectors.reindex(fwd.dropna().index)
                outcomes[h] = (fwd.dropna() > fwd.dropna().groupby(s).transform("median")).astype(int)
        snapshots[k] = {"sig": sig, "X": X, "y": outcomes, "has_fund": ff is not None and not ff.empty}
    log(f"{len(snapshots)} dates d'analyse, dont {sum(s['has_fund'] for s in snapshots.values())} avec comptes")

    now_k = n - 1
    result_models, current = {}, {h: {} for h in HORIZONS}
    for h, w in HORIZONS.items():
        result_models[h] = {}
        labelled = [k for k in dates_k if h in snapshots[k]["y"]]
        # --- modèles simples : logistique sur le rang, apprise sur le passé seulement ---
        for mid in [m for m in MODELS if m != "apprentissage"]:
            usable = [k for k in labelled if mid in snapshots[k]["sig"]]
            arrays = {k: _xy(snapshots, [k], mid, h) for k in usable}
            preds, ys, m, last_fit = [], [], None, -10**9
            for k in usable:
                train = [j for j in usable if j + w <= k]
                if len(train) < (2 if mid in FUND_MODELS else 12):
                    continue
                if m is None or k - last_fit >= 26:          # réapprentissage tous les 6 mois
                    x_tr = np.concatenate([arrays[j][0] for j in train]); y_tr = np.concatenate([arrays[j][1] for j in train])
                    if len(set(y_tr)) < 2:
                        continue
                    m, last_fit = fit_logit(x_tr, y_tr), k
                x_te, y_te = arrays[k]
                preds.append(m.predict_proba((x_te - 0.5).reshape(-1, 1))[:, 1]); ys.append(y_te)
            oos = evaluate(np.concatenate(preds), np.concatenate(ys)) if preds else {"acc": None, "auc": None, "n": 0}
            oos["hors_echantillon"] = bool(preds)
            x_all = np.concatenate([arrays[k][0] for k in usable]) if usable else np.array([])
            y_all = np.concatenate([arrays[k][1] for k in usable]) if usable else np.array([])
            if not preds and usable and len(set(y_all)) == 2:  # trop peu de recul : mesure dans l'échantillon (optimiste)
                m_in = fit_logit(x_all, y_all)
                oos = {**evaluate(m_in.predict_proba((x_all - 0.5).reshape(-1, 1))[:, 1], y_all), "hors_echantillon": False}
            oos["dates"] = len(usable)
            result_models[h][mid] = oos
            # prévision actuelle : modèle appris sur toutes les dates dont le résultat est connu
            if usable and mid in snapshots[now_k]["sig"] and len(set(y_all)) == 2:
                m = fit_logit(x_all, y_all)
                xs = snapshots[now_k]["sig"][mid].dropna()
                current[h][mid] = pd.Series(m.predict_proba((xs.values - 0.5).reshape(-1, 1))[:, 1], index=xs.index)
        # --- apprentissage automatique : réentraîné une fois par an sur le passé ---
        usable = [k for k in labelled if snapshots[k]["X"] is not None]
        mats = {k: _xy_ml(snapshots, [k], h) for k in usable}
        preds, ys, model, last_fit = [], [], None, -10**9
        for k in usable:
            train = [j for j in usable if j + w <= k]
            if len(train) < 24:
                continue
            if k - last_fit >= 52 or model is None:
                Xtr = np.concatenate([mats[j][0] for j in train]); ytr = np.concatenate([mats[j][1] for j in train])
                model = HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05, max_leaf_nodes=15, l2_regularization=1.0, early_stopping=False, random_state=0)
                model.fit(Xtr, ytr)
                last_fit = k
            Xte, yte = mats[k]
            preds.append(model.predict_proba(Xte)[:, 1]); ys.append(yte)
        res = evaluate(np.concatenate(preds), np.concatenate(ys)) if preds else {"acc": None, "auc": None, "n": 0}
        res["hors_echantillon"] = bool(preds)
        res["dates"] = len(usable)
        result_models[h]["apprentissage"] = res
        if usable:
            Xall = np.concatenate([mats[k][0] for k in usable]); yall = np.concatenate([mats[k][1] for k in usable])
            model = HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05, max_leaf_nodes=15, l2_regularization=1.0, early_stopping=False, random_state=0).fit(Xall, yall)
            Xn = snapshots[now_k]["X"].dropna()
            current[h]["apprentissage"] = pd.Series(model.predict_proba(Xn.values)[:, 1], index=Xn.index)
        log(f"[{HORIZON_LABEL[h]}] " + " | ".join(f"{m}: {_fmt(result_models[h][m])}" for m in MODELS))

    # --- synthèse : pondération par le pouvoir prédictif mesuré (AUC - 0,5) ---
    weights = {h: {m: _weight(result_models[h][m]) for m in MODELS} for h in HORIZONS}
    # --- cône de cours : volatilité EWMA (RiskMetrics) + rendement historique du marché de la zone ---
    lam = 0.97
    ew = (R.iloc[-156:] ** 2).ewm(alpha=1 - lam).mean().iloc[-1] ** 0.5 * math.sqrt(52)
    sectors_json = json.loads((DATA / "sectors.json").read_text(encoding="utf-8"))
    drift = {}
    for z, b in sectors_json.get("benchmarks", {}).items():
        v = [x for x in b["values"] if x]
        drift[z] = (v[-1] / v[0]) ** (52 / max(1, len(v) - 1)) - 1 if len(v) > 52 else 0.06
    companies = {}
    for t in tickers:
        hz = {}
        for h, w in HORIZONS.items():
            ms = []
            for mid in MODELS:
                p = current[h].get(mid, pd.Series(dtype=float)).get(t)
                st = result_models[h][mid]
                ms.append({"id": mid, "p": rnd(p, 3), "acc": rnd(st.get("acc"), 3), "auc": rnd(st.get("auc"), 3), "oos": st.get("hors_echantillon")})
            valid = [(m["p"], weights[h][m["id"]], m["acc"]) for m in ms if m["p"] is not None and weights[h][m["id"]] > 0]
            if valid:
                wsum = sum(v[1] for v in valid)
                p_syn = sum(v[0] * v[1] for v in valid) / wsum
                rel = sum((v[2] or 0.5) * v[1] for v in valid) / wsum
                ps = [m["p"] for m in ms if m["p"] is not None]
                agree = 1 - min(1.0, float(np.std(ps)) / 0.1) if len(ps) > 1 else None
                up = sum(1 for m in ms if m["p"] is not None and m["p"] > 0.5)
            else:
                p_syn = rel = agree = None
                up = 0
            vol = float(ew.get(t, np.nan)) if t in ew else np.nan
            yrs = w / 52
            mu = drift.get(uni.loc[t, "z"], 0.06)
            cone = None
            if not math.isnan(vol) and t in P and pd.notna(P[t].iloc[-1]):
                m_log = math.log(1 + mu) * yrs - 0.5 * vol ** 2 * yrs
                sd = vol * math.sqrt(yrs)
                cone = {"q10": rnd(math.exp(m_log - 1.2816 * sd) - 1, 3), "q50": rnd(math.exp(m_log) - 1, 3), "q90": rnd(math.exp(m_log + 1.2816 * sd) - 1, 3)}
            hz[h] = {"models": ms, "p": rnd(p_syn, 3), "fiabilite": rnd(rel, 3), "accord": rnd(agree, 2),
                     "favorables": up, "nb_modeles": sum(1 for m in ms if m["p"] is not None), "cone": cone}
        companies[t] = {"vol": rnd(ew.get(t), 3), "h": hz}

    out = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "demo": demo,
        "question": "Probabilité de faire mieux que la médiane de son secteur",
        "horizons": [{"id": h, "label": HORIZON_LABEL[h], "weeks": w} for h, w in HORIZONS.items()],
        "models": [{"id": m, "label": MODELS[m], "type": "cours" if m in PRICE_MODELS else "comptes"} for m in MODELS],
        "stats": {h: {m: {k: (rnd(v) if isinstance(v, float) else v) for k, v in st.items()} for m, st in result_models[h].items()} for h in HORIZONS},
        "weights": {h: {m: rnd(v) for m, v in weights[h].items()} for h in HORIZONS},
        "periode": [f"{P.index[first]:%Y-%m}", f"{P.index[-1]:%Y-%m}"],
        "drift": {z: rnd(v) for z, v in drift.items()},
        "market": market_valuation(demo),
        "companies": companies,
    }
    write_split(out)
    log(f"Prévisions écrites pour {len(companies)} entreprises")


def write_split(out: dict) -> None:
    """Un petit fichier par entreprise (chargé seulement quand on ouvre sa fiche ou un pool)
    + un fichier commun (modèles, fiabilités, horizons). Bien plus léger qu'un seul gros fichier."""
    import re
    folder = DATA / "predictions"
    folder.mkdir(parents=True, exist_ok=True)
    for f in folder.glob("*.json"):
        f.unlink()
    for t, c in out["companies"].items():
        slim = {"vol": c["vol"], "h": {h: {**v, "models": [{"id": m["id"], "p": m["p"]} for m in v["models"]]} for h, v in c["h"].items()}}
        (folder / f"{re.sub(r'[^A-Za-z0-9]', '_', t)}.json").write_text(json.dumps(slim, separators=(",", ":")), encoding="utf-8")
    meta = {k: v for k, v in out.items() if k != "companies"}
    (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if OUT.exists():
        OUT.unlink()


def market_valuation(demo: bool) -> dict:
    """Prévision du marché à long terme par la valorisation (séparée du score).
    Rendement des bénéfices du marché (E/P, inverse du PER agrégé, pondéré par la capitalisation)
    = rendement réel attendu à long terme (relation de Campbell et Shiller).
    Prime de risque = E/P - taux réel à 10 ans. Les entreprises en perte comptent pour un bénéfice nul."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    comp = json.loads((DATA / "companies.json").read_text(encoding="utf-8"))["companies"]
    out = {}
    rates = {}
    if demo:
        rates = {"US": {"nominal": 4.2, "real": 1.9, "inflation": 2.3}, "EZ": {"nominal": 2.6, "real": 0.6, "inflation": 2.0}}
    else:
        import sources
        try:
            us_n, us_r, us_be = sources.fred("DGS10").iloc[-1], sources.fred("DFII10").iloc[-1], sources.fred("T10YIE").iloc[-1]
            rates["US"] = {"nominal": float(us_n), "real": float(us_r), "inflation": float(us_be)}
        except Exception as e:  # noqa: BLE001
            log(f"ECHEC taux américains pour la prévision de marché : {e}")
        try:
            ez_n = float(sources.ecb("YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y").iloc[-1])
            # pas de taux réel gratuit pour la zone euro : taux AAA 10 ans moins la cible de 2 % de la BCE
            rates["EZ"] = {"nominal": ez_n, "real": ez_n - 2.0, "inflation": 2.0, "approx": True}
        except Exception as e:  # noqa: BLE001
            log(f"ECHEC taux zone euro pour la prévision de marché : {e}")
    for z in ("US", "EZ"):
        rows = [c for c in comp if c["z"] == z and c.get("cap")]
        earn = sum(c["cap"] / c["pe"] for c in rows if c.get("pe"))
        cap = sum(c["cap"] for c in rows if c.get("pe") or c.get("loss"))
        if not cap:
            continue
        ey = earn / cap * 100
        r = rates.get(z, {})
        erp = ey - r["real"] if "real" in r else None
        out[z] = {"pe": rnd(100 / ey, 1), "earnings_yield": rnd(ey, 2), "real_yield": rnd(r.get("real"), 2),
                  "nominal_yield": rnd(r.get("nominal"), 2), "inflation": rnd(r.get("inflation"), 2),
                  "expected_real": rnd(ey, 2), "expected_nominal": rnd(ey + r["inflation"], 2) if "inflation" in r else None,
                  "erp": rnd(erp, 2), "approx_real": bool(r.get("approx")), "n": len(rows)}
    return out


def _xy(snapshots, ks, mid, h):
    xs, ys = [], []
    for k in ks:
        sig = snapshots[k]["sig"][mid].dropna()
        y = snapshots[k]["y"].get(h)
        if y is None:
            y = pd.Series(0, index=sig.index)  # date courante : pas de résultat (non utilisé)
        common = sig.index.intersection(y.index)
        xs.append(sig.loc[common].values); ys.append(y.loc[common].values)
    return np.concatenate(xs), np.concatenate(ys)


def _xy_ml(snapshots, ks, h):
    Xs, ys = [], []
    for k in ks:
        X = snapshots[k]["X"].dropna()
        y = snapshots[k]["y"].get(h)
        if y is None:
            y = pd.Series(0, index=X.index)
        common = X.index.intersection(y.index)
        Xs.append(X.loc[common]); ys.append(y.loc[common].values)
    return pd.concat(Xs).values, np.concatenate(ys)


def _weight(st: dict) -> float:
    auc = st.get("auc")
    if auc is None:
        return 0.0
    w = max(0.0, auc - 0.5)
    return w if st.get("hors_echantillon") else w * 0.5   # mesure optimiste : poids réduit de moitié


def _fmt(st):
    if st.get("acc") is None:
        return "n.d."
    return f"{st['acc'] * 100:.1f}% (AUC {st['auc']:.3f}{'' if st.get('hors_echantillon') else ', dans l’échantillon'})"


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    run(ap.parse_args().demo)
