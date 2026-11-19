"""
Scoring des entreprises et des secteurs (S&P 500 + Euro Stoxx élargi).

Étapes :
  1. univers : liste du S&P 500 (Wikipédia) + Euro Stoxx reconstitué (Yahoo Finance),
     reconstruit tous les 30 jours ;
  2. ratios financiers (Yahoo Finance) et cours sur 5 ans ;
  3. calcul des indicateurs (PER, performance, volatilité, ROE...) ;
  4. notation de chaque indicateur PAR RAPPORT AUX ENTREPRISES DU MÊME SECTEUR
     (écrêtage aux 5e/95e centiles puis Min-Max 0-100), puis 4 familles de 25 points ;
  5. score des secteurs : 60 % entreprises + 40 % tendance de marché + ajustement macro ;
  6. écriture des fichiers lus par le site (site/data/...).

Lancer :  python scripts/build_companies.py           (vraies données)
          python scripts/build_companies.py --demo    (données simulées, sans internet)
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "companies.yaml"
RAW = ROOT / "data" / "raw"
HIST = ROOT / "data" / "history"
SITE_DATA = ROOT / "site" / "data"
COMPANY_DIR = SITE_DATA / "companies"

UA = {"User-Agent": "Mozilla/5.0 (barometre-kedge, projet etudiant KEDGE)"}
EZ_COUNTRIES = {"France", "Germany", "Netherlands", "Italy", "Spain", "Belgium", "Finland", "Portugal",
                "Ireland", "Austria", "Luxembourg", "Greece", "Slovakia", "Slovenia", "Estonia", "Latvia",
                "Lithuania", "Croatia", "Malta", "Cyprus", "Bulgaria"}
# Suffixes Yahoo des bourses de la zone euro, par ordre de préférence
EZ_SUFFIXES = [".PA", ".AS", ".DE", ".MI", ".MC", ".BR", ".HE", ".IR", ".LS", ".VI", ".AT"]
HOME_SUFFIX = {"France": ".PA", "Netherlands": ".AS", "Germany": ".DE", "Italy": ".MI", "Spain": ".MC",
               "Belgium": ".BR", "Finland": ".HE", "Ireland": ".IR", "Portugal": ".LS", "Austria": ".VI",
               "Greece": ".AT", "Luxembourg": ".PA"}
EZ_EXCHANGES = ["PAR", "AMS", "GER", "MIL", "MCE", "BRU", "HEL", "ISE", "LIS", "VIE", "ATH"]
COUNTRY_FR = {"United States": "États-Unis", "France": "France", "Germany": "Allemagne", "Netherlands": "Pays-Bas",
              "Italy": "Italie", "Spain": "Espagne", "Belgium": "Belgique", "Finland": "Finlande",
              "Portugal": "Portugal", "Ireland": "Irlande", "Austria": "Autriche", "Luxembourg": "Luxembourg",
              "Greece": "Grèce", "Switzerland": "Suisse", "United Kingdom": "Royaume-Uni"}
INFO_FIELDS = ["shortName", "longName", "sector", "industry", "country", "currency", "marketCap", "trailingPE",
               "forwardPE", "priceToBook", "dividendYield", "returnOnEquity", "operatingMargins", "revenueGrowth",
               "debtToEquity", "beta", "exchange", "website", "fullTimeEmployees", "profitMargins",
               "enterpriseToEbitda", "currentPrice", "targetMeanPrice", "recommendationKey", "longBusinessSummary"]
VIEWS = {"commun": ("US", "EZ"), "US": ("US",), "EZ": ("EZ",)}


def log(*a):
    print(*a, flush=True)


def safe_name(ticker: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "_", ticker)


def rnd(x, n=2):
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else round(x, n)


# ---------------------------------------------------------------------------
# 1. Univers
# ---------------------------------------------------------------------------
def wiki_tables(url: str) -> list[pd.DataFrame]:
    r = requests.get(url, headers=UA, timeout=60)
    r.raise_for_status()
    return pd.read_html(io.StringIO(r.text))


def sp500_list() -> pd.DataFrame:
    t = wiki_tables("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")[0]
    return pd.DataFrame({"ticker": t["Symbol"].str.replace(".", "-", regex=False), "zone": "US",
                         "gics_sector": t["GICS Sector"], "gics_sub": t["GICS Sub-Industry"]})


def sx5e_list() -> list[str]:
    for t in wiki_tables("https://en.wikipedia.org/wiki/EURO_STOXX_50"):
        if "Ticker" in t.columns and len(t) >= 45:
            return t["Ticker"].astype(str).str.strip().tolist()
    raise RuntimeError("Tableau Euro Stoxx 50 introuvable sur Wikipédia")


def screen_eurozone(min_cap: float) -> list[str]:
    import yfinance as yf
    from yfinance import EquityQuery
    exchanges = list(EZ_EXCHANGES)
    while True:
        try:
            q = EquityQuery("and", [EquityQuery("is-in", ["exchange", *exchanges]),
                                    EquityQuery("gt", ["intradaymarketcap", min_cap])])
            break
        except ValueError as e:  # une place de cotation inconnue de Yahoo : on la retire
            bad = re.findall(r'"([^"]+)"', str(e))
            if not bad or bad[0] not in exchanges:
                raise
            exchanges.remove(bad[0])
    symbols = []
    for offset in range(0, 4000, 250):
        res = yf.screen(q, size=250, offset=offset, sortField="intradaymarketcap", sortAsc=False)
        quotes = res.get("quotes", [])
        symbols += [x["symbol"] for x in quotes if any(x["symbol"].endswith(s) for s in EZ_SUFFIXES)]
        if len(quotes) < 250:
            break
        time.sleep(0.5)
    log(f"Recherche zone euro : {len(symbols)} cotations candidates ({', '.join(exchanges)})")
    return list(dict.fromkeys(symbols))


def norm_name(info: dict) -> str:
    name = (info.get("longName") or info.get("shortName") or "").lower()
    name = re.sub(r"\b(se|sa|nv|ag|spa|s\.p\.a|plc|n\.v|s\.a|oyj|ab|asa|inc|group|holding|holdings)\b", "", name)
    return re.sub(r"[^a-z0-9]", "", name)[:14]


def build_eurostoxx(cfg: dict, infos: dict) -> pd.DataFrame:
    core = sx5e_list()
    candidates = list(dict.fromkeys(core + screen_eurozone(cfg["eurostoxx_min_cap_eur"])))
    fetch_infos(candidates, infos)
    rows = []
    for t in candidates:
        i = infos.get(t) or {}
        if i.get("country") in EZ_COUNTRIES and i.get("marketCap"):
            rows.append({"ticker": t, "country": i["country"], "cap": i["marketCap"], "key": norm_name(i),
                         "core": t in core})
    df = pd.DataFrame(rows)

    def pick(group):  # une seule cotation par entreprise : la bourse du pays du siège, sinon la préférée
        if group["core"].any():
            return group[group["core"]].iloc[0]
        home = HOME_SUFFIX.get(group["country"].iloc[0])
        g = group.assign(rank=group["ticker"].map(
            lambda t: 0 if home and t.endswith(home) else 1 + next((k for k, s in enumerate(EZ_SUFFIXES) if t.endswith(s)), 99)))
        return g.sort_values(["rank", "cap"], ascending=[True, False]).iloc[0]

    df = pd.DataFrame([pick(g) for _, g in df.groupby("key")])
    df = df.sort_values("cap", ascending=False)
    keep = pd.concat([df[df["core"]], df[~df["core"]]]).drop_duplicates("ticker")
    keep = keep.sort_values("cap", ascending=False).head(max(cfg["eurostoxx_size"], int(df["core"].sum())))
    keep = pd.concat([keep, df[df["core"] & ~df["ticker"].isin(keep["ticker"])]])
    log(f"Euro Stoxx reconstitué : {len(keep)} entreprises (dont {int(keep['core'].sum())} de l'Euro Stoxx 50)")
    return pd.DataFrame({"ticker": keep["ticker"], "zone": "EZ"})


def load_universe(cfg: dict, infos: dict, demo: bool, force: bool) -> pd.DataFrame:
    path = ROOT / "data" / "universe.csv"
    if demo:
        return demo_universe()
    meta = ROOT / "data" / "universe_built.txt"
    if path.exists() and meta.exists() and not force:
        built = meta.read_text().strip()
        if (pd.Timestamp.today() - pd.Timestamp(built)).days < cfg["universe"]["rebuild_every_days"]:
            df = pd.read_csv(path)
            log(f"Univers : {len(df)} entreprises (liste du {built})")
            return df
    parts = []
    try:
        parts.append(sp500_list())
        log(f"S&P 500 : {len(parts[-1])} entreprises")
    except Exception as e:  # noqa: BLE001
        log("ECHEC liste S&P 500 :", e)
    try:
        parts.append(build_eurostoxx(cfg["universe"], infos))
    except Exception as e:  # noqa: BLE001
        log("ECHEC Euro Stoxx :", e)
    if len(parts) < 2 and path.exists():
        log("Univers incomplet : on garde la liste précédente")
        return pd.read_csv(path)
    df = pd.concat(parts, ignore_index=True).drop_duplicates("ticker")
    df.to_csv(path, index=False)
    (ROOT / "data" / "universe_built.txt").write_text(pd.Timestamp.today().strftime("%Y-%m-%d"))
    return df


# ---------------------------------------------------------------------------
# 2. Données de marché
# ---------------------------------------------------------------------------
def fetch_infos(tickers: list[str], infos: dict, max_age_days: float = 5) -> None:
    """Ratios Yahoo Finance, mis en cache : une entreprise déjà lue il y a moins
    de max_age_days jours n'est pas redemandée (moins de requêtes, moins de blocages)."""
    import yfinance as yf
    now = time.time()
    todo = [t for t in tickers if now - (infos.get(t) or {}).get("_fetched", 0) > max_age_days * 86400]
    log(f"Ratios : {len(todo)} entreprises à interroger ({len(tickers) - len(todo)} déjà en cache)")
    failures = 0
    for k, t in enumerate(todo, 1):
        for attempt in range(3):
            try:
                raw = yf.Ticker(t).info or {}
                if raw.get("quoteType") not in (None, "EQUITY") or not raw.get("marketCap"):
                    raise RuntimeError("pas une action ou pas de capitalisation")
                infos[t] = {f: raw.get(f) for f in INFO_FIELDS} | {"_fetched": now}
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    failures += 1
                    if t in infos:
                        infos[t]["_error"] = str(e)[:120]
                time.sleep(1.5 * (attempt + 1))
        if k % 100 == 0:
            log(f"  {k}/{len(todo)}  (échecs : {failures})")
            save_infos(infos)
        time.sleep(0.15)
    log(f"Ratios terminés, {failures} échecs (version précédente gardée quand elle existe)")


