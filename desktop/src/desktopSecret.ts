/**
 * Per-installation secret material kept inside `<userData>`:
 *
 *   - JWT_SECRET — signs the embedded backend's tokens
 *   - admin email / password — auto-seeded by the backend on each new
 *     .sqlite board file; the Electron shell then auto-logs in with them
 *     so the user never sees a login screen
 *
 * All persisted (encrypted via safeStorage when available) on first
 * launch and reused forever after. Treat the file as sensitive.
 */
import { app, safeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface DesktopSecret {
  jwtSecret: string;
  adminEmail: string;
  adminPassword: string;
}

function secretFile(): string {
  return path.join(app.getPath('userData'), 'desktop-secret.json');
}

export function loadOrCreateSecret(): DesktopSecret {
  const file = secretFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file);
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf-8');
      return JSON.parse(json) as DesktopSecret;
    }
  } catch {
    // unreadable — regenerate
  }

  const fresh: DesktopSecret = {
    jwtSecret: crypto.randomBytes(48).toString('hex'),
    adminEmail: 'admin@kanban.local',
    adminPassword: crypto.randomBytes(16).toString('hex'),
  };
  const json = JSON.stringify(fresh);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8');
  fs.writeFileSync(file, data, { mode: 0o600 });
  return fresh;
}
