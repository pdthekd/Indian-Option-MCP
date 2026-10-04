# Security Audit (Phase 1)

Baseline: `a00d3ea` (see AUDIT_BASELINE.md). Scope: every tracked file, full git history
(14 commits, 1 branch, 0 tags), all deleted files, both GitHub workflows, the lockfile and
the produced bundle.

Severity scale: **CRITICAL** (blocks any use with real money), **HIGH**, **MEDIUM**, **LOW**, **INFO**.

## Summary

| # | Finding | Severity | Status on audit branch |
|---|---|---|---|
| S1 | `README`/`smithery.yaml`/`glama.json`/release notes install via `npx -y indian-option-mcp` — runs whatever the **upstream** npm owner publishes, not this audited source | HIGH | Documented; do not use. Local build from pinned commit required |
| S2 | Build downloads and executes an unpinned esbuild via `npx -y esbuild` | HIGH | **Fixed**: esbuild pinned as devDependency, invoked locally |
| S3 | NSE provider rotates 12 spoofed browser User-Agents and scrapes session cookies to avoid blocking | MEDIUM (compliance / ToS / reliability) | Documented; recommend official broker data feed instead |
| S4 | `KITE_API_SECRET` is read into the long-running MCP process though never used | MEDIUM | **Fixed**: no longer read by the provider factory |
| S5 | Kite access token must sit in the MCP client config / process env in plaintext | MEDIUM | Documented; mitigations listed |
| S6 | Tool input schemas are unbounded (string length, array size, numeric range, NaN-free but ±Infinity allowed, negative prices) | MEDIUM | **Fixed** for all numeric/leg inputs (bounded, finite, positive) |
| S7 | GitHub Actions pinned to mutable tags; no top-level `permissions:`; tag-derived values interpolated into shell | MEDIUM | **Fixed** in CI (least-privilege `permissions`). **Release workflow disabled** (moved to `.github/workflows-disabled/`). SHA pinning still a follow-up |
| S8 | Unit test performs live network call to nseindia.com | LOW | **Fixed**: provider init no longer fires at `createServer()` in tests |
| S9 | Kite HTTP error bodies (≤300 chars) are copied into tool error text returned to the LLM | LOW | Documented (no secrets observed in Kite error schema) |
| S10 | Dead `config.ts` (validated config) is never imported; real config is unvalidated `process.env` reads | LOW | Documented |
| S11 | Upstream author e-mail and local path (`/Users/devagarwalla/...`) in git history/commit metadata | INFO | Public upstream metadata; cannot be removed without history rewrite; no action |
| S12 | No secrets, tokens, keys, cookies, phone numbers or account IDs found in current files or history | INFO | — |

## A. Secrets and personal information

Method: `git log --all -p` over the entire history piped through regexes for
`api_key|secret|token|password|authorization|bearer|cookie|session` assignments,
24+ char quoted high-entropy strings, e-mail addresses, Indian mobile numbers, and all URLs;
plus manual review of deleted files (`debug-mcp.mjs`, `start-mcp.sh`, `test-minimal.mjs`).

Results:
- No credential material anywhere (current tree, deleted files, history). The only hit
  `token: 12345678` is a documentation example of an instrument token.
- `.env.example` contains placeholders only; `.env*` are git-ignored.
- PII: commit author `Dev Agarwalla <devagarwalla2016@gmail.com>` (upstream author, in
  commit metadata) and the path `/Users/devagarwalla/.nvm/...` in deleted `debug-mcp.mjs`.
  Not the repository owner's data. Not secret. Removing requires rewriting public history — not recommended.
- No broker client IDs, account numbers, phone numbers, private URLs.

## B. Dangerous code

Searched `src/` for `child_process`, `exec`, `execSync`, `spawn`, `spawnSync`, `eval`,
`new Function`, dynamic `import()`, `fs.*` writes, `require(`: **none present**.
Deleted `debug-mcp.mjs` used `spawn` (debug harness, not shipped).

- No filesystem access, no shell, no dynamic code loading, no telemetry/analytics, no webhooks.
- `process.env` is read only for `DATA_PROVIDER`, `KITE_API_KEY`, `KITE_API_SECRET`,
  `KITE_ACCESS_TOKEN` (and in dead `config.ts`). No tool can read arbitrary env vars.
- The bundle contains exactly five `fetch(` call sites, all in the NSE and Zerodha providers.

## C. MCP-specific review

Inventory: 27 tools, 1 resource (`market://status`), 2 prompts. Full list in MCP_TEST_REPORT.md.

