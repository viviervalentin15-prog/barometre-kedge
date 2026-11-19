import pandas as pd, yfinance as yf, time
from yfinance import EquityQuery
def log(*a): print(" ".join(str(x) for x in a), flush=True)
q = EquityQuery("and", [EquityQuery("is-in", ["region", "fr", "de", "nl", "it", "es", "be", "fi", "ie", "at", "pt"]),
                        EquityQuery("gt", ["intradaymarketcap", 1_000_000_000])])
allq = []
for off in range(0, 2000, 250):
    res = yf.screen(q, size=250, offset=off, sortField="intradaymarketcap", sortAsc=False)
    quotes = res.get("quotes", []); allq += quotes; log("offset", off, len(quotes), "total", res.get("total"))
    if len(quotes) < 250: break
df = pd.DataFrame(allq); log(list(df.columns))
keep = [c for c in ["symbol", "shortName", "exchange", "marketCap", "region", "currency", "quoteType", "market"] if c in df.columns]
log(df[keep].head(40).to_string()); log(df["exchange"].value_counts().to_string())
log(df[keep].iloc[280:320].to_string())
t0 = time.time(); yf.set_tz_cache_location("/tmp/yf")
px = yf.download(["AAPL", "MSFT", "MC.PA", "BRK-B"] * 1, period="5y", auto_adjust=True, progress=False, threads=False)
log("dl", round(time.time()-t0,1), px["Close"].ffill().iloc[-1].to_dict())
