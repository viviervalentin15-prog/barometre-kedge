"""
Construit le baromètre macro.

Étapes :
  1. récupère chaque indicateur (voir sources.py), le met en fréquence mensuelle ;
  2. le normalise sur 0-100 (Min-Max, inversion pour le risque, écart à une cible) ;
  3. agrège les indicateurs par pilier, puis les piliers en un score global ;
  4. écrit site/data/macro.json, lu par le site web.

Lancer :  python scripts/build_macro.py          (vraies données)
          python scripts/build_macro.py --demo   (données simulées, pour tester sans internet)
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import traceback
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "macro.yaml"
RAW_DIR = ROOT / "data" / "raw"          # dernière version valide de chaque série
OUT_FILE = ROOT / "site" / "data" / "macro.json"

sys.path.insert(0, str(Path(__file__).parent))
import sources  # noqa: E402

VIEWS = {"commun": ["US", "EZ", "MONDE"], "US": ["US", "MONDE"], "EZ": ["EZ", "MONDE"]}
FFILL_LIMIT = 6  # on prolonge une donnée au plus 6 mois (publications trimestrielles, retards)


# ---------------------------------------------------------------------------
# 1. Récupération et mise en fréquence mensuelle
# ---------------------------------------------------------------------------
def fetch_raw(src: dict) -> pd.Series:
    kind = src["type"]
    if kind == "fred":
        s = sources.fred(src["series"])
        fallback = src.get("long_fallback")
        if fallback and s.index.min() > pd.Timestamp("2008-01-01"):
            # historique trop court pour couvrir 2008 : on prend la série longue
            s = sources.fred(fallback)
        if src.get("fred_fallback") and s.index.max() < pd.Timestamp.today() - pd.DateOffset(months=9):
            s = sources.fred(src["fred_fallback"])
        return s
    if kind == "oecd_cli":
        return sources.oecd_cli(src["area"])
    if kind == "eurostat_gdp":
        return sources.eurostat_gdp()
    if kind == "eurostat_unemployment":
        return sources.eurostat_unemployment()
    if kind == "hicp_ez":
        return sources.hicp_ez()
    if kind == "ecb":
        return sources.ecb(src["key"])
    if kind == "ecb_slope":
        return sources.ecb_slope()
    if kind == "yahoo_ma200":
        return sources.yahoo_ma200(src["ticker"], src.get("fred_fallback"))
    raise ValueError(f"Type de source inconnu : {kind}")


def to_monthly(s: pd.Series, src: dict) -> pd.Series:
    s = s.sort_index()
    spacing = s.index.to_series().diff().dt.days.median()
    if src.get("transform") == "yoy":
        periods = 4 if spacing > 60 else 12  # trimestriel ou mensuel
        s = (s.pct_change(periods, fill_method=None) * 100).dropna()
    if spacing > 60 and src["type"] == "fred":
        # FRED date un trimestre au 1er mois (T1 = janvier) : on le place au dernier
        # mois du trimestre (mars), comme Eurostat, pour ne pas anticiper la donnée.
        s.index = s.index + pd.DateOffset(months=2)
    months = s.index.to_period("M").to_timestamp()
    if spacing < 20:  # données quotidiennes
        if src["type"] == "yahoo_ma200":
            s = s.groupby(months).last()      # niveau de fin de mois
        else:
            s = s.groupby(months).mean()      # moyenne du mois
    else:
        s = s.groupby(months).last()
    return s.dropna()


def load_indicator(ind: dict, demo: bool, log: list) -> tuple[pd.Series, str, str]:
    """Renvoie (série mensuelle, statut, libellé source)."""
    cache = RAW_DIR / f"{ind['id']}.csv"
    if demo:
        return demo_series(ind), "demo", "données simulées"
    try:
        raw = fetch_raw(ind["source"])
        s = to_monthly(raw, ind["source"])
        if len(s) < 24:
            raise RuntimeError(f"seulement {len(s)} mois de données")
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        s.rename("value").to_frame().assign(source=raw.name).to_csv(cache, index_label="date")
        log.append(f"OK      {ind['id']:<14} {raw.name}  ({s.index.min():%Y-%m} -> {s.index.max():%Y-%m})")
        return s, "ok", str(raw.name)
    except Exception as e:  # noqa: BLE001
        log.append(f"ECHEC   {ind['id']:<14} {e}")
        if cache.exists():
            df = pd.read_csv(cache, parse_dates=["date"], index_col="date")
            log.append(f"        -> on garde la dernière version valide ({df.index.max():%Y-%m})")
            return df["value"], "cache", str(df["source"].iloc[-1]) + " (version précédente)"
        traceback.print_exc()
        return pd.Series(dtype=float), "missing", "indisponible"


# ---------------------------------------------------------------------------
# 2. Normalisation
# ---------------------------------------------------------------------------
def winsorize(x: pd.Series, pct: float) -> pd.Series:
    if not pct:
        return x
    lo, hi = x.quantile(pct), x.quantile(1 - pct)
    return x.clip(lo, hi)


BURN_IN = 24  # mois d'historique minimum avant de noter un indicateur


def normalize(x: pd.Series, method: str, target: float | None, clip_pct: float) -> tuple[pd.Series, pd.Series]:
    """Renvoie (score Min-Max 0-100, score Z 0-100). Haut = bonne santé.

    Version « temps réel » : à chaque date, le minimum, le maximum (écrêtés aux centiles
    clip_pct / 1 - clip_pct), la moyenne et l'écart-type ne sont calculés qu'avec les
    données DÉJÀ CONNUES à cette date. Le score d'un mois passé est donc celui qu'on
    aurait réellement obtenu à l'époque, sans connaître les crises à venir."""
    if method == "target":
        x = (x - target).abs()   # écart à la cible : plus petit = mieux
        inverse = True
    else:
        inverse = method == "minmax_inverse"
    ex = x.expanding(BURN_IN)
    lo = ex.quantile(clip_pct) if clip_pct else ex.min()
    hi = ex.quantile(1 - clip_pct) if clip_pct else ex.max()
    span = (hi - lo).where(hi > lo)
    mm = ((x.clip(lo, hi) - lo) / span * 100).where(span.notna(), 50.0).where(lo.notna())
    z = (x - ex.mean()) / ex.std()
    if inverse:
        mm, z = 100 - mm, -z
    z_score = ((z.clip(-3, 3) + 3) / 6 * 100)
    return mm, z_score


