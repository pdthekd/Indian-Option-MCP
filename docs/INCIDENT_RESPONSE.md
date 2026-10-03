# Incident Response

Applies to paper trading now and to any future sandbox/live use.

## Triggers (automatic kill switch or manual stop)

- A multi-leg order leaves a leg unfilled (engine engages kill switch automatically).
- Reconciliation discrepancy in quantity, or price/charges beyond tolerance.
- Daily or weekly NET loss limit reached; drawdown limit reached.
- Data quality STALE/UNAVAILABLE during an open position; broker disconnected.
- Journal verification failure.
- Any credential exposure (token in a log, prompt, report, commit or screenshot).

## Immediate steps

1. Engage the kill switch (or confirm it is engaged). Do not place new orders.
2. Snapshot: account, positions, open orders, journal file (copy, do not edit).
3. Unhedged short exposure → a human decides how to flatten, using the broker's own terminal.
4. Credential exposure → revoke the API key / access token at the broker immediately; rotate;
   purge from logs; if committed to git, treat as compromised even after removal.
5. Record the incident: time, trigger, positions, NET P&L impact, root cause, fix, and the
   test that now prevents recurrence.

## Re-enabling

Only after root cause is fixed and tested. Reset with
`KillSwitch.reset(KILL_SWITCH_RESET_PHRASE, operator)` — journaled with operator identity.
Never re-enable to "make back" a loss.
