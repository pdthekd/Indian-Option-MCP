#!/usr/bin/env python3
"""
Data-integrity audit of the stored RAW NSE F&O bhavcopy zips (independent of the TypeScript code).

    python scripts/audit_bhavcopy.py [--data <raw dir>] [--from 2024-10-01] [--to 2026-10-01] [--json out.json]

Checks every row of every file; prints counts and the first examples of each finding. Findings are
facts about the data, not automatically errors: e.g. untraded contracts legitimately carry a
non-traded close. Standard library only.
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import zipfile
from collections import defaultdict

IDX_OPT = "IDO"


def f(s):
    s = (s or "").strip()
    return float(s) if s else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(os.path.expanduser("~"), ".options-hq", "data", "bhavcopy", "nse-fo", "raw"))
    ap.add_argument("--from", dest="lo", default="2024-10-01")
    ap.add_argument("--to", dest="hi", default="2026-10-01")
    ap.add_argument("--json")
    a = ap.parse_args()

    files = sorted(x for x in os.listdir(a.data) if x.endswith(".csv.zip") and a.lo <= x[:10] <= a.hi)
    find = defaultdict(list)
    counts = defaultdict(int)
    nifty_under = {}
    nifty_expiries = set()
    nifty_expiry_days = set()
    lot_by_day_expiry = defaultdict(set)

    def note(kind, msg):
        counts[kind] += 1
        if len(find[kind]) < 5:
            find[kind].append(msg)

    for fn in files:
        d = fn[:10]
        with zipfile.ZipFile(os.path.join(a.data, fn)) as z:
            names = z.namelist()
            if len(names) != 1:
                note("zip_member_count", f"{d}: {names}")
            text = z.read(names[0]).decode("utf-8")
        seen = set()
        unders = defaultdict(set)
        settle = defaultdict(set)
        nrows = 0
        for r in csv.DictReader(io.StringIO(text)):
            nrows += 1
            if r["TradDt"] != d:
                note("trade_date_mismatch", f"{d}: row TradDt {r['TradDt']}")
            key = (r["FinInstrmTp"], r["TckrSymb"], r["XpryDt"], r["StrkPric"], r["OptnTp"])
            if key in seen:
                note("duplicate_contract", f"{d}: {key}")
            seen.add(key)
            o, h, l, c, vol = f(r["OpnPric"]), f(r["HghPric"]), f(r["LwPric"]), f(r["ClsPric"]), f(r["TtlTradgVol"]) or 0
            if r["XpryDt"] < d:
                note("expired_contract_listed", f"{d}: {key}")
            if vol > 0:
                if c is None or c <= 0:
                    note("traded_without_positive_close", f"{d}: {key} close {c}")
                if None not in (h, l, c) and not (l - 1e-9 <= c <= h + 1e-9):
                    note(f"close_outside_high_low[{r['FinInstrmTp']}]", f"{d}: {key} L {l} H {h} C {c}")
                if None not in (h, l, o) and not (l - 1e-9 <= o <= h + 1e-9):
                    note(f"open_outside_high_low[{r['FinInstrmTp']}]", f"{d}: {key} L {l} H {h} O {o}")
                if None not in (h, l) and h < l:
                    note("high_below_low", f"{d}: {key}")
            else:
                counts["untraded_rows"] += 1
            for name, v in (("OpnPric", o), ("HghPric", h), ("LwPric", l), ("ClsPric", c)):
                if v is not None and v < 0:
                    note("negative_price", f"{d}: {key} {name} {v}")
            if (f(r["OpnIntrst"]) or 0) < 0:
                note("negative_open_interest", f"{d}: {key}")
            if not (r["NewBrdLotQty"] or "").strip().isdigit() or int(r["NewBrdLotQty"]) <= 0:
                note("bad_lot_size", f"{d}: {key} {r['NewBrdLotQty']}")
            if r["FinInstrmTp"] == IDX_OPT:
                if r["UndrlygPric"]:
                    unders[r["TckrSymb"]].add(r["UndrlygPric"])
                if r["XpryDt"] == d:
                    settle[r["TckrSymb"]].add(r["SttlmPric"])
                    if r["TckrSymb"] == "NIFTY":
                        nifty_expiry_days.add(d)
                if r["TckrSymb"] == "NIFTY":
                    nifty_expiries.add(r["XpryDt"])
                    lot_by_day_expiry[(d, r["XpryDt"])].add(r["NewBrdLotQty"])
        counts["rows"] += nrows
        if nrows == 0:
            note("empty_file", d)
        for sym, u in unders.items():
            if len(u) != 1:
                note("index_underlying_not_unique", f"{d} {sym}: {sorted(u)[:4]}")
        for sym, s in settle.items():
            if len(s) != 1:
                note("expiry_settlement_not_unique", f"{d} {sym}: {sorted(s)[:4]}")
        if len(unders.get("NIFTY", ())) == 1:
            nifty_under[d] = float(next(iter(unders["NIFTY"])))

    for (d, e), lots in lot_by_day_expiry.items():
        if len(lots) != 1:
            note("nifty_lot_not_unique_per_expiry", f"{d} exp {e}: {lots}")

    # weekday coverage (holidays are NOT applied here; compare the list with the official circulars)
    days = [x[:10] for x in files]
    have = set(days)
    cur = dt.date.fromisoformat(days[0]); end = dt.date.fromisoformat(days[-1])
    missing_weekdays = []
    while cur <= end:
        s = cur.isoformat()
        if cur.weekday() < 5 and s not in have:
            missing_weekdays.append(s)
        cur += dt.timedelta(days=1)
    weekend_files = [x for x in days if dt.date.fromisoformat(x).weekday() >= 5]

    # NIFTY close-to-close moves
    ds = sorted(nifty_under)
    big = []
    for p, q in zip(ds, ds[1:]):
        ch = nifty_under[q] / nifty_under[p] - 1
        if abs(ch) >= 0.03:
            big.append(f"{q}: {ch * 100:+.2f}%")

    out = dict(
        files=len(files), first=days[0], last=days[-1], rows=counts["rows"],
        findings={k: dict(count=counts[k], examples=find[k]) for k in sorted(find)},
        untraded_rows=counts["untraded_rows"],
        missing_weekdays=missing_weekdays, weekend_files=weekend_files,
        nifty_expiries_in_range=len([e for e in nifty_expiries if a.lo <= e <= a.hi]),
        nifty_expiry_days_with_data=sorted(nifty_expiry_days),
        nifty_moves_ge_3pct=big,
    )
    print(json.dumps(out, indent=2))
    if a.json:
        json.dump(out, open(a.json, "w"), indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