# ---------------------------------------------------------------------------
# 3. Agrégation
# ---------------------------------------------------------------------------
def aggregate(scores: pd.DataFrame, indicators: list, pillars: dict, zones: list):
    """Score par pilier (moyenne pondérée des indicateurs) puis score global
    (moyenne pondérée des piliers, grille 30/20/30/20). Un indicateur manquant
    est simplement ignoré et les poids restants sont remis en proportion."""
    pillar_scores = {}
    for pid in pillars:
        inds = [i for i in indicators if i["pillar"] == pid and i["zone"] in zones]
        if not inds:
            continue
        w = pd.DataFrame({i["id"]: scores[i["id"]].notna() * i["weight"] for i in inds})
        v = pd.DataFrame({i["id"]: scores[i["id"]].fillna(0) for i in inds})
        pillar_scores[pid] = (v * w).sum(axis=1) / w.sum(axis=1).replace(0, np.nan)
    ps = pd.DataFrame(pillar_scores)
    pw = pd.DataFrame({p: ps[p].notna() * pillars[p]["weight"] for p in ps})
    total = (ps.fillna(0) * pw).sum(axis=1) / pw.sum(axis=1).replace(0, np.nan)
    return total, ps


def effective_weights(latest_avail: dict, indicators: list, pillars: dict, zones: list) -> dict:
    """Poids réel de chaque indicateur dans le score global à la dernière date."""
    out = {}
    active_p = {}
    for pid in pillars:
        inds = [i for i in indicators if i["pillar"] == pid and i["zone"] in zones and latest_avail[i["id"]]]
        if inds:
            active_p[pid] = inds
    total_pw = sum(pillars[p]["weight"] for p in active_p)
    for pid, inds in active_p.items():
        tw = sum(i["weight"] for i in inds)
        for i in inds:
            out[i["id"]] = pillars[pid]["weight"] / total_pw * i["weight"] / tw * 100
    return out


def trend(delta_3m: float | None) -> dict:
    """La variation sur 3 mois : c'est le signal le plus utile d'après les tests sur le passé."""
    if delta_3m is None or pd.isna(delta_3m):
        return {"label": "–", "tone": "neutral"}
    if delta_3m >= 3:
        return {"label": "En amélioration", "tone": "good"}
    if delta_3m <= -3:
        return {"label": "En dégradation", "tone": "critical"}
    return {"label": "Stable", "tone": "neutral"}


def signal(score: float) -> dict:
    bands = [(70, "Favorable", "good"), (55, "Plutôt favorable", "good"), (45, "Neutre", "neutral"),
             (30, "Prudence", "warning"), (-1, "Dégradé", "critical")]
    for threshold, label, tone in bands:
        if score >= threshold:
            return {"label": label, "tone": tone}
    return {"label": "Dégradé", "tone": "critical"}


