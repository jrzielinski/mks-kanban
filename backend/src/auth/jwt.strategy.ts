import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  sub: string;
  sessionId: string;
  tenantId: string;
  email: string;
  name: string | null;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(cfg: ConfigService) {
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
        cacheMaxAge: 10 * 60 * 1000, // 10 min
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      }),
    });
  }

  async validate(payload: any): Promise<JwtPayload> {
    if (!payload.sub) throw new UnauthorizedException();
    return {
      sub: payload.sub,
      sessionId: payload.sessionId ?? '',
      tenantId: payload.tenantId ?? 'staff',
      email: payload.email ?? '',
      name: payload.name ?? null,
      role: payload.role ?? 'user',
    };
  }
}
