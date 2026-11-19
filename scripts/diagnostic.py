"""Diagnostic temporaire : interroge Eurostat et la BCE et écrit ce qu'ils renvoient."""
import io, requests, pandas as pd
out = []
def log(*a): out.append(" ".join(str(x) for x in a))
def get(url, **params):
    r = requests.get(url, params=params, timeout=60, headers={"User-Agent": "barometre-kedge"})
    return r
for ds, f in [("une_rt_m", {"geo": "EA20"}), ("prc_hicp_manr", {"geo": "EA", "coicop": "CP00"}),
              ("prc_hicp_manr", {"geo": "EA20", "coicop": "CP00"})]:
    r = get(f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{ds}", format="JSON", lang="en", lastTimePeriod=3, **f)
    log("==", ds, f, r.status_code, r.url)
    try:
        j = r.json(); log("id", j.get("id"), "size", j.get("size"))
        for d in j.get("id", []):
            cat = j["dimension"][d]["category"]
            log("  ", d, list(cat.get("index", {}).keys())[:12])
        log("  values", list(j.get("value", {}).items())[:6])
    except Exception as e:
        log("  erreur", e, r.text[:300])
for key in ["ICP/M.U2.N.000000.4.ANR", "ICP/M..N.000000.4.ANR", "LFSI/M.I9.S.UNEHRT.TOTAL0.15_74.T",
            "LFSI/M..S.UNEHRT.TOTAL0.15_74.T", "STS/M..S.UNEH.RTT000.4.000"]:
    r = get(f"https://data-api.ecb.europa.eu/service/data/{key}", format="csvdata", lastNObservations=2)
    log("== BCE", key, r.status_code)
    if r.status_code == 200:
        df = pd.read_csv(io.StringIO(r.text))
        cols = [c for c in ("KEY", "REF_AREA", "TIME_PERIOD", "OBS_VALUE") if c in df.columns]
        log(df[cols].tail(12).to_string())
    else:
        log(r.text[:200])
open("data/diagnostic.txt", "w").write("\n".join(out))
print("\n".join(out))
