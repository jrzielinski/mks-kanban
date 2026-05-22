import { parseJwtExpiryMs, isJwtNearExpiration } from './auth';

function makeToken(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `${header}.${body}.sig`;
}

describe('parseJwtExpiryMs', () => {
  it('returns null for null / undefined / empty string', () => {
    expect(parseJwtExpiryMs(null)).toBeNull();
    expect(parseJwtExpiryMs(undefined)).toBeNull();
    expect(parseJwtExpiryMs('')).toBeNull();
  });

  it('returns null when the token has fewer than 2 dotted parts', () => {
    expect(parseJwtExpiryMs('onlyone')).toBeNull();
  });

  it('returns null when payload does not decode as JSON', () => {
    expect(parseJwtExpiryMs('header.not-base64.sig')).toBeNull();
  });

  it('returns null when the payload has no numeric exp', () => {
    expect(parseJwtExpiryMs(makeToken({}))).toBeNull();
    expect(parseJwtExpiryMs(makeToken({ exp: 'soon' }))).toBeNull();
  });

  it('returns exp * 1000 when the payload is valid', () => {
    const epochSec = 2_000_000_000;
    expect(parseJwtExpiryMs(makeToken({ exp: epochSec }))).toBe(epochSec * 1000);
  });
});

describe('isJwtNearExpiration', () => {
  const NOW = 1_700_000_000_000;

  it('returns true for missing / malformed tokens (safe default)', () => {
    expect(isJwtNearExpiration(null, undefined, NOW)).toBe(true);
    expect(isJwtNearExpiration('bogus', undefined, NOW)).toBe(true);
  });

  it('returns false when the token expires comfortably in the future', () => {
    const exp = (NOW + 60 * 60_000) / 1000; // 1 hour ahead
    expect(isJwtNearExpiration(makeToken({ exp }), undefined, NOW)).toBe(false);
  });

  it('returns true when the token expires within the threshold', () => {
    const exp = (NOW + 2 * 60_000) / 1000; // 2 minutes ahead
    expect(isJwtNearExpiration(makeToken({ exp }), 5 * 60_000, NOW)).toBe(true);
  });

  it('returns true for already-expired tokens', () => {
    const exp = (NOW - 60_000) / 1000;
    expect(isJwtNearExpiration(makeToken({ exp }), undefined, NOW)).toBe(true);
  });

  it('respects a custom threshold', () => {
    const exp = (NOW + 10 * 60_000) / 1000; // 10 minutes ahead
    expect(isJwtNearExpiration(makeToken({ exp }), 15 * 60_000, NOW)).toBe(true);
    expect(isJwtNearExpiration(makeToken({ exp }), 5 * 60_000, NOW)).toBe(false);
  });
});
