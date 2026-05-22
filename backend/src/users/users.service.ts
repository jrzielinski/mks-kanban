import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './user.entity';
import { JwtPayload } from '../auth/jwt.strategy';

export interface UpdateProfileDto {
  firstName?: string;
  lastName?: string;
  avatar?: string;
  password?: string;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { id } });
  }

  async createLocalUser(email: string, password: string, firstName?: string, lastName?: string): Promise<User> {
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new ConflictException('Email já cadastrado');
    }
    const hashed = await bcrypt.hash(password, 10);
    const user = this.usersRepo.create({
      email,
      password: hashed,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      syncedFromCloud: false,
    });
    return this.usersRepo.save(user);
  }

  async validatePassword(email: string, password: string): Promise<User | null> {
    const user = await this.findByEmail(email);
    if (!user || !user.password) return null;
    const ok = await bcrypt.compare(password, user.password);
    return ok ? user : null;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<User> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    if (dto.firstName !== undefined) user.firstName = dto.firstName;
    if (dto.lastName !== undefined) user.lastName = dto.lastName;
    if (dto.avatar !== undefined) user.avatar = dto.avatar;
    if (dto.password) {
      user.password = await bcrypt.hash(dto.password, 10);
    }

    return this.usersRepo.save(user);
  }

  async getMe(userId: string): Promise<Partial<User>> {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const { password, ...rest } = user;
    return rest;
  }

  async upsertCloudUser(data: {
    email: string;
    firstName?: string;
    lastName?: string;
    avatar?: string;
    cloudUserId: string;
  }): Promise<User> {
    let user = await this.findByEmail(data.email);
    if (user) {
      user.firstName = data.firstName ?? user.firstName;
      user.lastName = data.lastName ?? user.lastName;
      user.avatar = data.avatar ?? user.avatar;
      user.cloudUserId = data.cloudUserId;
      user.syncedFromCloud = true;
    } else {
      user = this.usersRepo.create({
        email: data.email,
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        avatar: data.avatar ?? null,
        cloudUserId: data.cloudUserId,
        syncedFromCloud: true,
        password: null,
      });
    }
    return this.usersRepo.save(user);
  }
}