def load_infos() -> dict:
    p = RAW / "company_info.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def save_infos(infos: dict) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "company_info.json").write_text(json.dumps(infos, ensure_ascii=False), encoding="utf-8")


def download_prices(tickers: list[str]) -> pd.DataFrame:
    import yfinance as yf
    yf.set_tz_cache_location("/tmp/yf-cache")
    frames = []
    for k in range(0, len(tickers), 80):
        chunk = tickers[k:k + 80]
        for attempt in range(3):
            try:
                px = yf.download(chunk, period="5y", auto_adjust=True, progress=False, threads=False)["Close"]
                if isinstance(px, pd.Series):
                    px = px.to_frame(chunk[0])
                frames.append(px)
                break
            except Exception as e:  # noqa: BLE001
                log(f"  cours, lot {k}: {e}")
                time.sleep(3 * (attempt + 1))
        log(f"  cours : {min(k + 80, len(tickers))}/{len(tickers)}")
    prices = pd.concat(frames, axis=1)
    prices.index = pd.to_datetime(prices.index).tz_localize(None).normalize()
    prices = prices.groupby(level=0).last().sort_index()
    return prices.loc[:, ~prices.columns.duplicated()]


def eurusd() -> float:
    try:
        import yfinance as yf
        s = yf.download("EURUSD=X", period="10d", progress=False, auto_adjust=True)["Close"].dropna()
        return float(s.iloc[-1].iloc[0] if isinstance(s, pd.DataFrame) else s.iloc[-1])
    except Exception:  # noqa: BLE001
        return 1.10


