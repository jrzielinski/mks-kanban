import 'dotenv/config';
import { DataSource } from 'typeorm';
import { resolveDbPath } from './db-path';
import { dbDriver } from './column-types';

/**
 * TypeORM CLI data source (migration:generate / migration:run).
 *
 * Migrations are a Postgres-only concern — the SQLite desktop build
 * bootstraps each board file with `synchronize`. Run the CLI with
 * DB_DRIVER=postgres (the default) against the web database.
 */
const entities = [__dirname + '/../**/*.entity{.ts,.js}'];

export default new DataSource(
  dbDriver() === 'sqlite'
    ? {
        type: 'better-sqlite3',
        database: resolveDbPath(),
        entities,
        synchronize: false,
      }
    : {
        type: 'postgres',
        url: process.env.DATABASE_URL,
        entities,
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        synchronize: false,
      },
);
