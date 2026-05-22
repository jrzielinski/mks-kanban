import { scanSecrets, formatSecretsError } from './secrets-scanner';

describe('secrets-scanner', () => {
  beforeEach(() => {
    delete process.env.MAKESTUDIO_DISABLE_SECRETS_SCANNER;
  });

  describe('scanSecrets — true positives', () => {
    it('detects AWS access keys (AKIA prefix)', () => {
      const findings = scanSecrets('export AWS_KEY=AKIAIOSFODNN7EXAMPLE');
      expect(findings).toHaveLength(1);
      expect(findings[0].pattern).toBe('AWS access key');
      expect(findings[0].sample).toMatch(/^AKIAIO…$/);
    });

    it('detects ASIA session keys', () => {
      const findings = scanSecrets('key: ASIA1234567890ABCDEF');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].pattern).toBe('AWS access key');
    });

    it('detects GitHub PATs (ghp_)', () => {
      const findings = scanSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyzABCD123456');
      expect(findings).toHaveLength(1);
      expect(findings[0].pattern).toBe('GitHub personal-access token');
    });

    it('detects Anthropic keys (sk-ant-)', () => {
      const findings = scanSecrets('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(findings.length).toBeGreaterThan(0);
      // Anthropic comes before generic OpenAI sk- match, so the
      // Anthropic detector should fire first.
      const names = findings.map((f) => f.pattern);
      expect(names).toContain('Anthropic API key');
    });

    it('detects PEM private key blocks', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      const findings = scanSecrets(pem);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].pattern).toBe('Private key block');
    });

    it('detects postgres DSN with inline password', () => {
      const findings = scanSecrets('DATABASE_URL=postgres://admin:s3cr3t@db.host:5432/app');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.pattern === 'Postgres DSN with password')).toBe(true);
    });

    it('detects 3-segment JWTs', () => {
      const jwt = 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const findings = scanSecrets(jwt);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.pattern === 'Generic JWT (3-segment)')).toBe(true);
    });

    it('reports the line number of each finding', () => {
      const content = 'line 1\nline 2\nleak=AKIAIOSFODNN7EXAMPLE\nline 4';
      const findings = scanSecrets(content);
      expect(findings).toHaveLength(1);
      expect(findings[0].line).toBe(3);
    });

    it('truncates the leaked sample to 6 chars + ellipsis', () => {
      const findings = scanSecrets('ghp_abcdefghijklmnopqrstuvwxyzABCD123456');
      expect(findings[0].sample.length).toBeLessThanOrEqual(8);
      expect(findings[0].sample.endsWith('…')).toBe(true);
    });
  });

  describe('scanSecrets — true negatives', () => {
    it('returns no findings for empty content', () => {
      expect(scanSecrets('')).toEqual([]);
    });

    it('returns no findings for ordinary code', () => {
      const code = 'function hello(name: string) { return `hi, ${name}`; }';
      expect(scanSecrets(code)).toEqual([]);
    });

    it('does not flag short placeholder values (sk-test)', () => {
      // 'sk-test' is too short for OpenAI pattern (requires 20+ char tail)
      const findings = scanSecrets('apiKey: "sk-test"');
      expect(findings.find((f) => f.pattern === 'OpenAI API key')).toBeUndefined();
    });

    it('does not flag postgres DSN without inline password', () => {
      const findings = scanSecrets('postgres://admin@db.host:5432/app');
      expect(findings.find((f) => f.pattern === 'Postgres DSN with password')).toBeUndefined();
    });
  });

  describe('env override', () => {
    it('returns no findings when MAKESTUDIO_DISABLE_SECRETS_SCANNER=1', () => {
      process.env.MAKESTUDIO_DISABLE_SECRETS_SCANNER = '1';
      const findings = scanSecrets('AKIAIOSFODNN7EXAMPLE');
      expect(findings).toEqual([]);
    });
  });

  describe('formatSecretsError', () => {
    it('produces a human-readable error with hints', () => {
      const findings = scanSecrets('AKIAIOSFODNN7EXAMPLE');
      const msg = formatSecretsError(findings, 'src/config.ts');
      expect(msg).toContain('Refusing to write src/config.ts');
      expect(msg).toContain('AWS access key');
      expect(msg).toContain('process.env.AWS_ACCESS_KEY_ID');
      expect(msg).toContain('MAKESTUDIO_DISABLE_SECRETS_SCANNER');
    });
  });
});