# ---------------------------------------------------------------------------
# 3. Indicateurs
# ---------------------------------------------------------------------------
def price_metrics(c: pd.Series) -> dict:
    c = c.dropna()
    out = {}
    if len(c) < 30:
        return out
    last = c.iloc[-1]

    def back(n):
        return c.iloc[-1 - n] if len(c) > n else np.nan

    out["perf_1m"] = (last / back(21) - 1) * 100
    out["perf_3m"] = (last / back(63) - 1) * 100
    out["perf_1y"] = (last / back(252) - 1) * 100
    out["perf_5y"] = (last / c.iloc[0] - 1) * 100 if len(c) > 1000 else np.nan
    out["perf_12m_ex1m"] = (back(21) / back(252) - 1) * 100
    ytd = c[c.index.year == c.index[-1].year]
    out["perf_ytd"] = (last / ytd.iloc[0] - 1) * 100 if len(ytd) > 1 else np.nan
    if len(c) >= 200:
        out["ma200_gap"] = (last / c.iloc[-200:].mean() - 1) * 100
    r = c.pct_change().dropna().iloc[-252:]
    out["vol_1y"] = r.std() * math.sqrt(252) * 100
    w = c.iloc[-252:]
    out["max_dd_1y"] = ((w / w.cummax()) - 1).min() * 100
    out["price"] = last
    return out


