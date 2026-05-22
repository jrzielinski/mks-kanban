import { redact, redactString, getPiiMode, resetPiiModeCache } from './pii-redactor';

describe('pii-redactor', () => {
  beforeEach(() => {
    delete process.env.MAKESTUDIO_PII_REDACTION;
    resetPiiModeCache();
  });

  describe('off mode (default)', () => {
    it('returns input unchanged', () => {
      const input = 'token=eyJhbGciOi.eyJzdWIi.SflKxwR card=4111111111111111';
      expect(redact(input, 'off').text).toBe(input);
    });

    it('records zero stats', () => {
      const result = redact('AKIAIOSFODNN7EXAMPLE', 'off');
      expect(result.stats.redactionCount).toBe(0);
    });
  });

  describe('tokens mode', () => {
    it('redacts AWS access keys', () => {
      const r = redact('export AWS=AKIAIOSFODNN7EXAMPLE', 'tokens');
      expect(r.text).toContain('[REDACTED-AWS]');
      expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(r.stats.redactionCount).toBe(1);
    });

    it('redacts GitHub PATs', () => {
      const r = redact('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyzABCD123456', 'tokens');
      expect(r.text).toContain('[REDACTED-GH]');
    });

    it('redacts JWTs', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const r = redact(`Authorization: Bearer ${jwt}`, 'tokens');
      // The JWT should be redacted (either via JWT pattern or Bearer)
      expect(r.text).not.toContain(jwt);
    });

    it('preserves Bearer prefix when redacting', () => {
      const r = redact('Authorization: Bearer abcdefghijklmnopqrst1234567890', 'tokens');
      expect(r.text).toContain('Authorization: Bearer ');
      expect(r.text).toContain('[REDACTED-BEARER]');
    });

    it('preserves DSN host when redacting password', () => {
      const r = redact('postgres://admin:secret123@db.host:5432/app', 'tokens');
      expect(r.text).toContain('db.host');
      expect(r.text).toContain('[REDACTED-DSN]');
      expect(r.text).not.toContain('secret123');
    });

    it('redacts SSN', () => {
      const r = redact('SSN: 123-45-6789', 'tokens');
      expect(r.text).toContain('[REDACTED-SSN]');
      expect(r.text).not.toContain('123-45-6789');
    });

    it('redacts Luhn-valid credit cards', () => {
      // 4111 1111 1111 1111 is a known Luhn-valid Visa test number.
      const r = redact('card=4111 1111 1111 1111', 'tokens');
      expect(r.text).toContain('[REDACTED-CC]');
    });

    it('does NOT redact Luhn-INVALID 16-digit runs', () => {
      // 1234567890123456 fails Luhn — should pass through unchanged.
      const r = redact('id=1234567890123456', 'tokens');
      expect(r.text).toBe('id=1234567890123456');
    });

    it('does NOT redact emails in tokens mode', () => {
      const r = redact('contact: foo@bar.com', 'tokens');
      expect(r.text).toContain('foo@bar.com');
    });

    it('does NOT redact public IPs in tokens mode', () => {
      const r = redact('host: 8.8.8.8', 'tokens');
      expect(r.text).toContain('8.8.8.8');
    });

    it('redacts PEM private key blocks (full block)', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK\n-----END RSA PRIVATE KEY-----';
      const r = redact(pem, 'tokens');
      expect(r.text).toBe('[REDACTED-PRIVATE-KEY]');
    });
  });

  describe('strict mode', () => {
    it('redacts emails', () => {
      const r = redact('user@example.com', 'strict');
      expect(r.text).toBe('[REDACTED-EMAIL]');
    });

    it('redacts public IPv4', () => {
      const r = redact('8.8.8.8', 'strict');
      expect(r.text).toBe('[REDACTED-IP]');
    });

    it('does NOT redact localhost', () => {
      const r = redact('127.0.0.1', 'strict');
      expect(r.text).toBe('127.0.0.1');
    });

    it('does NOT redact 10.0.0.0/8 private range', () => {
      expect(redact('10.0.0.50', 'strict').text).toBe('10.0.0.50');
    });

    it('does NOT redact 192.168.0.0/16', () => {
      expect(redact('192.168.1.1', 'strict').text).toBe('192.168.1.1');
    });

    it('does NOT redact 172.16-31 private range', () => {
      expect(redact('172.20.50.100', 'strict').text).toBe('172.20.50.100');
    });

    it('rejects malformed IPv4 (octet > 255)', () => {
      expect(redact('300.300.300.300', 'strict').text).toBe('300.300.300.300');
    });

    it('still redacts AWS keys (inherits tokens patterns)', () => {
      const r = redact('AKIAIOSFODNN7EXAMPLE', 'strict');
      expect(r.text).toContain('[REDACTED-AWS]');
    });
  });

  describe('getPiiMode', () => {
    it('respects MAKESTUDIO_PII_REDACTION env override', () => {
      process.env.MAKESTUDIO_PII_REDACTION = 'strict';
      resetPiiModeCache();
      expect(getPiiMode()).toBe('strict');
    });

    it('defaults to off', () => {
      resetPiiModeCache();
      expect(getPiiMode()).toBe('off');
    });
  });

  describe('redactString convenience', () => {
    it('returns string only', () => {
      expect(redactString('AKIAIOSFODNN7EXAMPLE', 'tokens')).toContain('[REDACTED-AWS]');
    });
  });

  describe('stats', () => {
    it('counts multiple findings', () => {
      const r = redact('a=AKIAIOSFODNN7EXAMPLE b=ghp_abcdefghijklmnopqrstuvwxyzABCD123456', 'tokens');
      expect(r.stats.redactionCount).toBeGreaterThanOrEqual(2);
    });

    it('groups by marker', () => {
      // Two valid AWS keys (AKIA + exactly 16 alphanum each)
      const r = redact('AKIAIOSFODNN7EXAMPLE AKIAQWERTYUIOPASDFGH', 'tokens');
      expect(r.stats.byMarker['[REDACTED-AWS]']).toBe(2);
    });
  });
});
