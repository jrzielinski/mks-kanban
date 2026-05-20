import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

// Lazy require to avoid CJS crash under ELECTRON_RUN_AS_NODE
function getPassportJwtSecret(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('jwks-rsa').passportJwtSecret;
}

export interface JwtPayload {
  sub: string;
  email?: string;
  tenantId: string;
  name?: string;
  role?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const localSecret = process.env.LOCAL_JWT_SECRET;

    const options: any = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
    };

    if (localSecret) {
      // Offline mode: symmetric HS256 (no JWKS dependency)
      options.secretOrKey = Buffer.from(localSecret, 'hex');
      options.algorithms = ['HS256'];
    } else {
      // Online mode: remote JWKS (RS256)
      options.secretOrKey = getPassportJwtSecret()({
        jwksUri: process.env.IDENTITY_JWKS_URI ?? 'https://identity.makestudio.dev/.well-known/jwks.json',
        cache: true,
        rateLimit: true,
      });
      options.issuer = process.env.IDENTITY_ISSUER ?? 'https://identity.makestudio.dev';
      options.algorithms = ['RS256'];
    }

    super(options);
  }

  async validate(payload: JwtPayload) {
    return payload;
  }
}