| Question | Answer |
|---|---|
| Can tool input influence network host? | **No.** Hosts are constants (`https://www.nseindia.com`, `https://api.kite.trade`). `symbol` is placed in query strings via `encodeURIComponent`/`URLSearchParams`. Kite historical path uses `instrumentToken` from the instrument CSV, not user input |
| Can tool input influence filesystem paths? | No filesystem access exists |
| Can tool input influence commands? | No command execution exists |
| Can tools leak env vars / credentials? | No tool returns env values. Kite `Authorization` header is never logged. Error text may contain truncated Kite error body (S9) |
| Can outputs contain secrets? | Not observed. NSE cookies are only logged by length |
| Input validation | Baseline schemas were `z.number()` / `z.string()` with no bounds: negative spot/strike, IV=0, 10⁹-element leg arrays, multi-MB strings all accepted (S6) |
| Tool descriptions | Several are promotional or advisory ("AI-friendly strategy suggestions", "Recommend position sizing"). The `strategy_advisor` prompt instructs the model to "Build the best strategy" — it nudges Claude to act as a recommender. Under the project rules Claude may only propose; see FUNCTIONAL_AUDIT |
| Prompt-injection surface | Market-data strings (timestamps, symbols) and Kite error bodies are echoed into tool output. Sources are TLS-protected first parties; risk LOW |
| Execution capability | **None.** No order placement code exists anywhere in baseline |

## D. Network allowlist

Every runtime destination (from source and bundle):

| Host | Used by | Purpose | Expected? |
|---|---|---|---|
| `www.nseindia.com` | `NSEProvider` | homepage (cookies), `/api/option-chain-indices`, `/api/option-chain-equities`, `/api/liveEquity-derivatives`, `/api/quote-equity`, `/api/allIndices`, `/api/marketStatus` | Yes (unofficial, undocumented endpoints) |
| `api.kite.trade` | `ZerodhaProvider` | `/instruments`, `/quote`, `/quote/ltp`, `/instruments/historical/...` | Yes (only if `DATA_PROVIDER=zerodha`) |
| `nsearchives.nseindia.com` | `history/bhavcopy.ts` (CLI only, not the MCP server) | F&O bhavcopy downloads; `redirect: error`, 60 s timeout, 1.5 s spacing | Yes |

Build/infra only: `registry.npmjs.org` (npm ci / npx), `github.com` (Actions).

**Filesystem writes (added after baseline):** only the CLI tools `dist/bhavcopy-cli.mjs` and
`dist/record-quotes-cli.mjs` write files, under the data root (`~/.options-hq/data` or
`OPTIONS_HQ_DATA_DIR`), which must lie outside the repository (enforced). Paths are built from
validated dates/symbols, never from MCP tool input. The MCP server bundle contains no file-writing
code (verified by inspecting `dist/bundle.mjs`).
Strings such as `raw.githubusercontent.com`, `json-schema.org` in the bundle are ajv
`$id`/`$ref` identifiers, never fetched. **No unexpected destination found.**

## E. Dependencies

`npm audit` (baseline lockfile): 11 advisories.

| Package | Sev. | Path | Bundled/reachable at runtime? | Exploitability here |
|---|---|---|---|---|
| vitest / @vitest/mocker | critical/moderate | dev | No (test only) | Only when the Vitest UI/browser server is listening. Not used. Upgrade to patched 3.2.x |
| vite, postcss, nanoid | high | dev (vitest) | No | Dev server not used |
| fast-uri | high | sdk → ajv | **Bundled** | Host-confusion in URI parsing; reachable only if an input schema uses `format: "uri"` — none do. LOW |
| hono, @hono/node-server | high/mod | sdk | No (HTTP transport not imported) | Not reachable with stdio transport |
| ip-address, qs, body-parser | high/mod/low | sdk → express | No | Not reachable |

**After `npm audit fix` (non-breaking only) on the audit branch:** runtime (`--omit=dev`):
**0 vulnerabilities**. Remaining: 2 moderate in dev-only `vitest`/`@vitest/mocker` (fix
requires vitest 5, a breaking upgrade; the vulnerable redirect-mock path is not used).

Original guidance — safe upgrade path: `npm update @modelcontextprotocol/sdk vitest` within current majors
(SDK 1.32.x, vitest 3.2.7) then re-run audit. **Do not** jump to zod 4 / vitest 5 /
TypeScript 7 without a dedicated migration — breaking changes.

Licenses (from lockfile): MIT 179, ISC 9, BSD-3-Clause 3, Apache-2.0 2, BSD-2-Clause 1. No copyleft.

## F. Supply chain

1. **`npx -y indian-option-mcp` (S1, HIGH).** `package.json` names the upstream repo
   `devag7/Indian-Option-MCP`. The npm package `indian-option-mcp` is published by the
   upstream maintainer's CI with their `NPM_TOKEN`. Running `npx -y` therefore executes code
   that has **not** been audited here and can change at any time, with `-y` suppressing the
   prompt. Required model: clone at an exact commit SHA, `npm ci --ignore-scripts`,
   build locally, point the MCP client at the absolute path of the local `dist/bundle.mjs`.
2. **`npx -y esbuild` in build (S2, HIGH).** Fixed: `esbuild` pinned as an exact devDependency
   and invoked via `node_modules/.bin`.
3. **Semver ranges.** Runtime deps use `^`. The lockfile pins exact versions with sha512
   integrity; CI uses `npm ci`. Acceptable *provided* installs always use `npm ci`.
   Recommendation for the trading phases: exact versions in `package.json` too.
