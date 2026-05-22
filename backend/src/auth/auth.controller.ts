import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './auth.guard';
import { JwtPayload } from './jwt.strategy';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body('email') email: string,
    @Body('password') password: string,
    @Body('firstName') firstName?: string,
    @Body('lastName') lastName?: string,
  ) {
    // Try local register first; fallback to cloud sync if email exists
    if (!process.env.LOCAL_JWT_SECRET) {
      throw new ForbiddenException('Registro local só disponível em modo desktop');
    }
    return this.authService.localRegisterOrCloudSync(email, password, firstName, lastName);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body('email') email: string,
    @Body('password') password: string,
  ) {
    return this.authService.hybridLogin(email, password);
  }

  /** Returns profile data for the authenticated user. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async me(@Req() req: { user: JwtPayload }) {
    const u = req.user;

    // If local user, enrich with stored profile
    if (u.sub && u.sub !== 'desktop-user') {
      try {
        const local = await this.usersService.getMe(u.sub);
        if (local) {
          return {
            id: local.id,
            email: local.email,
            name: [local.firstName, local.lastName].filter(Boolean).join(' ') || u.name,
            firstName: local.firstName,
            lastName: local.lastName,
            avatar: local.avatar,
            tenantId: u.tenantId,
            role: u.role,
          };
        }
      } catch {}
    }

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
   * Issues a long-lived HS256 token for the single local user.
   */
  @Post('desktop-token')
  @HttpCode(HttpStatus.OK)
  desktopToken() {
    if (!process.env.LOCAL_JWT_SECRET) {
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
