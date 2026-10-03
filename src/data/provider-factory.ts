// ────────────────────────────────────────────────────────────────────────────
// Provider Factory
//
// Creates the DataProvider selected by configuration. Fails CLOSED: if the
// configured provider cannot be constructed, it throws instead of silently
// switching data source (a silent switch changes data quality without the
// operator knowing).
// ────────────────────────────────────────────────────────────────────────────

import type { DataProvider } from './providers/base.provider.js';
import { NSEProvider } from './providers/nse.provider.js';
import { ZerodhaProvider } from './providers/zerodha.provider.js';

interface ProviderConfig {
  dataProvider: 'nse' | 'zerodha';
  kiteApiKey?: string;
  kiteAccessToken?: string;
}

/**
 * Read provider configuration from the environment.
 *
 * KITE_API_SECRET is intentionally NOT read: it is only needed for the login
 * session exchange, which must be done outside this long-running process.
 */
function loadConfig(): ProviderConfig {
  const raw = (process.env.DATA_PROVIDER ?? 'nse').trim().toLowerCase();
  if (raw !== 'nse' && raw !== 'zerodha') {
    throw new Error(`DATA_PROVIDER must be "nse" or "zerodha" (got "${raw}").`);
  }
  return {
    dataProvider: raw,
    kiteApiKey: process.env.KITE_API_KEY,
    kiteAccessToken: process.env.KITE_ACCESS_TOKEN,
  };
}

/**
 * Create the configured DataProvider.
 *
 * - `DATA_PROVIDER=zerodha` → ZerodhaProvider (requires KITE_API_KEY and
 *   KITE_ACCESS_TOKEN; throws if missing)
 * - `DATA_PROVIDER=nse` or unset → NSEProvider
 */
export function createDataProvider(
  overrideConfig?: Partial<ProviderConfig>,
): DataProvider {
  const cfg = { ...loadConfig(), ...overrideConfig };

  if (cfg.dataProvider === 'zerodha') {
    if (!cfg.kiteApiKey || !cfg.kiteAccessToken) {
      throw new Error(
        'DATA_PROVIDER is "zerodha" but KITE_API_KEY / KITE_ACCESS_TOKEN are missing. ' +
          'Refusing to fall back to a different data source silently.',
      );
    }
    console.error('[ProviderFactory] Using Zerodha (Kite Connect) provider.');
    return new ZerodhaProvider(cfg.kiteApiKey, cfg.kiteAccessToken);
  }

  console.error('[ProviderFactory] Using NSE India provider (unofficial public endpoints).');
  return new NSEProvider();
}
