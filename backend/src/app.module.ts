import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { KanbanModule } from './kanban/kanban.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { MailerModule } from './mailer/mailer.module';
import { EncryptionModule } from './encryption/encryption.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        url: cfg.get<string>('DATABASE_URL'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        // NEVER synchronize: true — always use migrations
        synchronize: false,
        migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
        migrationsRun: false,
        logging: cfg.get('NODE_ENV') === 'development',
      }),
    }),
    AuthModule,
    EncryptionModule,
    MailerModule,
    ApprovalsModule,
    KanbanModule,
    AiModule,
  ],
})
export class AppModule {}