# ---------------------------------------------------------------------------
# Données simulées (mode --demo)
# ---------------------------------------------------------------------------
def demo_series(ind: dict) -> pd.Series:
    rng = np.random.default_rng(zlib.crc32(ind["id"].encode()))
    idx = pd.date_range("2003-01-01", pd.Timestamp.today().to_period("M").to_timestamp(), freq="MS")
    t = np.arange(len(idx))
    cycle = np.sin(t / 18) + 0.3 * np.cumsum(rng.normal(0, 0.15, len(idx)))
    crisis = np.zeros(len(idx))
    for start in ("2008-09-01", "2020-03-01", "2022-06-01"):
        k = idx.get_loc(pd.Timestamp(start))
        crisis[k:k + 8] += np.linspace(2.5, 0, 8)[: len(idx) - k]
    base = {"cli": (100, 1.5, -1), "gdp": (1.8, 1.5, -2), "unemp": (6, 1.2, 1.5), "cpi": (2.5, 1.2, 0.5),
            "hicp": (2.2, 1.1, 0.5), "breakeven": (2.1, 0.3, -0.3), "equity": (4, 5, -6),
            "slope": (1.2, 0.8, -0.3), "vix": (19, 4, 10), "credit": (4.5, 1.2, 3), "brent": (75, 18, -10),
            "epu": (150, 40, 60)}
    key = next(k for k in base if ind["id"].startswith(k))
    mean, amp, shock = base[key]
    return pd.Series(mean + amp * cycle + shock * crisis, index=idx)


# ---------------------------------------------------------------------------
# Prévision séparée du score : probabilité de récession aux États-Unis dans 12 mois
# ---------------------------------------------------------------------------
def recession_probability(demo: bool, raw_df: pd.DataFrame) -> dict | None:
    """Modèle de la Fed de New York (Estrella et Mishkin) : probit sur l'écart de taux
    10 ans - 3 mois, moyenne mensuelle. P = N(-0,5333 - 0,6330 x écart).
    Les récessions officielles (NBER, série USREC) servent à juger le modèle sur le passé."""
    try:
        if demo:
            spread = raw_df["slope_us"].dropna() + 0.3
            rec = pd.Series(0, index=spread.index)
        else:
            spread = sources.fred("T10Y3M")
            spread = spread.groupby(spread.index.to_period("M").to_timestamp()).mean()
            rec = sources.fred("USREC")
        prob = spread.map(lambda x: 0.5 * (1 + math.erf((-0.5333 - 0.6330 * x) / math.sqrt(2))))
        prob = prob[prob.index >= pd.Timestamp("2005-01-01")]
        rec = rec.reindex(prob.index).ffill()
        # Le modèle donne une probabilité pour dans 12 mois : on la compare aux récessions 12 mois plus tard
        rec_ahead = rec.shift(-12)
        return {
            "model": "Fed de New York (Estrella et Mishkin) : écart de taux 10 ans - 3 mois",
            "dates": [f"{d:%Y-%m}" for d in prob.index],
            "prob": [round(float(x) * 100, 1) for x in prob],
            "recession": [int(x) if pd.notna(x) else None for x in rec],
            "latest": {"date": f"{prob.index[-1]:%Y-%m}", "prob": round(float(prob.iloc[-1]) * 100, 1),
                       "spread": round(float(spread.iloc[-1]), 2)},
            "check": {"prob_moy_avant_recession": round(float(prob[rec_ahead == 1].mean()) * 100, 1) if (rec_ahead == 1).any() else None,
                      "prob_moy_hors_recession": round(float(prob[rec_ahead == 0].mean()) * 100, 1) if (rec_ahead == 0).any() else None},
        }
    except Exception as e:  # noqa: BLE001
        print("ECHEC probabilité de récession :", e)
        return None


