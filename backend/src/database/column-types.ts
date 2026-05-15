/**
 * Portable column types — the *same* entities power two builds:
 *   - web     → PostgreSQL (multi-user, one shared database)
 *   - desktop → SQLite     (embedded, one .sqlite file per board)
 *
 * DB_DRIVER selects the driver at boot. Decorators are evaluated when the
 * entity files are imported (after `dotenv/config` runs in main.ts /
 * data-source.ts), so reading process.env here is safe.
 */
import type { ColumnType } from 'typeorm';

export type DbDriver = 'postgres' | 'sqlite';

export function dbDriver(): DbDriver {
  return (process.env.DB_DRIVER || 'postgres') === 'sqlite' ? 'sqlite' : 'postgres';
}

export const isSqlite = dbDriver() === 'sqlite';

/**
 * Timestamp column type — Postgres has `timestamp`, the better-sqlite3
 * driver only understands `datetime`.
 */
export const TIMESTAMP_TYPE: ColumnType = isSqlite ? 'datetime' : 'timestamp';
