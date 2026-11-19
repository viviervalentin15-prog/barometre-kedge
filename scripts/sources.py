"""
Récupération des données brutes, une fonction par source.

Chaque fonction renvoie une série pandas (index = dates, valeurs = nombres).
Les sources utilisées sont toutes gratuites :
  - FRED (Banque fédérale de Saint-Louis)  -> données US et mondiales
  - OCDE (API SDMX)                        -> indicateurs avancés (CLI)
  - Eurostat (API JSON-stat)               -> PIB et chômage zone euro
  - BCE (ECB Data Portal)                  -> inflation et taux zone euro
  - Yahoo Finance (bibliothèque yfinance)  -> indices boursiers
"""

from __future__ import annotations

import io
import os
import time

import pandas as pd
import requests

HEADERS = {"User-Agent": "barometre-kedge/1.0 (projet etudiant KEDGE)"}
HISTORY_START = "2003-01-01"  # un peu avant 2005 pour calculer les variations sur 1 an


# ---------------------------------------------------------------------------
# Outil commun : une requête web avec plusieurs essais
# ---------------------------------------------------------------------------
def _get(url: str, params: dict | None = None, headers: dict | None = None,
         tries: int = 3, timeout: int = 60) -> requests.Response:
    last_error = None
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, headers={**HEADERS, **(headers or {})},
                             timeout=timeout)
            if r.status_code == 200:
                return r
            last_error = RuntimeError(f"HTTP {r.status_code} sur {r.url}")
        except requests.RequestException as e:  # coupure réseau, délai dépassé...
            last_error = e
        time.sleep(2 * (attempt + 1))
    raise last_error


# ---------------------------------------------------------------------------
# FRED
# ---------------------------------------------------------------------------
def fred(series_id: str) -> pd.Series:
    """Une série FRED. Utilise la clé API si elle est fournie, sinon le CSV public."""
    key = os.environ.get("FRED_API_KEY", "").strip()
    if key:
        r = _get("https://api.stlouisfed.org/fred/series/observations", params={
            "series_id": series_id, "api_key": key, "file_type": "json",
            "observation_start": HISTORY_START,
        })
        obs = r.json()["observations"]
        s = pd.Series({o["date"]: o["value"] for o in obs})
    else:
        r = _get("https://fred.stlouisfed.org/graph/fredgraph.csv",
                 params={"id": series_id, "cosd": HISTORY_START})
        df = pd.read_csv(io.StringIO(r.text))
        s = pd.Series(df.iloc[:, 1].values, index=df.iloc[:, 0].values)
    s.index = pd.to_datetime(s.index)
    s = pd.to_numeric(s, errors="coerce").dropna()  # FRED note "." les valeurs manquantes
    s.name = series_id
    return s


# ---------------------------------------------------------------------------
# OCDE : indicateur composite avancé (CLI)
# ---------------------------------------------------------------------------
# Si la zone euro (EA20) n'est pas publiée, on essaie des zones proches.
CLI_AREA_FALLBACKS = {
    "EA20": ["EA20", "EA19", "G4E"],
    "USA": ["USA"],
}
CLI_FRED_FALLBACKS = {"USA": "USALOLITOAASTSAM", "EA20": "EA19LOLITOAASTSAM"}


