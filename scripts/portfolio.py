"""Compte rendu du portefeuille (fictif pour l'instant) envoyé par mail après chaque mise à jour.

Les lignes viennent de la variable de dépôt GitHub PORTFOLIO (jamais du dépôt lui-même).
Aucun mail si le portefeuille est vide. Secrets : MAIL_USER, MAIL_APP_PASSWORD (mot de passe
d'application Gmail), MAIL_TO. Le portefeuille n'entre dans aucun score.
"""
from __future__ import annotations

import json
import os
import re
import smtplib
import sys
from datetime import date
from email.message import EmailMessage
from html import escape
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "site" / "data"
SITE = "https://barometre-kedge-valentin-vivier.vercel.app/#/portefeuille"
RECO = {"strong_buy": "Achat fort", "buy": "Achat", "outperform": "Surperformance", "hold": "Conserver",
        "underperform": "Sous-performance", "sell": "Vente"}
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]


def log(msg: str) -> None:
    print(msg, flush=True)


def safe_name(ticker: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "_", ticker)


_SUFFIX = re.compile(r",?\s*(Société Européenne|Société en commandite par actions|Société anonyme|S\.p\.A\.|S\.A\.|SA|SE|S\.E\.|N\.V\.|NV|AG|plc|PLC|Inc\.?|Corporation|Corp\.?|Company|Co\.|Ltd\.?|Holding(s)?|Group|Aktiengesellschaft|Oyj|ASA)(?=$|[\s,])")


def short_name(n: str) -> str:
    """Même règle que shortName() du site."""
    x = re.sub(r"\s{2,}", " ", re.sub(r"^The\s+", "", _SUFFIX.sub("", str(n or "").split(" - ")[0]))).strip()
    x = re.sub(r"[,\-–&\s]+$", "", x)
    return (x[:25].strip() + "…") if len(x) > 26 else (x or n)


def load_holdings(raw: str | None) -> list[dict]:
    try:
        v = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [h for h in v if isinstance(h, dict) and h.get("ticker")] if isinstance(v, list) else []


