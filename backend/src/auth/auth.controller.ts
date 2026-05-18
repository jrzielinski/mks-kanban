import { Controller, Get, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from './auth.guard';
import { JwtPayload } from './jwt.strategy';

@Controller('auth')
export class AuthController {
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
}