# ---------------------------------------------------------------------------
# 4. Programme principal
# ---------------------------------------------------------------------------
def main(demo: bool = False) -> None:
    cfg = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    indicators, pillars = cfg["indicators"], cfg["pillars"]
    clip_pct = float(cfg.get("winsorize", 0) or 0)
    start = pd.Timestamp(cfg["start_date"])
    end = pd.Timestamp.today().to_period("M").to_timestamp()
    months = pd.date_range(start, end, freq="MS")
    log: list[str] = []

    raw, mm, zs, meta = {}, {}, {}, {}
    for ind in indicators:
        s, status, source_label = load_indicator(ind, demo, log)
        last_obs = s.index.max() if len(s) else None
        full = s.reindex(s.index.union(months)).sort_index().ffill(limit=FFILL_LIMIT).reindex(months)
        raw[ind["id"]] = full
        own = s.reindex(s.index.union(months)).sort_index().ffill(limit=FFILL_LIMIT)
        own = own.loc[: months[-1]].dropna()   # tout l'historique disponible, depuis 2003
        if len(own) >= BURN_IN:
            a, b = normalize(own, ind["method"], ind.get("target"), clip_pct)
            mm[ind["id"]], zs[ind["id"]] = a.reindex(months), b.reindex(months)
        else:
            mm[ind["id"]] = zs[ind["id"]] = pd.Series(np.nan, index=months)
        stale = last_obs is not None and last_obs < end - pd.DateOffset(months=FFILL_LIMIT)
        meta[ind["id"]] = {"status": "stale" if stale and status == "ok" else status,
                           "source": source_label,
                           "last_obs": f"{last_obs:%Y-%m}" if last_obs is not None else None}

    raw_df, mm_df, z_df = pd.DataFrame(raw), pd.DataFrame(mm), pd.DataFrame(zs)
    # On s'arrête au dernier mois où le score peut être calculé
    valid = mm_df.notna().sum(axis=1) >= max(5, len(indicators) // 2)
    last_month = valid[valid].index.max()
    raw_df, mm_df, z_df = raw_df.loc[:last_month], mm_df.loc[:last_month], z_df.loc[:last_month]
    dates = [f"{d:%Y-%m}" for d in mm_df.index]

    def r(x, n=1):
        return None if x is None or pd.isna(x) else round(float(x), n)

    views = {}
    latest_avail = {i["id"]: pd.notna(mm_df[i["id"]].iloc[-1]) for i in indicators}
    for view, zones in VIEWS.items():
        total, ps = aggregate(mm_df, indicators, pillars, zones)
        total_z, _ = aggregate(z_df, indicators, pillars, zones)
        eff = effective_weights(latest_avail, indicators, pillars, zones)
        now = total.iloc[-1]

        def delta(months_back):
            return r(now - total.iloc[-1 - months_back]) if len(total) > months_back else None

        views[view] = {
            "latest": {
                "date": dates[-1], "score": r(now), "score_z": r(total_z.iloc[-1]),
                "signal": signal(now), "trend": trend(delta(3)),
                "delta_1m": delta(1), "delta_3m": delta(3), "delta_12m": delta(12),
                "pillars": {p: r(ps[p].iloc[-1]) for p in ps},
                "contributions": {iid: {"eff_weight": r(w, 2),
                                        "points": r(w / 100 * mm_df[iid].iloc[-1], 2)}
                                  for iid, w in eff.items()},
            },
            "history": {
                "score": [r(x) for x in total], "score_z": [r(x) for x in total_z],
                "pillars": {p: [r(x) for x in ps[p]] for p in ps},
            },
        }

    out = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "demo": demo,
        "method": {"normalisation": "Min-Max en temps réel : à chaque date, seules les données passées sont utilisées",
                   "winsorize": clip_pct},
        "zones": cfg["zones"],
        "pillars": [{"id": k, **v} for k, v in pillars.items()],
        "dates": dates,
        "views": views,
        "indicators": [{
            "id": i["id"], "name": i["name"], "zone": i["zone"], "pillar": i["pillar"],
            "weight": i["weight"], "method": i["method"], "target": i.get("target"),
            "unit": i["unit"], **meta[i["id"]],
            "latest": {"raw": r(raw_df[i["id"]].iloc[-1], 2), "score": r(mm_df[i["id"]].iloc[-1]),
                       "score_z": r(z_df[i["id"]].iloc[-1])},
            "history": {"raw": [r(x, 2) for x in raw_df[i["id"]]],
                        "score": [r(x) for x in mm_df[i["id"]]]},
        } for i in indicators],
        "log": log,
    }
    out["recession"] = recession_probability(demo, raw_df)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print("\n".join(log))
    c = views["commun"]["latest"]
    print(f"\nScore commun au {c['date']} : {c['score']} / 100  ({c['signal']['label']})")
    print("Piliers :", c["pillars"])
    if not demo and any(m["status"] in ("missing",) for m in meta.values()):
        print("\nATTENTION : certains indicateurs sont indisponibles (voir ECHEC ci-dessus).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="données simulées, sans internet")
    main(parser.parse_args().demo)
