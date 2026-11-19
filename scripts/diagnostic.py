"""Diagnostic temporaire : sources pour l'univers d'entreprises."""
import io, time, json, requests, pandas as pd
def log(*a): print(" ".join(str(x) for x in a), flush=True)
H = {"User-Agent": "Mozilla/5.0 (barometre-kedge projet etudiant)"}
for name, url in [("SP500", "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"),
                  ("SX5E", "https://en.wikipedia.org/wiki/EURO_STOXX_50")]:
    try:
        r = requests.get(url, headers=H, timeout=60); tabs = pd.read_html(io.StringIO(r.text))
        log("==", name, r.status_code, "tables", len(tabs))
        for t in tabs[:4]: log("  shape", t.shape, list(t.columns)[:9]); log(t.head(3).to_string()[:600])
    except Exception as e: log("==", name, "ERREUR", e)
import yfinance as yf
log("yfinance", yf.__version__)
try:
    from yfinance import EquityQuery
    q = EquityQuery("and", [EquityQuery("is-in", ["region", "fr", "de", "nl", "it", "es", "be", "fi", "ie", "at", "pt", "lu"]),
                            EquityQuery("gt", ["intradaymarketcap", 2_000_000_000])])
    allq = []
    for off in range(0, 1000, 250):
        res = yf.screen(q, size=250, offset=off, sortField="intradaymarketcap", sortAsc=False)
        quotes = res.get("quotes", []); allq += quotes; log("screen offset", off, len(quotes), "total", res.get("total"))
        if len(quotes) < 250: break
    df = pd.DataFrame(allq); log("colonnes", list(df.columns))
    keep = [c for c in ["symbol", "shortName", "exchange", "fullExchangeName", "marketCap", "region", "currency", "quoteType"] if c in df.columns]
    log(df[keep].head(25).to_string()); log("exchanges", df["exchange"].value_counts().to_dict() if "exchange" in df else "")
except Exception as e: log("screen ERREUR", repr(e))
for t in ["AAPL", "MC.PA", "SAP.DE", "ASML.AS", "ENEL.MI"]:
    try:
        t0 = time.time(); info = yf.Ticker(t).info
        keys = ["shortName", "sector", "industry", "country", "currency", "marketCap", "trailingPE", "forwardPE", "priceToBook",
                "dividendYield", "returnOnEquity", "operatingMargins", "revenueGrowth", "debtToEquity", "beta", "exchange"]
        log(t, round(time.time() - t0, 1), "s", {k: info.get(k) for k in keys})
    except Exception as e: log(t, "ERREUR", repr(e))
t0 = time.time()
px = yf.download(["AAPL", "MSFT", "MC.PA", "SAP.DE", "ASML.AS", "ENEL.MI", "SAN.MC", "BRK-B"], period="5y", auto_adjust=True, progress=False, threads=True)
log("download 8 tickers 5y", round(time.time() - t0, 1), "s", px["Close"].shape, px["Close"].iloc[-1].round(1).to_dict())
