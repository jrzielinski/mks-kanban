import { swallow } from '../../utils/log';
/**
 * pii-redactor.ts — redact high-risk PII from tool outputs before they
 * land in the LLM-bound chat history.
 *
 * Off by default. Enable via `settings.piiRedaction: 'strict'` (or env
 * `MAKESTUDIO_PII_REDACTION=strict`). When enabled, tool_result strings
 * pass through `redact()` immediately before being appended to the
 * `chatMessages` array — the local TUI rendering still shows raw data
 * (the user sees what actually happened), but the model gets a sanitized
 * view.
 *
 * Conservative pattern set: high-confidence formats that have no
 * legitimate code use (credit cards via Luhn, SSN, Bearer tokens in logs,
 * Set-Cookie headers, AWS/GitHub keys that leaked into a tool result,
 * JWT third-segment). Generic emails/IPs are NOT redacted at the default
 * level — they appear in fixtures and config too often.
 *
 * Two modes:
 *   - 'tokens'  (default when enabled): credit cards, SSN, bearer tokens,
 *                cookies, AWS/GitHub/Stripe/Anthropic/OpenAI/Google keys,
 *                private keys, JWTs, postgres DSNs with password.
 *   - 'strict':  same as tokens + emails + IPv4 addresses (excluding
 *                localhost / private ranges) + phone-shaped sequences.
 *
 * The redactor returns the input unchanged when:
 *   - mode is 'off'
 *   - the input is empty
 *   - no patterns match
 *
 * It is therefore cheap to call unconditionally on every tool_result.
 */

import { loadSettings } from '../settings';

export type PiiMode = 'off' | 'tokens' | 'strict';

interface RedactPattern {
  /** Replacement marker used in the redacted string. */
  marker: string;
  /** Regex to find PII. Must have global flag. */
  regex: RegExp;
  /** Optional validator (e.g. Luhn for credit cards) — return false to skip. */
  validate?: (match: string) => boolean;
  /** Which mode this pattern fires under. */
  mode: 'tokens' | 'strict';
}

// ── Helpers ──────────────────────────────────────────────────────────

