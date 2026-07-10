import { Injectable, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  // TEMP diagnostic: passport swallows the real rejection reason by
  // default (just throws a bare 401). Logging it here to find out whether
  // SSO tokens from the host are failing signature verification, expiry,
  // or something else — remove once the SSO auth flow is confirmed stable.
  handleRequest(err: any, user: any, info: any, context: any, status?: any) {
    if (err || !user) {
      this.logger.warn(`jwt rejected: err=${err?.message ?? err} info=${info?.message ?? info}`);
    }
    return super.handleRequest(err, user, info, context, status);
  }
}
