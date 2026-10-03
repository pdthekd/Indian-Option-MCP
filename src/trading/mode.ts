/**
 * @module trading/mode
 *
 * Trading mode gate. Defaults to `paper`. In this build only `paper` can be
 * used for execution; `sandbox` and `shadow` are recognised but have no
 * adapter yet, and `live` is hard-disabled. There is no code path by which
 * the model (Claude) can change the mode: it is read from the process
 * environment at start-up only.
 */

export type TradingMode = 'paper' | 'sandbox' | 'shadow' | 'live';

export interface ModeDecision {
  mode: TradingMode;
  executionAllowed: boolean;
  reason: string;
}

export function resolveTradingMode(env: Record<string, string | undefined> = process.env): ModeDecision {
  const raw = (env.TRADING_MODE ?? 'paper').trim().toLowerCase();
  switch (raw) {
    case 'paper':
      return { mode: 'paper', executionAllowed: true, reason: 'Paper broker only; no external orders possible.' };
    case 'sandbox':
      return { mode: 'sandbox', executionAllowed: false, reason: 'No sandbox broker adapter implemented yet.' };
    case 'shadow':
      return { mode: 'shadow', executionAllowed: false, reason: 'Shadow mode records hypothetical orders only (not implemented yet).' };
    case 'live':
      // Intentionally unconditional. Enabling live trading requires a code
      // change reviewed against docs/LIVE_TRADING_READINESS.md — not an env var.
      throw new Error('TRADING_MODE=live is disabled in this build. See docs/LIVE_TRADING_READINESS.md.');
    default:
      throw new Error(`Unknown TRADING_MODE "${raw}". Allowed: paper, sandbox, shadow.`);
  }
}
