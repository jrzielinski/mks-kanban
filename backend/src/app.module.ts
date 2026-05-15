import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import * as fs from 'fs';
import * as path from 'path';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { KanbanModule } from './kanban/kanban.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { MailerModule } from './mailer/mailer.module';
import { EncryptionModule } from './encryption/encryption.module';
import { AiModule } from './ai/ai.module';
import { resolveDbPath } from './database/db-path';
import { dbDriver } from './database/column-types';

/**
 * Resolve the path to the built frontend (`frontend/dist/`). The backend
 * serves it only when the directory exists, so dev with a separate Vite
 * server stays unaffected. Override via FRONTEND_DIST env.
 */
function resolveFrontendDist(): string | null {
  const override = process.env.FRONTEND_DIST;
  const candidates = [
    override,
    // dev: backend/dist/app.module.js → ../../frontend/dist
    path.join(__dirname, '..', '..', 'frontend', 'dist'),
    // single-container deploy: copied alongside backend dist
    path.join(__dirname, '..', 'public'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

const STATIC_MODULES: DynamicModule[] = (() => {
  const dist = resolveFrontendDist();
  if (!dist) return [];
  return [
    ServeStaticModule.forRoot({
      rootPath: dist,
      // Don't shadow the API. /api/v1/* and /socket.io/* must hit Nest.
      exclude: ['/api/v1/(.*)', '/socket.io/(.*)'],
      serveStaticOptions: {
        // SPA: unknown routes (React Router) fall through to index.html
        fallthrough: true,
        index: 'index.html',
      },
    }),
  ];
})();

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    ...STATIC_MODULES,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const entities = [__dirname + '/**/*.entity{.ts,.js}'];
        const logging = cfg.get('NODE_ENV') === 'development';

        // Desktop build — embedded SQLite, one .sqlite file per board.
        // Single-user and the schema ships with the app, so `synchronize`
        // bootstraps each fresh board file with zero setup.
        if (dbDriver() === 'sqlite') {
          return {
            type: 'better-sqlite3' as const,
            database: resolveDbPath(),
            entities,
            synchronize: true,
            logging,
          };
        }

        // Web build — shared PostgreSQL, multi-user. Schema is owned by
        // migrations; they run on boot so a single-container deploy is
        // also zero-setup.
        return {
          type: 'postgres' as const,
          url: cfg.get<string>('DATABASE_URL'),
          entities,
          synchronize: false,
          migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
          migrationsRun: true,
          logging,
        };
      },
    }),
    AuthModule,
    EncryptionModule,
    MailerModule,
    ApprovalsModule,
    KanbanModule,
    AiModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