def info_metrics(i: dict) -> dict:
    def pos(x, cap=None):
        x = rnd(x, 6)
        if x is None or x <= 0:
            return np.nan
        return min(x, cap) if cap else x

    def pct(x):
        x = rnd(x, 6)
        return np.nan if x is None else x * 100

    dy = rnd(i.get("dividendYield"), 6)
    return {
        "pe": pos(i.get("trailingPE"), 300),        # PER négatif (pertes) : non noté
        "pb": pos(i.get("priceToBook"), 100),
        "div_yield": 0.0 if dy is None else dy,     # Yahoo le donne déjà en %
        "beta": rnd(i.get("beta"), 4) if i.get("beta") is not None else np.nan,
        "debt_equity": rnd(i.get("debtToEquity"), 4) if i.get("debtToEquity") is not None else np.nan,
        "roe": pct(i.get("returnOnEquity")),
        "op_margin": pct(i.get("operatingMargins")),
        "rev_growth": pct(i.get("revenueGrowth")),
    }


# ---------------------------------------------------------------------------
# 4. Notation dans le secteur
# ---------------------------------------------------------------------------
def score_metric(df: pd.DataFrame, col: str, direction: str, clip: float, min_size: int) -> pd.Series:
    out = pd.Series(np.nan, index=df.index)

    def minmax(x: pd.Series) -> pd.Series:
        x = x.dropna()
        if len(x) < 3:
            return pd.Series(50.0, index=x.index)
        lo, hi = x.quantile(clip), x.quantile(1 - clip)
        if hi <= lo:
            return pd.Series(50.0, index=x.index)
        s = (x.clip(lo, hi) - lo) / (hi - lo) * 100
        return 100 - s if direction == "bas" else s

    universe_scores = minmax(df[col])
    for _, idx in df.groupby("sector").groups.items():
        values = df.loc[idx, col]
        if values.notna().sum() >= min_size:
            out.loc[values.dropna().index] = minmax(values)
        else:
            out.loc[values.dropna().index] = universe_scores.reindex(values.dropna().index)
    return out


def weighted_mean(values: pd.Series, weights: pd.Series) -> float:
    m = values.notna() & weights.notna() & (weights > 0)
    return float((values[m] * weights[m]).sum() / weights[m].sum()) if m.any() else np.nan


# ---------------------------------------------------------------------------
# Données simulées (mode --demo)
# ---------------------------------------------------------------------------
DEMO_SECTORS = ["Technology", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Healthcare",
                "Financial Services", "Industrials", "Basic Materials", "Energy", "Utilities", "Real Estate"]


def demo_universe() -> pd.DataFrame:
    rows = []
    for k in range(140):
        zone = "US" if k % 5 < 3 else "EZ"
        rows.append({"ticker": f"DEMO{k:03d}" + ("" if zone == "US" else ".PA"), "zone": zone})
    return pd.DataFrame(rows)


