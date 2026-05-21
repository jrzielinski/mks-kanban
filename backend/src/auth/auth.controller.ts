import {
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from './auth.guard';
import { JwtPayload } from './jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwtService: JwtService,
    private readonly cfg: ConfigService,
  ) {}

  /** Echo the JWT claims so the frontend can get a fresh user object post-login. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  me(@Req() req: { user: JwtPayload }) {
    const u = req.user;
    return {
      id: u.sub,
      email: u.email,
      name: u.name,
      tenantId: u.tenantId,
      role: u.role,
    };
  }

  /**
   * Desktop-only auto-login endpoint.
   *
   * Issues a long-lived HS256 token for the single local user.
   * Only available when running in SQLite / desktop mode — returns 403
   * in web/Postgres mode so it cannot be abused on a shared server.
   *
   * The Electron main process calls this right after the embedded backend
   * boots, stores the token in the OS keychain, and injects it into the
   * renderer via the IPC auth bridge. The user never sees a login screen.
   */
  @Post('desktop-token')
  @HttpCode(HttpStatus.OK)
  desktopToken() {
    const isDesktop = (this.cfg.get<string>('DB_DRIVER') ?? 'postgres') === 'sqlite';
    if (!isDesktop) {
      throw new ForbiddenException('desktop-token is only available in desktop mode');
    }

    const payload: JwtPayload & Record<string, unknown> = {
      sub: 'desktop-user',
      sessionId: 'desktop',
      tenantId: 'desktop',
      email: 'local@makestudio',
      name: 'Local User',
      role: 'admin',
    };

    // 1 year — effectively never expires for a local single-user app
    const token = this.jwtService.sign(payload, { expiresIn: '365d' });
    const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

    return {
      token,
      tokenExpires: exp,
      user: {
        id: payload.sub,
        email: payload.email,
        firstName: 'Local',
        lastName: 'User',
        tenantId: payload.tenantId,
        role: payload.role,
      },
    };
  }
}