def oecd_cli(area: str) -> pd.Series:
    errors = []
    for code in CLI_AREA_FALLBACKS.get(area, [area]):
        url = ("https://sdmx.oecd.org/public/rest/data/"
               f"OECD.SDD.STES,DSD_STES@DF_CLI,/{code}.M.LI...AA...H")
        try:
            r = _get(url, params={"startPeriod": HISTORY_START[:7],
                                  "dimensionAtObservation": "AllDimensions"},
                     headers={"Accept": "application/vnd.sdmx.data+csv; charset=utf-8"})
            df = pd.read_csv(io.StringIO(r.text))
            if df.empty:
                raise RuntimeError("réponse vide")
            # S'il reste plusieurs séries, on garde celle qui a le plus d'observations
            group_cols = [c for c in ("UNIT_MEASURE", "TRANSFORMATION", "METHODOLOGY")
                          if c in df.columns]
            if group_cols:
                best = df.groupby(group_cols).size().idxmax()
                best = best if isinstance(best, tuple) else (best,)
                for col, val in zip(group_cols, best):
                    df = df[df[col] == val]
            s = pd.Series(df["OBS_VALUE"].values, index=pd.to_datetime(df["TIME_PERIOD"]))
            s = pd.to_numeric(s, errors="coerce").dropna().sort_index()
            if len(s) > 24:
                s.name = f"OECD CLI {code}"
                return s
            raise RuntimeError("historique trop court")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{code}: {e}")
    # Dernier recours : la copie de la série sur FRED
    if area in CLI_FRED_FALLBACKS:
        s = fred(CLI_FRED_FALLBACKS[area])
        s.name = f"FRED {CLI_FRED_FALLBACKS[area]}"
        return s
    raise RuntimeError("CLI OCDE indisponible : " + " | ".join(errors))


# ---------------------------------------------------------------------------
# Eurostat (format JSON-stat)
# ---------------------------------------------------------------------------
def _eurostat(dataset: str, filters: dict) -> pd.Series:
    url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset}"
    params = {"format": "JSON", "lang": "en", **filters}
    data = _get(url, params=params).json()
    ids, sizes = data["id"], data["size"]
    t_pos = ids.index("time")
    stride = 1
    for size in sizes[t_pos + 1:]:
        stride *= size
    time_index = data["dimension"]["time"]["category"]["index"]  # période -> position
    values = {int(k): v for k, v in data["value"].items()}
    out = {}
    for period, pos in time_index.items():
        v = values.get(pos * stride)
        if v is not None:
            out[period] = v
    if not out:
        raise RuntimeError(f"Eurostat {dataset} {filters} : aucune valeur")
    return pd.Series(out)


def _period_to_month_end(index) -> pd.DatetimeIndex:
    """'2005-Q1' -> 2005-03-01 ; '2005-01' ou '2005M01' -> 2005-01-01."""
    dates = []
    for p in index:
        p = str(p).replace("M", "-") if "Q" not in str(p) else str(p)
        if "Q" in p:
            year, q = p.replace("-", "").split("Q")
            dates.append(pd.Timestamp(int(year), int(q) * 3, 1))
        else:
            dates.append(pd.Timestamp(p[:7] + "-01"))
    return pd.DatetimeIndex(dates)


def eurostat_gdp() -> pd.Series:
    errors = []
    for geo in ("EA20", "EA19"):
        try:
            s = _eurostat("namq_10_gdp", {"geo": geo, "unit": "CLV_PCH_SM", "s_adj": "SCA",
                                          "na_item": "B1GQ", "sinceTimePeriod": "2003-Q1"})
            s.index = _period_to_month_end(s.index)
            s.name = f"Eurostat PIB {geo}"
            return s.sort_index()
        except Exception as e:  # noqa: BLE001
            errors.append(f"{geo}: {e}")
    raise RuntimeError("PIB zone euro indisponible : " + " | ".join(errors))


def _freshest(candidates, label: str) -> pd.Series:
    """Essaie plusieurs sources et garde celle qui a la donnée la plus récente."""
    found, errors = [], []
    for name, fn in candidates:
        try:
            x = fn().dropna().sort_index()
            if len(x) > 24:
                x.name = name
                found.append(x)
            else:
                errors.append(f"{name}: historique trop court")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {e}")
    if not found:
        raise RuntimeError(f"{label} indisponible : " + " | ".join(errors))
    return max(found, key=lambda x: (x.index.max(), len(x)))


def _eurostat_monthly(dataset: str, filters: dict) -> pd.Series:
    x = _eurostat(dataset, filters)
    x.index = _period_to_month_end(x.index)
    return x