def demo_data(universe: pd.DataFrame):
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=1260)
    prices, infos = {}, {}
    for k, t in enumerate(universe["ticker"]):
        rng = np.random.default_rng(zlib.crc32(t.encode()))
        sector = DEMO_SECTORS[k % len(DEMO_SECTORS)]
        drift, vol = rng.normal(0.0003, 0.0004), rng.uniform(0.01, 0.025)
        prices[t] = 100 * np.exp(np.cumsum(rng.normal(drift, vol, len(idx))))
        ez = t.endswith(".PA")
        infos[t] = {"shortName": f"{'Euro' if ez else 'US'} {sector.split()[0]} {k}", "longName": None,
                    "sector": sector, "industry": f"{sector} - sous-secteur {k % 3 + 1}",
                    "country": "France" if ez else "United States", "currency": "EUR" if ez else "USD",
                    "marketCap": float(rng.lognormal(24, 1.2)), "trailingPE": float(rng.uniform(-5, 45)),
                    "priceToBook": float(rng.uniform(0.6, 12)), "dividendYield": float(rng.uniform(0, 5)),
                    "returnOnEquity": float(rng.normal(0.15, 0.1)), "operatingMargins": float(rng.normal(0.18, 0.1)),
                    "revenueGrowth": float(rng.normal(0.06, 0.08)), "debtToEquity": float(rng.uniform(5, 250)),
                    "beta": float(rng.uniform(0.4, 1.8)), "longBusinessSummary": "Entreprise fictive (données simulées).",
                    "_fetched": time.time()}
    return pd.DataFrame(prices, index=idx), infos