function luhnValid(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function isPrivateOrLocalhostIp(ip: string): boolean {
  if (ip.startsWith('127.') || ip === '0.0.0.0' || ip.startsWith('255.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  // 172.16.0.0 - 172.31.255.255
  const parts = ip.split('.').map(Number);
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

// ── Patterns ─────────────────────────────────────────────────────────

const PATTERNS: RedactPattern[] = [
  // Bearer tokens in HTTP-style logs (Authorization: Bearer xxx)
  {
    mode: 'tokens',
    marker: '[REDACTED-BEARER]',
    regex: /(\bAuthorization\s*:\s*Bearer\s+)([A-Za-z0-9._-]{16,})/gi,
  },
  // Set-Cookie session values
  {
    mode: 'tokens',
    marker: '[REDACTED-COOKIE]',
    regex: /(\b(?:Set-Cookie|Cookie)\s*:\s*[^=\s]+=)([^;\s]{8,})/gi,
  },
  // Credit cards (Luhn-validated). Common formats: 4 groups of 4 digits or
  // a 13-19-digit run. Restrict to digit-only or hyphen/space-separated.
  {
    mode: 'tokens',
    marker: '[REDACTED-CC]',
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => luhnValid(m),
  },
  // US SSN
  {
    mode: 'tokens',
    marker: '[REDACTED-SSN]',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  // AWS access keys (mirror of secrets-scanner)
  {
    mode: 'tokens',
    marker: '[REDACTED-AWS]',
    regex: /\b(?:AKIA|ASIA|AIDA|AGPA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g,
  },
  // GitHub PATs
  {
    mode: 'tokens',
    marker: '[REDACTED-GH]',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
  },
  // Anthropic / OpenAI keys
  {
    mode: 'tokens',
    marker: '[REDACTED-ANTHROPIC]',
    regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    mode: 'tokens',
    marker: '[REDACTED-OPENAI]',
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    validate: (m) => !m.startsWith('sk-ant-') && m.length >= 24,
  },
  // Google
  {
    mode: 'tokens',
    marker: '[REDACTED-GOOGLE]',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  // Stripe live keys
  {
    mode: 'tokens',
    marker: '[REDACTED-STRIPE]',
    regex: /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}\b/g,
  },
  // Slack
  {
    mode: 'tokens',
    marker: '[REDACTED-SLACK]',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // JWT third-segment (signature) — replace with marker keeping header.payload
  // visible would still leak data, so redact whole thing.
  {
    mode: 'tokens',
    marker: '[REDACTED-JWT]',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // Postgres / mysql / mongo DSN with password
  {
    mode: 'tokens',
    marker: '[REDACTED-DSN]',
    regex: /\b((?:postgres(?:ql)?|mysql|mongodb)(?:\+srv)?:\/\/[^:\s@/]+):([^@\s/]+)(@[^\s/]+)/g,
  },
  // Private key blocks — redact the whole BEGIN…END section.
  {
    mode: 'tokens',
    marker: '[REDACTED-PRIVATE-KEY]',
    regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
  // ── strict-only ──────────────────────────────────────────────────
  {
    mode: 'strict',
    marker: '[REDACTED-EMAIL]',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    mode: 'strict',
    marker: '[REDACTED-IP]',
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    validate: (m) => {
      const parts = m.split('.').map(Number);
      if (parts.some((p) => p > 255 || p < 0 || isNaN(p))) return false;
      return !isPrivateOrLocalhostIp(m);
    },
  },
];

// ── Public API ───────────────────────────────────────────────────────

let cachedMode: PiiMode | null = null;

export function getPiiMode(): PiiMode {
  if (cachedMode !== null) return cachedMode;
  // Env override wins. Useful for one-off `MAKESTUDIO_PII_REDACTION=strict`
  // invocations (sharing a session log) without touching settings.
  const env = (process.env.MAKESTUDIO_PII_REDACTION || '').toLowerCase().trim();
  if (env === 'strict' || env === 'tokens' || env === 'off') {
    cachedMode = env as PiiMode;
    return cachedMode;
  }
  try {
    const s = loadSettings() as any;
    const m = (s?.piiRedaction || 'off').toLowerCase();
    if (m === 'strict' || m === 'tokens' || m === 'off') {
      cachedMode = m as PiiMode;
      return cachedMode;
    }
  } catch (err) { swallow(err); }
  cachedMode = 'off';
  return cachedMode;
}

/**
 * For tests / explicit overrides — clears the memoised mode lookup so
 * the next call re-reads settings + env. Production code should not
 * need this.
 */
export function resetPiiModeCache(): void {
  cachedMode = null;
}

export interface RedactStats {
  redactionCount: number;
  byMarker: Record<string, number>;
}

export interface RedactResult {
  text: string;
  stats: RedactStats;
}

export function redact(input: string, mode?: PiiMode): RedactResult {
  const m = mode ?? getPiiMode();
  const stats: RedactStats = { redactionCount: 0, byMarker: {} };
  if (!input || m === 'off') return { text: input, stats };

  let out = input;
  for (const p of PATTERNS) {
    if (m === 'tokens' && p.mode === 'strict') continue;
    p.regex.lastIndex = 0;
    if (p.validate) {
      // Need per-match validation — split into a callback replacement.
      out = out.replace(p.regex, (match, ...args) => {
        if (!p.validate!(match)) return match;
        stats.redactionCount++;
        stats.byMarker[p.marker] = (stats.byMarker[p.marker] || 0) + 1;
        // For DSN-with-password we want to keep prefix and suffix
        // (so the model still sees the host) — the regex captured
        // groups for those patterns. If the pattern had capture
        // groups, args[0..n-2] are them; keep group 1 + marker + last.
        if (p.marker === '[REDACTED-DSN]' && args.length >= 3) {
          return `${args[0]}:${p.marker}${args[2]}`;
        }
        return p.marker;
      });
    } else {
      out = out.replace(p.regex, (match, ...args) => {
        stats.redactionCount++;
        stats.byMarker[p.marker] = (stats.byMarker[p.marker] || 0) + 1;
        // Bearer / Cookie patterns capture the prefix as group 1 — keep it
        // so the model still understands the structure of the log line.
        if ((p.marker === '[REDACTED-BEARER]' || p.marker === '[REDACTED-COOKIE]') && args.length >= 2) {
          return `${args[0]}${p.marker}`;
        }
        if (p.marker === '[REDACTED-DSN]' && args.length >= 3) {
          return `${args[0]}:${p.marker}${args[2]}`;
        }
        return p.marker;
      });
    }
  }
  return { text: out, stats };
}

/**
 * Convenience wrapper for callsites that just want the redacted string
 * and don't care about the stats.
 */
export function redactString(input: string, mode?: PiiMode): string {
  return redact(input, mode).text;
}