def eurostat_unemployment() -> pd.Series:
    """Taux de chômage zone euro : BCE en priorité, Eurostat en secours."""
    candidates = [("BCE chômage zone euro", lambda: ecb("STS/M.I9.S.UNEH.RTT000.4.000"))]
    for geo in ("EA20", "EA"):
        for age in ("Y15-74", "TOTAL"):
            candidates.append((f"Eurostat chômage {geo}", lambda g=geo, a=age: _eurostat_monthly(
                "une_rt_m", {"geo": g, "s_adj": "SA", "age": a, "sex": "T", "unit": "PC_ACT",
                             "sinceTimePeriod": "2003-01"})))
    return _freshest(candidates, "Chômage zone euro")


def hicp_ez() -> pd.Series:
    """Inflation HICP zone euro sur 1 an. La composition de la zone change (Bulgarie en 2026) :
    on interroge plusieurs codes et on garde la série la plus à jour."""
    candidates = [("BCE HICP zone euro", lambda: ecb("ICP/M.U2.N.000000.4.ANR"))]
    for geo in ("EA", "EA21", "EA20"):
        candidates.append((f"Eurostat HICP {geo}", lambda g=geo: _eurostat_monthly(
            "prc_hicp_manr", {"geo": g, "coicop": "CP00", "unit": "RCH_A", "sinceTimePeriod": "2003-01"})))
    return _freshest(candidates, "Inflation zone euro")


# ---------------------------------------------------------------------------
# BCE (ECB Data Portal)
# ---------------------------------------------------------------------------
def ecb(key: str) -> pd.Series:
    """key = 'FLUX/CLE', par ex. 'ICP/M.U2.N.000000.4.ANR' (inflation HICP sur 1 an)."""
    r = _get(f"https://data-api.ecb.europa.eu/service/data/{key}",
             params={"format": "csvdata", "startPeriod": HISTORY_START[:7]})
    df = pd.read_csv(io.StringIO(r.text))
    s = pd.Series(df["OBS_VALUE"].values, index=pd.to_datetime(df["TIME_PERIOD"]))
    s = pd.to_numeric(s, errors="coerce").dropna().sort_index()
    s.name = f"BCE {key}"
    return s


def ecb_slope() -> pd.Series:
    """Pente 10 ans - 2 ans de la courbe des emprunts d'État notés AAA de la zone euro."""
    base = "YC/B.U2.EUR.4F.G_N_A.SV_C_YM."
    ten, two = ecb(base + "SR_10Y"), ecb(base + "SR_2Y")
    s = (ten - two).dropna()
    s.name = "BCE courbe AAA 10a-2a"
    return s


# ---------------------------------------------------------------------------
# Yahoo Finance : écart du cours à sa moyenne mobile 200 jours
# ---------------------------------------------------------------------------
def yahoo_close(ticker: str, start: str = HISTORY_START) -> pd.Series:
    import yfinance as yf  # importé ici : seulement nécessaire pour ces séries
    df = yf.download(ticker, start=start, auto_adjust=True, progress=False, threads=False)
    if df is None or df.empty:
        raise RuntimeError(f"Yahoo Finance n'a rien renvoyé pour {ticker}")
    close = df["Close"]
    if isinstance(close, pd.DataFrame):  # nouvelles versions de yfinance
        close = close.iloc[:, 0]
    return close.dropna()


def ma200_gap(close: pd.Series) -> pd.Series:
    ma = close.rolling(200, min_periods=150).mean()
    return ((close / ma - 1) * 100).dropna()


def yahoo_ma200(ticker: str, fred_fallback: str | None = None) -> pd.Series:
    try:
        close = yahoo_close(ticker)
        name = f"Yahoo {ticker}"
    except Exception:
        if not fred_fallback:
            raise
        close = fred(fred_fallback)
        name = f"FRED {fred_fallback}"
    s = ma200_gap(close)
    s.name = name + " (écart MM200)"
    return s