# ---------------------------------------------------------------------------
# 5. Programme principal
# ---------------------------------------------------------------------------
def main(demo: bool, rebuild_universe: bool) -> None:
    cfg = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
    fams = cfg["families"]
    sectors_cfg = cfg["sectors"]
    infos = {} if demo else load_infos()

    universe = load_universe(cfg, infos, demo, rebuild_universe)
    tickers = universe["ticker"].tolist()
    if demo:
        prices, infos = demo_data(universe)
        fx = 1.10
    else:
        fetch_infos(tickers, infos)
        save_infos(infos)
        log("Téléchargement des cours sur 5 ans...")
        prices = download_prices(tickers)
        fx = eurusd()
    log(f"EUR/USD utilisé pour comparer les tailles : {fx:.4f}")

    # --- tableau des entreprises ---
    rows = []
    for _, u in universe.iterrows():
        t = u["ticker"]
        i = infos.get(t) or {}
        if not i.get("sector") or i.get("sector") not in sectors_cfg:
            continue
        m = {**info_metrics(i), **(price_metrics(prices[t]) if t in prices else {})}
        cap = i.get("marketCap") or np.nan
        cap_usd = cap * (fx if i.get("currency") == "EUR" else 1) if i.get("currency") in ("EUR", "USD") else np.nan
        rows.append({"ticker": t, "zone": u["zone"], "name": (i.get("shortName") or i.get("longName") or t).strip(),
                     "sector": i["sector"], "industry": i.get("industry") or "", "country": i.get("country") or "",
                     "currency": i.get("currency") or "", "cap": cap, "cap_usd": cap_usd, **m})
    df = pd.DataFrame(rows).set_index("ticker")
    log(f"{len(df)} entreprises notables ({(df.zone == 'US').sum()} US, {(df.zone == 'EZ').sum()} zone euro)")

    # --- notation ---
    metric_scores = {}
    for fid, f in fams.items():
        for mid, m in f["metrics"].items():
            if mid in df:
                metric_scores[mid] = score_metric(df, mid, m["direction"], cfg["clip_percentile"], cfg["min_sector_size"])
    ms = pd.DataFrame(metric_scores)
    fam_scores = pd.DataFrame({fid: ms[[m for m in f["metrics"] if m in ms]].mean(axis=1) for fid, f in fams.items()})
    fw = pd.Series({fid: f["weight"] for fid, f in fams.items()})
    avail = fam_scores.notna()
    df["score"] = (fam_scores.fillna(0) * fw).sum(axis=1) / (avail * fw).sum(axis=1)
    df.loc[avail.sum(axis=1) < 2, "score"] = np.nan
    for fid in fams:
        df[f"f_{fid}"] = fam_scores[fid]
    df["rank_sector"] = df.groupby("sector")["score"].rank(ascending=False, method="min")

    # --- secteurs ---
    macro = json.loads((SITE_DATA / "macro.json").read_text(encoding="utf-8")) if (SITE_DATA / "macro.json").exists() else None
    sc = cfg["sector_score"]
    rets = prices.pct_change(fill_method=None)
    weekly_dates = prices.resample("W-FRI").last().index
    sector_out = {"views": {}, "index_dates": [f"{d:%Y-%m-%d}" for d in weekly_dates]}
    for view, zones in VIEWS.items():
        macro_score = macro["views"][view]["latest"]["score"] if macro else 50.0
        items = []
        for sid, s in sectors_cfg.items():
            members = df[(df.sector == sid) & df.zone.isin(zones)]
            if members.empty:
                continue
            r = rets[[t for t in members.index if t in rets]].clip(-0.5, 0.5)
            index = (1 + r.mean(axis=1).fillna(0)).cumprod() * 100
            gap = index / index.rolling(200, min_periods=150).mean() - 1
            mom = index / index.shift(126) - 1

            def ts_score(x):
                x = x.dropna()
                if len(x) < 50:
                    return np.nan
                lo, hi = x.quantile(0.02), x.quantile(0.98)
                return float((min(max(x.iloc[-1], lo), hi) - lo) / (hi - lo) * 100) if hi > lo else 50.0

            trend = np.nanmean([ts_score(gap), ts_score(mom)])
            comp = weighted_mean(members["score"], members["cap_usd"])
            tilt = sc["macro_tilt"] * (macro_score - 50) * {"cyclique": 1, "defensif": -1}.get(s["type"], 0)
            score = float(np.clip(sc["company_weight"] * comp + sc["trend_weight"] * trend + tilt, 0, 100))
            ranked = members.dropna(subset=["score"]).sort_values("score", ascending=False)

            def brief(x):
                return [{"ticker": t, "name": row["name"], "score": rnd(row["score"], 1)} for t, row in x.iterrows()]

            def perf(n):
                return rnd((index.iloc[-1] / index.iloc[-1 - n] - 1) * 100, 1) if len(index) > n else None

            ytd = index[index.index.year == index.index[-1].year]
            items.append({
                "id": sid, "label": s["label"], "type": s["type"], "score": rnd(score, 1),
                "company_score": rnd(comp, 1), "trend_score": rnd(trend, 1), "macro_tilt": rnd(tilt, 1),
                "n": int(len(members)), "cap_usd": rnd(members["cap_usd"].sum(), 0),
                "perf_1m": perf(21), "perf_ytd": rnd((index.iloc[-1] / ytd.iloc[0] - 1) * 100, 1) if len(ytd) > 1 else None,
                "perf_1y": perf(252),
                "pe_median": rnd(members["pe"].median(), 1), "div_yield_avg": rnd(members["div_yield"].mean(), 2),
                "families": {fid: rnd(weighted_mean(members[f"f_{fid}"], members["cap_usd"]), 1) for fid in fams},
                "top": brief(ranked.head(3)), "bottom": brief(ranked.tail(3).iloc[::-1]),
                "industries": sorted(members["industry"].dropna().unique().tolist()),
                "index": [rnd(x, 2) for x in index.resample("W-FRI").last().reindex(weekly_dates)],
            })
        items.sort(key=lambda x: -(x["score"] or 0))
        sector_out["views"][view] = {"macro_score": rnd(macro_score, 1), "sectors": items}

    # --- historique des scores (s'enrichit à chaque mise à jour) ---
    today = pd.Timestamp.today().strftime("%Y-%m-%d")
    HIST.mkdir(parents=True, exist_ok=True)
    hist_path = HIST / "company_scores.csv"
    snap = df[["score"] + [f"f_{f}" for f in fams]].round(1).reset_index().assign(date=today)
    if hist_path.exists() and not demo:
        old = pd.read_csv(hist_path)
        snap = pd.concat([old[old.date != today], snap])
    if not demo:
        snap.to_csv(hist_path, index=False)
    hist_by_ticker = {t: g.sort_values("date") for t, g in snap.groupby("ticker")}

    # --- fichiers du site ---
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    COMPANY_DIR.mkdir(parents=True, exist_ok=True)
    for old_file in COMPANY_DIR.glob("*.json"):
        old_file.unlink()
    updated = datetime.now(timezone.utc).isoformat(timespec="minutes")
    family_meta = [{"id": fid, "label": f["label"], "weight": f["weight"],
                    "metrics": [{"id": mid, **m} for mid, m in f["metrics"].items()]} for fid, f in fams.items()]
    sector_avgs = df.groupby("sector")[[m for f in fams.values() for m in f["metrics"] if m in df]].median()
    list_rows = []
    for t, row in df.iterrows():
        slabel = sectors_cfg[row["sector"]]["label"]
        list_rows.append({
            "t": t, "n": row["name"], "z": row["zone"], "c": COUNTRY_FR.get(row["country"], row["country"]),
            "s": row["sector"], "i": row["industry"], "cap": rnd(row["cap_usd"] / 1e9, 1),
            "sc": rnd(row["score"], 1), **{f"f_{fid}": rnd(row[f"f_{fid}"], 1) for fid in fams},
            "p1y": rnd(row.get("perf_1y"), 1), "pytd": rnd(row.get("perf_ytd"), 1), "pe": rnd(row.get("pe"), 1),
            "dy": rnd(row.get("div_yield"), 2), "rk": int(row["rank_sector"]) if pd.notna(row["rank_sector"]) else None,
        })
        if t in prices:
            w = prices[t].dropna().resample("W-FRI").last().dropna()
        else:
            w = pd.Series(dtype=float)
        i = infos.get(t) or {}
        h = hist_by_ticker.get(t)
        detail = {
            "ticker": t, "name": row["name"], "long_name": i.get("longName"), "zone": row["zone"],
            "country": COUNTRY_FR.get(row["country"], row["country"]), "sector": row["sector"], "sector_label": slabel,
            "industry": row["industry"], "currency": row["currency"], "cap": rnd(row["cap"], 0),
            "cap_usd": rnd(row["cap_usd"], 0), "website": i.get("website"), "employees": i.get("fullTimeEmployees"),
            "summary": (i.get("longBusinessSummary") or "")[:900], "recommendation": i.get("recommendationKey"),
            "target_price": rnd(i.get("targetMeanPrice")), "forward_pe": rnd(i.get("forwardPE")),
            "ev_ebitda": rnd(i.get("enterpriseToEbitda")), "net_margin": rnd((i.get("profitMargins") or np.nan) * 100),
            "score": rnd(row["score"], 1), "rank_sector": list_rows[-1]["rk"],
            "sector_size": int((df.sector == row["sector"]).sum()),
            "families": {fid: rnd(row[f"f_{fid}"], 1) for fid in fams},
            "metrics": {m: {"value": rnd(row.get(m)), "score": rnd(ms.loc[t, m], 1) if m in ms else None,
                            "sector_median": rnd(sector_avgs.loc[row["sector"], m]) if m in sector_avgs else None}
                        for f in fams.values() for m in f["metrics"]},
            "perf": {k: rnd(row.get(k), 1) for k in ("perf_1m", "perf_3m", "perf_ytd", "perf_1y", "perf_5y")},
            "price": rnd(row.get("price")),
            "prices": {"dates": [f"{d:%Y-%m-%d}" for d in w.index], "close": [rnd(x) for x in w]},
            "score_history": {"dates": h["date"].tolist(), "score": h["score"].tolist()} if h is not None else None,
        }
        (COMPANY_DIR / f"{safe_name(t)}.json").write_text(json.dumps(detail, ensure_ascii=False, separators=(",", ":")),
                                                         encoding="utf-8")

    common = {"updated": updated, "demo": demo, "eurusd": rnd(fx, 4),
              "sector_labels": {k: v["label"] for k, v in sectors_cfg.items()}, "families": family_meta}
    (SITE_DATA / "companies.json").write_text(json.dumps({**common, "companies": list_rows}, ensure_ascii=False,
                                                         separators=(",", ":")), encoding="utf-8")
    (SITE_DATA / "sectors.json").write_text(json.dumps({**common, **sector_out, "method": sc}, ensure_ascii=False,
                                                       separators=(",", ":")), encoding="utf-8")
    covered = df["score"].notna().sum()
    log(f"\n{covered}/{len(df)} entreprises notées. Classement des secteurs (vue commune) :")
    for s in sector_out["views"]["commun"]["sectors"]:
        log(f"  {s['label']:<24} {s['score']:>5}  (entreprises {s['company_score']}, tendance {s['trend_score']}, macro {s['macro_tilt']:+})  n={s['n']}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--demo", action="store_true", help="données simulées, sans internet")
    p.add_argument("--rebuild-universe", action="store_true", help="reconstruire la liste des entreprises")
    a = p.parse_args()
    main(a.demo, a.rebuild_universe)
