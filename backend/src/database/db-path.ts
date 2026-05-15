import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves the SQLite database file path and guarantees its parent
 * directory exists (better-sqlite3 will not create it).
 *
 * Override with the DATABASE_PATH env var — the Electron shell points
 * this at `app.getPath('userData')` so the embedded backend keeps the
 * database alongside the user's profile.
 *
 * Default: `<backend>/data/kanban.sqlite`.
 */
export function resolveDbPath(): string {
  const dbPath =
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), 'data', 'kanban.sqlite');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return dbPath;
}
