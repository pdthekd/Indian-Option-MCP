#!/usr/bin/env python3
"""
Convert a Zerodha F&O contract-note workbook (one sheet per trading day) into PII-free normalized
notes (schema 'contract-note/v1') for `reconcile-cli`.

    python scripts/contract_note_xlsx_to_json.py <contract-notes.xlsx> <out.json>

Kept: trade date, fills (side, quantity, price, instrument kind), charges the broker reported.
Dropped: name, address, PAN, UCC/client code, contract-note numbers, GSTINs, times.
Order numbers are replaced by a salted hash (fills of one order still group together).
Refuses to write inside a git working tree, so personal data cannot be committed by accident.
Requires openpyxl.
"""

import hashlib
import json
import os
import re
import secrets
import subprocess
import sys

import openpyxl

LABELS = {
    "brokerage": r"^Taxable value of Supply \(Brokerage\)",
    "exchangeTxn": r"^Exchange transaction charges",
    "clearing": r"^Clearing charges",
    "stt": r"^Securities transaction tax",
    "sebiFee": r"^SEBI turnover fees",
    "stampDuty": r"^Stamp duty",
    "cgst": r"^CGST",
    "sgst": r"^SGST",
    "igst": r"^IGST",
}


def inside_git_tree(path):
    d = os.path.dirname(os.path.abspath(path)) or "."
    try:
        out = subprocess.run(["git", "-C", d, "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True)
        return out.returncode == 0 and out.stdout.strip() == "true"
    except FileNotFoundError:
        return False


def num(v):
    return float(str(v).replace(",", "")) if v not in (None, "") else 0.0


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    if inside_git_tree(dst):
        raise SystemExit(f"Refusing to write {dst}: it is inside a git working tree. Write it outside the repository.")
    salt = secrets.token_hex(16)  # per conversion; never stored
    hid = lambda o: hashlib.sha256((salt + o).encode()).hexdigest()[:16]

    wb = openpyxl.load_workbook(src, data_only=True, read_only=True)
    notes = []
    for ws in wb.worksheets:
        fills, charges = [], {}
        for r in ws.iter_rows(values_only=True):
            vals = [v for v in r if v not in (None, "")]
            if not vals:
                continue
            s0 = str(vals[0])
            if re.fullmatch(r"\d{10,}", s0) and len(vals) >= 10:
                contract, side = str(vals[4]), str(vals[5]).upper()
                if side not in ("B", "S"):
                    raise SystemExit(f"{ws.title}: unexpected side {side!r}")
                if str(vals[7]).upper() != "NSE":
                    raise SystemExit(f"{ws.title}: non-NSE fill; only NSE F&O is supported")
                kind = "FUTURE" if contract.endswith("FUT") else "OPTION" if contract[-2:] in ("CE", "PE") else None
                if kind is None:
                    raise SystemExit(f"{ws.title}: unrecognised contract kind")
                fills.append(dict(orderId=hid(s0), instrument=kind, side="BUY" if side == "B" else "SELL",
                                  quantity=num(vals[6]), price=num(vals[8])))
                continue
            for key, pat in LABELS.items():
                if re.match(pat, s0) and len(vals) >= 2:
                    charges[key] = -num(vals[1])  # contract notes show charges as negative (payable)
        if not fills:
            continue
        m = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", ws.title.strip())
        if not m:
            raise SystemExit(f"Sheet title {ws.title!r} is not DD-MM-YYYY")
        missing = [k for k in ("brokerage", "exchangeTxn", "stt", "sebiFee", "stampDuty") if k not in charges]
        if missing:
            raise SystemExit(f"{ws.title}: charge rows not found: {missing}")
        notes.append({
            "schema": "contract-note/v1",
            "tradeDate": f"{m.group(3)}-{m.group(2)}-{m.group(1)}",
            "segment": "NSE-FO",
            "fills": fills,
            "reported": {
                "brokerage": charges["brokerage"], "exchangeTxn": charges["exchangeTxn"],
                "clearing": charges.get("clearing", 0.0), "stt": charges["stt"], "sebiFee": charges["sebiFee"],
                "stampDuty": charges["stampDuty"],
                "gst": round(charges.get("cgst", 0.0) + charges.get("sgst", 0.0) + charges.get("igst", 0.0), 2),
            },
        })
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(notes, f, indent=1)
    print(f"{len(notes)} notes, {sum(len(n['fills']) for n in notes)} fills -> {dst}")


if __name__ == "__main__":
    main()
