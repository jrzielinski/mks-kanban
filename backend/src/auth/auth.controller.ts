import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './auth.guard';
import { JwtPayload } from './jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(private readonly jwt: JwtService) {}

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

  @Post('email/login')
  @HttpCode(HttpStatus.OK)
  emailLogin(@Body() body: { email: string; password: string }) {
    const localSecret = process.env.LOCAL_JWT_SECRET;
    if (!localSecret) {
      return { error: 'LOCAL_JWT_SECRET not configured', statusCode: 500 };
    }

    if (body.email === 'admin@zielinski.dev.br' && body.password === 'password@123') {
      const localUser: JwtPayload = {
        sub: 'local-admin',
        email: 'admin@zielinski.dev.br',
        name: 'Admin Desktop',
        role: 'admin',
        tenantId: 'staff',
      };

      const token = this.jwt.sign(localUser, {
        secret: Buffer.from(localSecret, 'hex'),
        algorithm: 'HS256',
        expiresIn: '24h',
      });

      return {
        token,
        refreshToken: token,
        user: localUser,
      };
    }

    return { error: 'Invalid credentials', statusCode: 401 };
  }

  @Post('local-login')
  @HttpCode(HttpStatus.OK)
  localLogin(@Body() body: { token: string }) {
    const bootstrapToken = process.env.LOCAL_BOOTSTRAP_TOKEN;
    if (!bootstrapToken || body.token !== bootstrapToken) {
      return { error: 'Invalid bootstrap token', statusCode: 401 };
    }

    const localSecret = process.env.LOCAL_JWT_SECRET;
    if (!localSecret) {
      return { error: 'LOCAL_JWT_SECRET not configured', statusCode: 500 };
    }

    const localUser: JwtPayload = {
      sub: 'local-admin',
      email: 'admin@local',
      name: 'Local Admin',
      tenantId: 'staff',
      role: 'admin',
    };

    const token = this.jwt.sign(localUser, {
      secret: Buffer.from(localSecret, 'hex'),
      algorithm: 'HS256',
      expiresIn: '24h',
    });

    const decoded = this.jwt.decode(token) as any;

    return {
      token,
      expiresAt: decoded.exp,
      user: localUser,
    };
  }
}
