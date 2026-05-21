import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  sub: string;
  sessionId: string;
  tenantId: string;
  email: string;
  name: string | null;
  role: string;
}

/**
 * JWT strategy that supports two modes:
 *
 *  - **Desktop / SQLite** (`DB_DRIVER=sqlite`): HS256 with a local secret
 *    (`JWT_SECRET` env). jwks-rsa is NOT imported — avoids the ESM/CJS
 *    incompatibility when running inside Electron's bundled Node.
 *
 *  - **Web / Postgres** (default): RS256 + JWKS from `mks-identity`.
 *    jwks-rsa is loaded lazily via require() only in this branch.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(cfg: ConfigService) {
    const isDesktop = (cfg.get<string>('DB_DRIVER') ?? 'postgres') === 'sqlite';

    if (isDesktop) {
      // ── Local HS256 — zero external deps, works inside Electron ──────
      const secret = cfg.get<string>('JWT_SECRET');
      if (!secret) throw new Error('JWT_SECRET is required in desktop (SQLite) mode');

      super({
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        ignoreExpiration: false,
        algorithms: ['HS256'],
        secretOrKey: secret,
      });
    } else {
      // ── Remote RS256 via JWKS — web/Postgres only ─────────────────────
      // Lazy require so jwks-rsa (which pulls in the ESM-only `jose`)
      // is never touched when running in SQLite/Electron mode.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { passportJwtSecret } = require('jwks-rsa') as typeof import('jwks-rsa');

      const jwksUri =
        cfg.get<string>('IDENTITY_JWKS_URI') ??
        `${cfg.get<string>('IDENTITY_ISSUER') ?? 'http://localhost:3030'}/.well-known/jwks.json`;

      super({
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        ignoreExpiration: false,
        algorithms: ['RS256'],
        issuer: cfg.get<string>('IDENTITY_ISSUER'),
        audience: cfg.get<string>('IDENTITY_AUDIENCE') ?? 'mks-kanban',
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
    if (!payload.sub) throw new UnauthorizedException();
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
