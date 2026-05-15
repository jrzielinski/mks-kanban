import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { TIMESTAMP_TYPE } from '../../database/column-types';

/**
 * Local user account — the standalone build no longer borrows auth from
 * the MakeStudio monolith. Passwords are hashed with bcrypt; refresh
 * tokens are stateless JWTs so we don't need a side table for them.
 */
@Entity('users')
@Index(['email'], { unique: true })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ name: 'first_name', type: 'varchar', nullable: true })
  firstName: string | null;

  @Column({ name: 'last_name', type: 'varchar', nullable: true })
  lastName: string | null;

  /** Single-tenant default for the standalone build. */
  @Column({ name: 'tenant_id', default: 'staff' })
  tenantId: string;

  /** 'admin' | 'user' — kept loose so we can extend without a migration. */
  @Column({ default: 'user' })
  role: string;

  @Column({ name: 'is_banned', default: false })
  isBanned: boolean;

  @Column({ name: 'locked_until', type: TIMESTAMP_TYPE, nullable: true })
  lockedUntil: Date | null;

  @Column({ name: 'failed_login_attempts', type: 'int', default: 0 })
  failedLoginAttempts: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
