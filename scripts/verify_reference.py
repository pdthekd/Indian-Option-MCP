#!/usr/bin/env python3
"""
INDEPENDENT verification of the reference backtest (ref_nifty_weekly_iron_condor v1.0.0).

Deliberately shares NO code with the TypeScript engine: it reads the RAW NSE UDiFF bhavcopy zips
(not the normalized JSONL), re-implements the documented strategy rule (docs/BACKTESTING.md and the
spec text), the documented fill model, lot sizes (NewBrdLotQty), final settlement (SttlmPric of
expiring options) and the charge schedules (rates typed in from the cited sources), then compares
every trade with a golden result file.

    python scripts/verify_reference.py --golden src/strategy/reference/golden/<file>.json \
        [--plan r3|r2] [--data ~/.options-hq/data/bhavcopy/nse-fo/raw]

Exit 0 = every trade matches to the paisa; 1 = differences (listed).
Standard library only.
"""

import argparse
import csv
import io
import json
import os
import sys
import zipfile
from decimal import Decimal, ROUND_HALF_UP, ROUND_CEILING, ROUND_FLOOR

D = Decimal


def paise(x):
    return D(x).quantize(D("0.01"), rounding=ROUND_HALF_UP)


# ---- Charge schedules (typed from sources, independent of src/config) -------------------------
# 2024-10-01 .. 2026-03-31: STT 0.10 % sell premium, 0.125 % exercise intrinsic (Finance (No.2) Act 2024)
# 2026-04-01 ..           : STT 0.15 % sell premium, 0.15 % exercise intrinsic (Union Budget 2026)
# Both: NSE txn 0.03553 % premium, SEBI Rs 10/crore, stamp 0.003 % buy, GST 18 % on brokerage+txn+SEBI.
def schedule(date):
    if "2024-10-01" <= date <= "2026-03-31":
        return dict(stt_sell=D("0.001"), stt_ex=D("0.00125"))
    if date >= "2026-04-01":
        return dict(stt_sell=D("0.0015"), stt_ex=D("0.0015"))
    raise SystemExit(f"no schedule for {date}")


TXN = D("0.0003553")
SEBI_PER_CRORE = D("10")
STAMP_BUY = D("0.00003")
GST = D("0.18")
BROKERAGE = D("20")


def order_costs(side, qty, price, date):
    s = schedule(date)
    t = D(qty) * price
    brokerage = BROKERAGE if t > 0 else D(0)
    stt = paise(t * s["stt_sell"]) if side == "SELL" else D(0)
    txn = paise(t * TXN)
    sebi = paise(t / D(10_000_000) * SEBI_PER_CRORE)
    stamp = paise(t * STAMP_BUY) if side == "BUY" else D(0)
    gst = paise((brokerage + txn + sebi) * GST)
    return brokerage + stt + txn + sebi + stamp + gst


def settlement_costs(intrinsic, signed_qty, date, plan):
    s = schedule(date)
    if intrinsic == 0:
        outcome = "OTM"
    else:
        outcome = "EXERCISED" if signed_qty > 0 else "ASSIGNED"
    stt = paise(intrinsic * abs(signed_qty) * s["stt_ex"]) if outcome == "EXERCISED" else D(0)
    charged = outcome in ("EXERCISED", "ASSIGNED") or (plan == "r2" and outcome == "OTM")
    brokerage = BROKERAGE if charged else D(0)
    return stt + brokerage + paise(brokerage * GST)


# ---- Raw data ---------------------------------------------------------------------------------
def load_day(path):
    with zipfile.ZipFile(path) as z:
        name = z.namelist()[0]
        text = z.read(name).decode("utf-8")
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        if r["TckrSymb"] != "NIFTY" or r["FinInstrmTp"] != "IDO":
            continue
        rows.append(r)
    return rows


