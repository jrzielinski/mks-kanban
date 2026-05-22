import { swallow } from '../utils/log';
/**
 * Persistent REPL input history, scoped per-cwd.
 *
 * Each cwd gets its own file under ~/.makestudio/history/<cwd-slug>.
 * A global history at ~/.makestudio/history (the old location) is
 * preserved and used as FALLBACK for existing users — but new entries
 * only go to the cwd-scoped file so commands typed in project A don't
 * leak into project B.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MAX_ENTRIES = 2000;

function cwdSlug(cwd: string): string {
  return cwd
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

function historyDir(): string {
  const dir = path.join(os.homedir(), '.makestudio', 'history');
  try {
    // Legacy: older versions stored a single FILE at this path. Migrate
    // it to history.legacy so we can create a directory here.
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) {
      try { fs.renameSync(dir, dir + '.legacy'); } catch (err) { swallow(err); }
    }
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) { swallow(err); }
  return dir;
}

function historyFile(cwd?: string): string {
  const effective = cwd || process.cwd();
  return path.join(historyDir(), cwdSlug(effective));
}

function legacyGlobalFile(): string | null {
  // Migrated name (previous file at .makestudio/history renamed by historyDir)
  const renamed = path.join(os.homedir(), '.makestudio', 'history.legacy');
  if (fs.existsSync(renamed)) return renamed;
  return null;
}

export function loadHistory(cwd?: string): string[] {
  try {
    const file = historyFile(cwd);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
    }
    // Legacy fallback: migrated global file from before per-cwd scoping.
    // Returned for ↑/↓ so users don't lose reach to old commands, but new
    // entries write per-cwd so cross-project leaks stop happening.
    const legacy = legacyGlobalFile();
    if (legacy) {
      try {
        return fs.readFileSync(legacy, 'utf8').split('\n').filter(l => l.trim().length > 0);
      } catch (err) { swallow(err); }
    }
    return [];
  } catch {
    return [];
  }
}

export function appendHistory(line: string, cwd?: string): void {
  if (!line || !line.trim()) return;
  try {
    const file = historyFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n', 'utf8');
    // Trim if file gets huge (per-file limit)
    try {
      const stats = fs.statSync(file);
      if (stats.size > 500_000) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0);
        const trimmed = lines.slice(-MAX_ENTRIES);
        fs.writeFileSync(file, trimmed.join('\n') + '\n', 'utf8');
      }
    } catch (err) { swallow(err); }
  } catch (err) { swallow(err); }
}
