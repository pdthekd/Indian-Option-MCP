# Strategy Specification (Phase 14)

Code: `src/strategy/strategy-spec.ts` (zod schema, fingerprint, registry).

Strategies are declarative, versioned data. Claude may draft a spec; it may not create or
alter rules at runtime. A spec is required to contain: strategy ID, semver version, status,
eligible underlyings and expiries, structure (defined-risk only), entry / exit / stop /
profit-taking / invalidation conditions, risk limits (max NET loss, lots, concurrency,
holding time), liquidity (min OI, max spread, min data quality), cost assumptions
(schedule IDs, brokerage plan, slippage model) and a changelog whose last entry matches the
version.

Rules enforced by `StrategyRegistry`:
- `strict()` schema — unknown fields rejected.
- `definedRiskOnly` must be `true`.
- Statuses: DRAFT, BACKTEST, PAPER, SHADOW, RETIRED. **There is no LIVE status.**
- Re-registering an `id@version` with different content throws (`Bump the version`).
- `fingerprint()` is a SHA-256 of the canonical spec, to be stored with every proposal and
  trade so "which rules produced this trade?" is answerable.

No strategy in this repository has been validated. The 34 templates in
`engine/strategy-builder.ts` are textbook structures, not strategies.
