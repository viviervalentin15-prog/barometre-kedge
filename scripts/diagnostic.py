"""Diagnostic temporaire : où est publiée l'inflation HICP de la zone euro depuis 2026 ?"""
import io, requests, pandas as pd
out = []
def log(*a):
    out.append(" ".join(str(x) for x in a)); print(out[-1], flush=True)
H = {"User-Agent": "barometre-kedge"}
# 1. Catalogue Eurostat : jeux de données dont le code contient "hicp"
r = requests.get("https://ec.europa.eu/eurostat/api/dissemination/catalogue/toc/txt", params={"lang": "en"}, headers=H, timeout=120)
log("== catalogue Eurostat", r.status_code)
for line in r.text.splitlines():
    low = line.lower()
    if "hicp" in low and ("annual rate" in low or "monthly data" in low or "flash" in low):
        log(" ", line[:220])
# 2. BCE : flux de données disponibles contenant ICP / HICP
r = requests.get("https://data-api.ecb.europa.eu/service/dataflow/ECB", headers={**H, "Accept": "application/vnd.sdmx.structure+json;version=1.0"}, timeout=120)
log("== flux BCE", r.status_code)
try:
    for df in r.json()["data"]["dataflows"]:
        name = df.get("name") or (df.get("names") or {}).get("en", "")
        if any(k in (df["id"] + str(name)).upper() for k in ("ICP", "HICP", "PRICE")):
            log(" ", df["id"], name)
except Exception as e:
    log("  erreur", e, r.text[:300])
# 3. BCE ICP : séries zone euro avec des données en 2026
for key in ["ICP/M.U2.N..4.ANR", "ICP/M.U2.Y..4.ANR", "ICP/M.U2...4.ANR", "ICP/M.I9...4.ANR", "ICP/M.U3...4.ANR"]:
    r = requests.get(f"https://data-api.ecb.europa.eu/service/data/{key}", params={"format": "csvdata", "startPeriod": "2026-01"}, headers=H, timeout=120)
    log("== BCE", key, r.status_code, len(r.text))
    if r.status_code == 200 and r.text.strip():
        d = pd.read_csv(io.StringIO(r.text))
        g = d.groupby("KEY")["TIME_PERIOD"].max()
        log("  séries:", len(g)); log(g.head(15).to_string())
# 4. Eurostat flash estimate
for ds, f in [("prc_hicp_fp", {"geo": "EA"}), ("prc_hicp_manr", {"geo": "EA"})]:
    r = requests.get(f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{ds}", params={"format": "JSON", "lang": "en", "lastTimePeriod": 2, **f}, headers=H, timeout=60)
    log("==", ds, r.status_code)
    try:
        j = r.json(); log("  id", j.get("id"), j.get("size"))
        for dd in j.get("id", []): log("   ", dd, list(j["dimension"][dd]["category"]["index"].keys())[:10])
    except Exception as e:
        log("  erreur", r.text[:200])
open("data/diagnostic.txt", "w").write("\n".join(out))