4. **Install scripts.** Only `esbuild` (binary check) and `fsevents`. Use `--ignore-scripts`
   where possible.
5. **Lockfile consistency.** `npm ci` succeeded → lockfile matches `package.json`.

## G. GitHub Actions

`ci.yml` (push/PR to main):
- Uses `pull_request` (not `pull_request_target`) → fork PRs get no secrets. Good.
- No `permissions:` block → inherits repo default (may be read/write). **Fixed** to `contents: read`.
- `actions/checkout@v4`, `actions/setup-node@v4` pinned by mutable tag (follow-up: pin to SHA).
- Smoke test pipes a JSON-RPC `initialize` into the bundle — no untrusted input.

`release.yml` (on `v*` tags):
- `permissions: contents: write, id-token: write` at workflow level, applied to every job,
  including `validate` which needs neither. Should be per-job.
- `${{ needs.validate.outputs.version }}` (derived from the tag name) is interpolated directly
  into `run:` scripts. Git ref names may contain `$`, `(`, `)`, `;`, backticks →
  **command injection by anyone able to push a tag** (insider-only; MEDIUM). Pass via `env:`.
- `softprops/action-gh-release@v2` — third-party action on a mutable tag with `contents: write`.
- Publishes to npm under the upstream package name. For this fork this either fails or
  (if the owner ever obtains rights) publishes. Recommendation: disable the release workflow
  until a deliberate distribution decision is made. Left unchanged on the audit branch
  (outward-facing; requires owner decision).

## H. Logging

All logging uses `console.error` (stderr) — stdout is reserved for JSON-RPC. Verified that:
- `Authorization` header, API key, access token, secret: never logged.
- NSE cookies: only length logged.
- Full broker responses: not logged. Kite error bodies truncated to 300 chars are placed in
  thrown `Error` messages which the MCP SDK returns to the client as tool error text (S9).
- `index.ts` logs `DATA_PROVIDER` only.
- No PII is logged.

Requirement for future phases: a central redacting logger (keys matching
`/token|secret|key|authorization|cookie|password/i` replaced with `[REDACTED]`) must be used
by every broker adapter; added as `src/utils/redact.ts` with tests.

## What this audit does **not** cover

- The behaviour of the npm-published package (not this source).
- Runtime behaviour against real Zerodha credentials (none used; none should be).
- NSE's terms of use for automated access (legal review recommended).

## Re-audit, Foundation phase (2026-10-04)

| Check | Method | Result |
|---|---|---|
| Secrets / PII in the **full git history** | `git log --all -p` grepped for the account's client code, PAN-format strings, the owner's name and e-mail, private-key headers, GitHub/API token formats, `api_secret=` / `access_token=` assignments | **0 matches** |
| Tracked files | `git ls-files` outside src/docs/scripts/.github/research | only project metadata (`.env.example` holds placeholders only) |
| Personal broker files | Contract-note workbook and tradebook kept outside git; `.gitignore` now blocks `*.xlsx`, `*.xls`, `*.pdf`, tradebooks, contract-note JSON/CSV/ZIP, `*.pem`, `*.key`, `*access_token*`, `*.session` for every clone (previously only the local `.git/info/exclude`) | protected |
| Contract-note pipeline | `scripts/contract_note_xlsx_to_json.py` drops name, address, PAN, client code and note numbers, salts and hashes order numbers, and **refuses to write inside a git working tree** (tested). Docs contain aggregates only | PASS |
| Production dependencies | `npm audit --omit=dev` | 0 vulnerabilities |
| Dev dependencies | `npm audit` | 2 moderate: vitest ≤ 4.1.10 / @vitest/mocker path traversal (GHSA-82fw-gwwq-j7x9). Dev/test only, never shipped or run on untrusted input. Fixed later the same day: vitest 5.0.3; `npm audit` now reports 0 vulnerabilities |
| Order paths | grep for order/portfolio/margin/GTT endpoints and non-GET broker calls | none; the Kite provider calls only `/quote`, `/quote/ltp`, historical and instruments |
| BrokerAdapter implementations | grep | only `PaperBroker` |
| Live mode | `resolveTradingMode` | `TRADING_MODE=live` **throws unconditionally**. sandbox/shadow return `executionAllowed: false`. Unknown values throw. No silent fallback from paper/sandbox to live exists, because no live adapter exists |
| MCP surface | the 29 registered tools | all analysis/estimation; **no tool can place orders, change trading mode or reach the ExecutionEngine** |
| Assistant connectors | Angel One / IBKR / INDmoney connectors exist in the assistant environment | not used; not referenced by code; documented as must-not-wire |

Residual risks: a future live adapter would be the first component able to move money. It must ship
behind LIVE_TRADING_READINESS.md, a reviewed code change (not an environment variable), the redacting
logger, and the RiskGateway / KillSwitch / human-confirmation path. The read-only Kite token, if
configured, is a credential and must stay in the environment, never in files.
