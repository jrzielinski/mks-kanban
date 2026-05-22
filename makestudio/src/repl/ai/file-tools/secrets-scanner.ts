/**
 * secrets-scanner.ts — pre-Write/Edit guard against accidental secret
 * commits.
 *
 * Detects high-confidence secret patterns in content the model is about
 * to write. If a match is found, the Write/Edit is rejected before
 * touching disk; the model gets the matched pattern (NOT the value)
 * back in the tool_result and can apologise + replace with a placeholder
 * before re-trying.
 *
 * Designed for high precision over high recall — every false positive
 * forces the model to escape valid content. The regexes here only
 * match shapes that have NO LEGITIMATE CODE USE (raw AWS access keys,
 * full JWTs in source, BEGIN PRIVATE KEY blocks, postgres dsns with
 * inline password, GitHub PATs). Generic "password" tokens are NOT
 * flagged — those routinely appear in test fixtures and docs.
 *
 * Env override `MAKESTUDIO_DISABLE_SECRETS_SCANNER=1` skips the scan
 * (useful when the scanner becomes the bottleneck, e.g. snapshot files).
 */

interface SecretPattern {
  name: string;
  regex: RegExp;
  /** Optional extra check after regex match — e.g. AWS key checksum. */
  validate?: (match: string) => boolean;
  /** Hint shown back to the model so it knows what to fix. */
  hint: string;
}

const PATTERNS: SecretPattern[] = [
  {
    name: 'AWS access key',
    // AKIA + 16 alphanum, or ASIA (session) — strict prefix avoids
    // matching coincidental 20-char strings.
    regex: /\b(?:AKIA|ASIA|AIDA|AGPA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g,
    hint: 'load from env (process.env.AWS_ACCESS_KEY_ID) or AWS SDK credential chain',
  },
  {
    name: 'AWS secret key',
    // 40-char base64-ish following an aws_secret_access_key= or similar.
    regex: /aws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
    hint: 'load from env (process.env.AWS_SECRET_ACCESS_KEY) — never commit',
  },
  {
    name: 'GitHub personal-access token',
    // ghp_/ghs_/gho_/ghu_/ghr_ + 36 alphanum
    regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
    hint: 'load from env (process.env.GITHUB_TOKEN)',
  },
  {
    name: 'OpenAI API key',
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    validate: (m) => m.length >= 24 && !m.includes(' '),
    hint: 'load from env (process.env.OPENAI_API_KEY)',
  },
  {
    name: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
    hint: 'load from env (process.env.ANTHROPIC_API_KEY)',
  },
  {
    name: 'Slack token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    hint: 'load from env / secret manager',
  },
  {
    name: 'Stripe live key',
    regex: /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}\b/g,
    hint: 'load from env (process.env.STRIPE_SECRET_KEY) — live keys belong only in production env vars',
  },
  {
    name: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    hint: 'load from env',
  },
  {
    name: 'Private key block',
    // Matches PEM-style BEGIN PRIVATE KEY / RSA PRIVATE KEY headers.
    regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    hint: 'private keys belong on disk via env-pointed paths or a secret store, never inline in source',
  },
  {
    name: 'Postgres DSN with password',
    // postgres://user:pass@host (plus mysql:// / mongodb:// variants).
    // Allow user but require :something@ — common false positive is
    // "postgres://user@host" which has no password.
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb)(?:\+srv)?:\/\/[^:\s@/]+:[^@\s/]+@[^\s/]+/g,
    hint: 'use postgres://user@host with PGPASSWORD env, or load full DSN from env (process.env.DATABASE_URL)',
  },
  {
    name: 'Generic JWT (3-segment)',
    // header.payload.signature — base64url segments.
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    hint: 'tokens are session-bound and should not be in source — load from env or secure store',
  },
];

export interface SecretFinding {
  pattern: string;
  hint: string;
  /** Sample of the match (truncated, no full value leaked). */
  sample: string;
  /** 1-indexed line number where it was found. */
  line: number;
}

export function scanSecrets(content: string): SecretFinding[] {
  if (!content || process.env.MAKESTUDIO_DISABLE_SECRETS_SCANNER === '1') return [];

  const findings: SecretFinding[] = [];
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.regex.exec(content)) !== null) {
      if (p.validate && !p.validate(m[0])) continue;
      // Truncate sample to first 6 + '…' so the model can identify
      // WHERE the secret is without the tool_result actually carrying
      // a usable copy of it.
      const sample = m[0].length > 12 ? m[0].slice(0, 6) + '…' : m[0];
      // Compute line number from match index — cheap one-pass scan.
      let line = 1;
      for (let i = 0; i < m.index; i++) if (content.charCodeAt(i) === 10) line++;
      findings.push({ pattern: p.name, hint: p.hint, sample, line });
      // Cap at 5 findings per pattern to keep the error message short.
      if (findings.filter((f) => f.pattern === p.name).length >= 5) break;
    }
  }
  return findings;
}

export function formatSecretsError(findings: SecretFinding[], filePath: string): string {
  const lines: string[] = [
    `Refusing to write ${filePath} — content contains likely secrets:`,
    '',
  ];
  for (const f of findings) {
    lines.push(`  • ${f.pattern} at line ${f.line} (${f.sample}) — ${f.hint}`);
  }
  lines.push('');
  lines.push(
    'Replace the literal value with a config lookup (env var, secret manager, ' +
    'or .env file referenced via dotenv) before re-issuing the Write. ' +
    'If this match is a false positive (e.g. a placeholder or test fixture), ' +
    'set MAKESTUDIO_DISABLE_SECRETS_SCANNER=1 in the environment.',
  );
  return lines.join('\n');
}