def num(s):
    s = (s or "").strip()
    return D(s) if s else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--golden", required=True)
    ap.add_argument("--plan", choices=["r2", "r3"], default=None)
    ap.add_argument("--data", default=os.path.join(os.path.expanduser("~"), ".options-hq", "data", "bhavcopy", "nse-fo", "raw"))
    ap.add_argument("--spread", choices=["V1"], default="V1")
    a = ap.parse_args()

    golden = json.load(open(a.golden, encoding="utf-8"))
    plan = a.plan or ("r2" if golden["brokeragePlanId"].endswith("r2") else "r3")
    if golden["spreadModel"] != "EOD_PESSIMISTIC_V1":
        raise SystemExit("only EOD_PESSIMISTIC_V1 is re-implemented")
    lo, hi = golden["from"], golden["to"]

    dates = sorted(f[:10] for f in os.listdir(a.data) if f.endswith(".csv.zip") and lo <= f[:10] <= hi)
    cache = {}

    def day(d):
        if d not in cache:
            cache[d] = load_day(os.path.join(a.data, f"{d}.csv.zip"))
            if len(cache) > 6:
                cache.pop(next(iter(cache)))
        return cache[d]

    TICK = D("0.05")

    def half_spread(close):
        return max(D("0.10"), D("0.02") * close)

    def to_tick(x, up):
        q = (x / TICK).to_integral_value(rounding=ROUND_CEILING if up else ROUND_FLOOR)
        return q * TICK

    trades = []
    open_pos = None
    pending = None
    for i, d in enumerate(dates):
        rows = day(d)
        # fill
        if pending:
            p, pending = pending, None
            if d < p["expiry"]:
                legs = []
                ok = True
                for (typ, strike, side) in p["legs"]:
                    r = next((r for r in rows if r["XpryDt"] == p["expiry"] and r["OptnTp"] == typ and num(r["StrkPric"]) == strike), None)
                    close = num(r["ClsPric"]) if r else None
                    vol = num(r["TtlTradgVol"]) if r else None
                    if not r or not close or close <= 0 or not vol or vol <= 0:
                        ok = False
                        break
                    h = half_spread(close)
                    fill = to_tick(close + h, True) if side == "BUY" else max(TICK, to_tick(close - h, False))
                    legs.append(dict(typ=typ, strike=strike, side=side, close=close, fill=fill, lot=int(r["NewBrdLotQty"])))
                if ok:
                    open_pos = dict(expiry=p["expiry"], entry=d, legs=legs)
        # settle
        if open_pos and d > open_pos["expiry"]:
            raise SystemExit(f"position {open_pos['expiry']} unsettled")
        if open_pos and d == open_pos["expiry"]:
            exp_rows = [r for r in rows if r["XpryDt"] == d]
            sps = {num(r["SttlmPric"]) for r in exp_rows}
            if len(sps) != 1:
                raise SystemExit(f"{d}: settlement prices disagree {sps}")
            sp = sps.pop()
            gross = D(0); costs = D(0); slip = D(0)
            for l in open_pos["legs"]:
                q = l["lot"]
                intrinsic = max(sp - l["strike"], D(0)) if l["typ"] == "CE" else max(l["strike"] - sp, D(0))
                signed = q if l["side"] == "BUY" else -q
                gross += (-l["close"] if l["side"] == "BUY" else l["close"]) * q + intrinsic * signed
                slip += (l["fill"] - l["close"] if l["side"] == "BUY" else l["close"] - l["fill"]) * q
                costs += order_costs(l["side"], q, l["fill"], open_pos["entry"])
                costs += settlement_costs(intrinsic, signed, d, plan)
            trades.append(dict(id=f"NIFTY-{d}", entryDate=open_pos["entry"], settlementPrice=sp,
                               grossPnL=paise(gross), totalCosts=paise(costs + slip), slippage=paise(slip),
                               netPnL=paise(gross - costs - slip)))
            open_pos = None
        # evening signal (documented rule)
        if open_pos is None and any(r["XpryDt"] == d for r in rows):
            nexts = sorted({r["XpryDt"] for r in rows if r["XpryDt"] > d})
            unders = {num(r["UndrlygPric"]) for r in rows if num(r["UndrlygPric"]) is not None}
            if nexts and len(unders) == 1:
                S = unders.pop(); E = nexts[0]
                chain = [r for r in rows if r["XpryDt"] == E]
                def k(r): return num(r["StrkPric"])
                puts = sorted((r for r in chain if r["OptnTp"] == "PE"), key=k)
                calls = sorted((r for r in chain if r["OptnTp"] == "CE"), key=k)
                sp_ = next((r for r in reversed(puts) if k(r) <= D("0.98") * S), None)
                lp_ = sp_ and next((r for r in reversed(puts) if k(r) <= k(sp_) - D("0.01") * S), None)
                sc_ = next((r for r in calls if k(r) >= D("1.02") * S), None)
                lc_ = sc_ and next((r for r in calls if k(r) >= k(sc_) + D("0.01") * S), None)
                def traded(r): return r is not None and (num(r["TtlTradgVol"]) or 0) > 0 and (num(r["ClsPric"]) or 0) > 0
                if all(traded(x) for x in (sp_, lp_, sc_, lc_)) and i < len(dates) - 1:
                    pending = dict(expiry=E, legs=[("PE", k(lp_), "BUY"), ("PE", k(sp_), "SELL"),
                                                   ("CE", k(sc_), "SELL"), ("CE", k(lc_), "BUY")])
                elif not all(traded(x) for x in (sp_, lp_, sc_, lc_)):
                    print(f"NOTE {d}: signal not taken (a leg untraded/missing on signal day)")
            elif len(unders) > 1:
                raise SystemExit(f"{d}: more than one NIFTY underlying value {unders}")

    # compare
    gt = {t["id"]: t for t in golden["perTrade"]}
    diffs = []
    for t in trades:
        g = gt.pop(t["id"], None)
        if not g:
            diffs.append(f"{t['id']}: not in golden"); continue
        for key in ("entryDate", "settlementPrice", "grossPnL", "totalCosts", "slippage", "netPnL"):
            mine = t[key] if key == "entryDate" else D(str(t[key]))
            theirs = g[key] if key == "entryDate" else D(str(g[key]))
            if mine != theirs:
                diffs.append(f"{t['id']} {key}: independent {mine} vs engine {theirs}")
    for k in gt:
        diffs.append(f"{k}: in golden only")
    net = sum(D(str(t["netPnL"])) for t in trades)
    gross = sum(D(str(t["grossPnL"])) for t in trades)
    print(f"independent: {len(trades)} trades, gross {gross}, net {net} (plan {plan}); golden: {golden['trades']} trades, gross {golden['grossTotal']}, net {golden['netTotal']}")
    if diffs:
        print(f"DIFFERENCES ({len(diffs)}):")
        for x in diffs[:50]:
            print("  " + x)
        return 1
    print("MATCH: every trade agrees to the paisa.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
