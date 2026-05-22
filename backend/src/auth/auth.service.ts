import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async localRegister(email: string, password: string, firstName?: string, lastName?: string) {
    const user = await this.usersService.createLocalUser(email, password, firstName, lastName);
    const token = this.jwtService.sign({ sub: user.id, email: user.email });
    const { password: _, ...safe } = user;
    return { token, user: safe };
  }

  async localLogin(email: string, password: string) {
    const user = await this.usersService.validatePassword(email, password);
    if (!user) throw new UnauthorizedException('Email ou senha inválidos');
    const token = this.jwtService.sign({ sub: user.id, email: user.email });
    const { password: _, ...safe } = user;
    return { token, user: safe };
  }

  async cloudLogin(email: string, password: string) {
    try {
      const identityUrl = process.env.IDENTITY_URL || 'https://api.zielinski.dev.br';
      const axios = await import('axios');
      const res = await axios.default.post(`${identityUrl}/auth/login`, { email, password });
      const { token, user: cloudUser } = res.data;

      const user = await this.usersService.upsertCloudUser({
        email: cloudUser.email,
        firstName: cloudUser.firstName,
        lastName: cloudUser.lastName,
        avatar: cloudUser.avatar,
        cloudUserId: cloudUser.id,
      });

      return { token, user: { ...cloudUser, localId: user.id } };
    } catch (err: any) {
      this.logger.warn(`Cloud login failed: ${err.message}`);
      throw new UnauthorizedException('Falha na autenticação com servidor cloud');
    }
  }

  async hybridLogin(email: string, password: string) {
    const localUser = await this.usersService.findByEmail(email);
    if (localUser && localUser.password) {
      return this.localLogin(email, password);
    }
    return this.cloudLogin(email, password);
  }

  async localRegisterOrCloudSync(email: string, password: string, firstName?: string, lastName?: string) {
    try {
      return await this.localRegister(email, password, firstName, lastName);
    } catch {
      const user = await this.usersService.upsertCloudUser({
        email,
        firstName,
        lastName,
        cloudUserId: '',
      });
      await this.usersService.updateProfile(user.id, { password });
      const token = this.jwtService.sign({ sub: user.id, email: user.email });
      const { password: _, ...safe } = user;
      return { token, user: safe };
    }
  }
}
