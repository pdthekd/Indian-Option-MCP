# Audit Baseline (Phase 0)

Frozen state of the repository **before** any change made by this audit.
Nothing in this file describes behaviour after the audit branch.

| Item | Value |
|---|---|
| Repository | https://github.com/pdthekd/Indian-Option-MCP |
| Upstream (per `package.json` `repository`) | https://github.com/devag7/Indian-Option-MCP — **different owner**; see SECURITY_AUDIT §F |
| Baseline commit SHA | `a00d3eacc181c8994335127fc294133cf3681d7b` |
| Baseline branch | `main` (only branch; no tags) |
| Audit branch | `audit/foundation` |
| Baseline date | 2026-10-03 |
| Package name / version | `indian-option-mcp` / `1.1.0` |
| Node engine requirement | `>=20.0.0` (`package.json` `engines`) |
| Node used for audit | v24.12.0 (npm 11.6.2), Windows 11 |
| Lockfile | `package-lock.json`, lockfileVersion 3, 161 resolved packages, all from `registry.npmjs.org` with sha512 integrity |
| Module format | ESM (`"type": "module"`), TS `module: Node16` |
| Build | `tsc && npx -y esbuild …` (esbuild **not** a declared dependency — fetched unpinned at build time) |

## Declared dependencies (semver ranges) and locked versions

| Package | Kind | Declared range | Locked | Latest at audit |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | runtime | `^1.12.1` | 1.29.0 | 1.32.0 |
| `zod` | runtime | `^3.25.1` | 3.25.76 | 4.6.5 |
| `typescript` | dev | `^5.8.3` | 5.9.3 | 7.0.2 |
| `vitest` | dev | `^3.2.1` | 3.2.4 | 5.0.3 |
| `@types/node` | dev | `^22.15.18` | 22.19.19 | 26.6.4 |
| `esbuild` | **undeclared** (via `npx -y`) | none — whatever npm serves | (0.25.12 present transitively via vite) | — |

MCP SDK version in use: **1.29.0**. Zod version in use: **3.25.76**.

## Packages actually included in the shipped bundle (`dist/bundle.mjs`)

Determined with an esbuild metafile (using the locked esbuild 0.25.12, not `npx -y`):

`@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `fast-deep-equal`, `fast-uri`,
`json-schema-traverse`, `zod`, `zod-to-json-schema`.

express, hono, body-parser, qs, ip-address etc. are installed (SDK dependencies for HTTP
transports) but are **not** bundled or imported at runtime.

## Packages with install scripts (lockfile `hasInstallScript`)

`esbuild` (postinstall binary check), `fsevents` (macOS only). Audit installs used
`npm ci --ignore-scripts`.

## Baseline results

| Command | Result |
|---|---|
| `npm ci --ignore-scripts` | OK |
| `npm run lint` (`tsc --noEmit`) | PASS, 0 errors |
| `npm test` (vitest) | 18/18 PASS — **but** `server.test.ts` performs a live HTTPS request to nseindia.com (non-hermetic) |
| `npm run build` | **Not run as written** (would `npx -y esbuild`, i.e. download-and-execute an unpinned binary). Equivalent build with the locked local esbuild: OK, 862 KB bundle |
| `npm audit` | 11 advisories (1 critical, 6 high, 3 moderate, 1 low) — all transitive or dev; reachability in SECURITY_AUDIT §E |

## Source inventory (baseline)

32 TypeScript files, ~9,600 lines. 27 MCP tools, 1 resource, 2 prompts, all in `src/server.ts`.
Two test files (Black-Scholes, server smoke). No tests for payoff, IV, POP, sizing, margin,
max pain, PCR, OI, expiry calendar, providers, or caching.

## Audit-process disclosure

During dependency inspection the auditor ran `npx --yes license-checker --version` once
(output discarded) — this may have fetched and executed an unpinned npm package on the audit
machine. It did not modify the repository. License data in this audit was taken from
`package-lock.json` instead. Recorded here for completeness.
