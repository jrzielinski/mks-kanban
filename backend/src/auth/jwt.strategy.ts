import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  sub: string;
  sessionId?: string;
  tenantId: string;
  email?: string;
  name?: string | null;
  role?: string;
}

/**
 * JWT strategy that supports two modes:
 *
 *  - **Desktop / offline** (`LOCAL_JWT_SECRET` env set): HS256 with the
 *    hex-encoded secret. jwks-rsa is NOT imported — avoids the ESM/CJS
 *    incompatibility when running inside Electron's bundled Node.
 *
 *  - **Web / Postgres** (default): RS256 + JWKS from `mks-identity`.
 *    jwks-rsa is loaded lazily via inline require() only in this branch
 *    so the import never runs in desktop mode.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const localSecret = process.env.LOCAL_JWT_SECRET;

    if (localSecret) {
      // ── Desktop mode: symmetric HS256, no external deps ──────────────
      super({
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        ignoreExpiration: false,
        secretOrKey: Buffer.from(localSecret, 'hex'),
        algorithms: ['HS256'],
      });
    } else {
      // ── Web mode: RS256 via JWKS (mks-identity) ───────────────────────
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { passportJwtSecret } = require('jwks-rsa') as typeof import('jwks-rsa');

      const jwksUri =
        process.env.IDENTITY_JWKS_URI ??
        `${process.env.IDENTITY_ISSUER ?? 'http://localhost:3030'}/.well-known/jwks.json`;

      super({
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        ignoreExpiration: false,
        algorithms: ['RS256'],
        issuer: process.env.IDENTITY_ISSUER,
        audience: process.env.IDENTITY_AUDIENCE ?? 'mks-kanban',
        secretOrKeyProvider: passportJwtSecret({
          jwksUri,
          cache: true,
          cacheMaxEntries: 10,
          cacheMaxAge: 10 * 60 * 1000,
          rateLimit: true,
          jwksRequestsPerMinute: 10,
        }),
      });
    }
  }

  async validate(payload: any): Promise<JwtPayload> {
    return {
      sub: payload.sub,
      sessionId: payload.sessionId ?? '',
      tenantId: payload.tenantId ?? 'desktop',
      email: payload.email ?? '',
      name: payload.name ?? null,
      role: payload.role ?? 'admin',
    };
  }
}