def _read(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def buy_price(prices: dict, day: str) -> float | None:
    """Dernier cours de clôture connu à la date d'achat ou juste avant (None si avant l'historique)."""
    best = None
    for d, c in zip(prices.get("dates", []), prices.get("close", [])):
        if d <= day and c is not None:
            best = c
        elif d > day:
            break
    return best


def valuate(holdings: list[dict], data_dir: Path = DATA) -> dict:
    lines, invested, value, platforms = [], 0.0, 0.0, {}
    for h in holdings:
        t = h["ticker"]
        line = {"id": h.get("id"), "ticker": t, "amount": float(h.get("amount", 0)), "platform": h.get("platform", ""),
                "date": h.get("date", ""), "name": t, "status": "indisponible"}
        d = _read(data_dir / "companies" / f"{safe_name(t)}.json")
        if d:
            line["name"] = short_name(d.get("name") or t)
            bp = buy_price(d.get("prices", {}), line["date"])
            if bp:
                perf = d["price"] / bp - 1
                line.update(status="ok", buy_price=bp, price=d["price"], currency=d.get("currency", ""),
                            perf=perf, value=line["amount"] * (1 + perf))
                invested += line["amount"]; value += line["value"]
                platforms[line["platform"]] = platforms.get(line["platform"], 0) + line["value"]
            else:
                line["status"] = "cours d'achat indisponible"
            hist = (d.get("score_history") or {}).get("score") or []
            line["score"] = d.get("score")
            line["currency"] = d.get("currency", "")
            line["score_delta"] = (hist[-1] - hist[-2]) if len(hist) >= 2 else None
            line["reco"] = RECO.get(d.get("recommendation"), "–")
            tp, px = d.get("target_price"), d.get("price")
            line["target"] = tp
            line["upside"] = (tp / px - 1) if tp and px else None
            p = _read(data_dir / "predictions" / f"{safe_name(t)}.json") or {}
            line["pred"] = {k: {"p": p.get("h", {}).get(k, {}).get("p"), "fiabilite": p.get("h", {}).get(k, {}).get("fiabilite")}
                            for k in ("1a", "3a")}
        lines.append(line)
    macro = ((_read(data_dir / "macro.json") or {}).get("views", {}).get("commun", {}) or {}).get("latest", {})
    return {"date": date.today().isoformat(), "lines": lines, "platforms": platforms, "macro": macro,
            "totals": {"invested": invested, "value": value, "gain": value - invested,
                       "perf": (value / invested - 1) if invested else None}}


# ---------- mise en forme ----------
def eur(x: float | None) -> str:
    return "–" if x is None else f"{x:,.0f} €".replace(",", " ")


def pct(x: float | None, signed: bool = True, dec: int = 1) -> str:
    if x is None:
        return "–"
    s = f"{x * 100:+.{dec}f} %" if signed else f"{x * 100:.{dec}f} %"
    return s.replace(".", ",").replace("-", "−")


def num(x: float | None, signed: bool = False) -> str:
    return "–" if x is None else (f"{x:+.1f}" if signed else f"{x:.1f}").replace(".", ",").replace("-", "−")


def fr_date(iso: str) -> str:
    y, m, d = (int(v) for v in iso.split("-"))
    return f"{d} {MOIS[m - 1]} {y}"


def line_blocks(l: dict) -> list[str]:
    head = f"{l['name']} · {l['platform']}"
    if l["status"] == "indisponible":
        return [head, f"  Investi {eur(l['amount'])} · données indisponibles (action sortie de l'univers suivi)"]
    out = [head]
    if l["status"] == "ok":
        out.append(f"  Investi {eur(l['amount'])} → {eur(l['value'])} ({pct(l['perf'])}) · Score {num(l.get('score'))} ({num(l.get('score_delta'), True)})")
    else:
        out.append(f"  Investi {eur(l['amount'])} · cours d'achat indisponible (achat antérieur à l'historique) · Score {num(l.get('score'))}")
    cur = {"EUR": " €", "USD": " $"}.get(l.get("currency", ""), "")
    tgt = f" · objectif {num(l['target'])}{cur} ({pct(l['upside'])})" if l.get("target") else ""
    out.append(f"  Analystes : {l.get('reco', '–')}{tgt}")
    pr = l.get("pred", {})
    out.append(f"  Prévisions : 1 an {pct(pr.get('1a', {}).get('p'), False, 0)} · 3 ans {pct(pr.get('3a', {}).get('p'), False, 0)}"
               f" (prédictivité {pct(pr.get('1a', {}).get('fiabilite'), False, 0)} / {pct(pr.get('3a', {}).get('fiabilite'), False, 0)})")
    return out


def render(rep: dict) -> tuple[str, str, str]:
    t, m = rep["totals"], rep["macro"]
    subject = f"Baromètre KEDGE · Portefeuille au {fr_date(rep['date'])} : {eur(t['value'])} ({pct(t['perf'])})"
    intro = [f"Total investi {eur(t['invested'])} · valeur {eur(t['value'])} · {('+' if t['gain'] >= 0 else '−') + eur(abs(t['gain']))} ({pct(t['perf'])})"]
    if m:
        intro.append(f"Contexte : baromètre macro {num(m.get('score'))} ({(m.get('signal') or {}).get('label', '').lower()}, "
                     f"tendance 3 mois : {(m.get('trend') or {}).get('label', '').lower()} {num(m.get('delta_3m'), True)})")
    blocks = [line_blocks(l) for l in rep["lines"]]
    plat = " · ".join(f"{k} {eur(v)}" for k, v in sorted(rep["platforms"].items(), key=lambda kv: -kv[1]))
    foot = ["Performance calculée sur le cours de l'action, sans l'effet de change euro/dollar.",
            "Score, analystes et prévisions : informations du site, séparées entre elles ; pas un conseil en investissement.",
            f"Voir le portefeuille : {SITE}"]
    text = "\n".join(intro + [""] + ["\n".join(b) + "\n" for b in blocks] + [f"Par plateforme : {plat}", ""] + foot)
    css = "font-family:Arial,Helvetica,sans-serif;color:#0f1b2d"
    hb = "".join(
        f'<div style="border-top:1px solid #e2ded4;padding:10px 0"><b>{escape(b[0])}</b><br>'
        + "<br>".join(f'<span style="color:#5d6878">{escape(s.strip())}</span>' for s in b[1:]) + "</div>" for b in blocks)
    html = (f'<html><body style="{css};background:#f3f1ec;padding:16px"><div style="max-width:620px;margin:auto;background:#fff;'
            f'border:1px solid #e2ded4;border-top:4px solid #b8892b;padding:18px 20px">'
            f'<div style="font-size:13px;color:#b8892b;letter-spacing:.06em">BAROMÈTRE KEDGE · PORTEFEUILLE</div>'
            f'<h2 style="margin:6px 0 4px">{escape(eur(t["value"]))} <span style="font-size:16px;color:{"#1f7a5a" if (t["perf"] or 0) >= 0 else "#b4413a"}">{escape(pct(t["perf"]))}</span></h2>'
            + "".join(f'<div style="font-size:14px;color:#5d6878">{escape(s)}</div>' for s in intro)
            + f'<div style="margin-top:12px">{hb}</div><div style="border-top:1px solid #e2ded4;padding-top:10px;font-size:14px">Par plateforme : {escape(plat)}</div>'
            + "".join(f'<p style="font-size:12px;color:#5d6878;margin:8px 0 0">{escape(s)}</p>' for s in foot[:2])
            + f'<p style="margin:14px 0 0"><a href="{SITE}" style="color:#1d4f91">Voir le portefeuille sur le site</a></p></div></body></html>')
    return subject, text, html


def send(subject: str, text: str, html: str) -> None:
    user, pwd, to = (os.environ.get(k, "").strip() for k in ("MAIL_USER", "MAIL_APP_PASSWORD", "MAIL_TO"))
    if not (user and pwd and to):
        raise RuntimeError("secrets MAIL_USER, MAIL_APP_PASSWORD et MAIL_TO à définir dans GitHub")
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, user, to
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
        s.login(user, pwd)
        s.send_message(msg)


def main(data_dir: Path = DATA) -> int:
    holdings = load_holdings(os.environ.get("PORTFOLIO"))
    if not holdings:
        log("Portefeuille vide : aucun mail envoyé.")
        return 0
    rep = valuate(holdings, data_dir)
    subject, text, html = render(rep)
    try:
        send(subject, text, html)
    except Exception as e:  # noqa: BLE001
        log(f"ECHEC envoi du mail : {e}")
        return 1
    log(f"Mail envoyé : {subject} ({len(holdings)} lignes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
