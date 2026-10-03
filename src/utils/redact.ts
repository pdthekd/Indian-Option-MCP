/**
 * @module utils/redact
 * Remove credential-like material from strings and objects before they reach
 * logs, error messages, tool output or reports.
 */

const SENSITIVE_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|session|checksum|request[_-]?token)/i;

/** Patterns of credential material that may appear inside free text. */
const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // "Authorization: token key:access" / "Bearer xyz"
  [/\b(authorization\s*[:=]\s*)(token|bearer)?\s*[^\s,;"'}]+(:[^\s,;"'}]+)?/gi, '$1[REDACTED]'],
  [/\b(token|bearer)\s+[A-Za-z0-9._~+/=-]{8,}(:[A-Za-z0-9._~+/=-]{8,})?/gi, '$1 [REDACTED]'],
  // key=value / "key":"value" for sensitive keys
  [/(["']?(?:access_token|request_token|api_key|api_secret|refresh_token|enctoken|password|secret|checksum)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi, '$1[REDACTED]'],
  // Cookie headers
  [/\b(cookie\s*[:=]\s*)[^\n]+/gi, '$1[REDACTED]'],
];

/** Redact credential-like substrings from free text. */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of TEXT_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-copy an object replacing values of sensitive keys with "[REDACTED]". */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 10) return '[TRUNCATED]' as unknown as T;
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactObject(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
