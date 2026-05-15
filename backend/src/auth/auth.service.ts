import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserEntity } from './entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './jwt.strategy';

const BCRYPT_ROUNDS = 10;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface AuthTokens {
  token: string;
  refreshToken: string;
  tokenExpires: number;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  tenantId: string;
  role: string;
  provider: 'email';
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly jwt: JwtService,
    private readonly cfg: ConfigService,
  ) {}

  /**
   * Seed the first admin once on boot when the users table is empty.
   * Credentials come from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD env vars,
   * with a clearly-flagged default for dev so /login isn't a chicken-and-egg.
   */
  async onApplicationBootstrap(): Promise<void> {
    const count = await this.userRepo.count();
    if (count > 0) return;
    const email = this.cfg.get<string>('SEED_ADMIN_EMAIL') || 'admin@kanban.local';
    const password = this.cfg.get<string>('SEED_ADMIN_PASSWORD') || 'admin123';
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await this.userRepo.save(
      this.userRepo.create({
        email,
        passwordHash,
        firstName: 'Admin',
        lastName: null,
        tenantId: 'staff',
        role: 'admin',
      }),
    );
    this.logger.warn(
      `[seed] empty users table — created admin "${email}" with default password ` +
        `(${this.cfg.get('SEED_ADMIN_PASSWORD') ? 'from env' : 'admin123 — CHANGE IT'}).`,
    );
  }

  async register(dto: RegisterDto): Promise<AuthTokens> {
    const existing = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existing) {
      // Contract expected by the frontend store (auth.ts): 422 + errors.email
      throw new HttpException(
        { errors: { email: 'emailAlreadyExists' } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.userRepo.save(
      this.userRepo.create({
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        tenantId: 'staff',
        role: 'user',
      }),
    );
    return this.issueTokens(user);
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    const user = await this.userRepo.findOne({ where: { email: dto.email } });
    if (!user) {
      throw new HttpException(
        { errors: { email: 'notFound' } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (user.isBanned) {
      throw new HttpException(
        { errors: { email: 'accountBanned' } },
        HttpStatus.FORBIDDEN,
      );
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new HttpException(
        { errors: { email: `accountLocked:${minutes}` } },
        HttpStatus.FORBIDDEN,
      );
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      await this.recordFailedAttempt(user);
      throw new HttpException(
        { errors: { password: 'incorrectPassword' } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      await this.userRepo.save(user);
    }
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: JwtPayload & { type?: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Not a refresh token');
    }
    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('User no longer exists');
    return this.issueTokens(user);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.toPublicUser(user);
  }

  /** Stateless JWT — logout is a client-side concern; this endpoint is just
   *  a polite ack so the frontend's `api.post('/auth/logout')` doesn't 404. */
  async logout(): Promise<{ ok: true }> {
    return { ok: true };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async recordFailedAttempt(user: UserEntity): Promise<void> {
    user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
    if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
    }
    await this.userRepo.save(user);
  }

  private async issueTokens(user: UserEntity): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
    };
    const token = await this.jwt.signAsync(payload, { expiresIn: '7d' });
    const refreshToken = await this.jwt.signAsync(
      { ...payload, type: 'refresh' },
      { expiresIn: '30d' },
    );
    // tokenExpires: ms-since-epoch when the access token stops being valid.
    const tokenExpires = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return { token, refreshToken, tokenExpires, user: this.toPublicUser(user) };
  }

  private toPublicUser(user: UserEntity): PublicUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      tenantId: user.tenantId,
      role: user.role,
      provider: 'email',
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }
}
