import { app, safeStorage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface AuthSession {
  token: string;
  refreshToken?: string;
  user: {
    id?: string | number;
    email?: string;
    firstName?: string;
    lastName?: string;
    tenantId?: string;
    [key: string]: unknown;
  };
}

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'kanban-auth.json');
}

export function readSession(): AuthSession | null {
  try {
    const file = sessionFile();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    let json: string;
    if (safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(raw);
    } else {
      json = raw.toString('utf-8');
    }
    return JSON.parse(json) as AuthSession;
  } catch {
    return null;
  }
}

export function writeSession(session: AuthSession): void {
  const json = JSON.stringify(session);
  let data: Buffer;
  if (safeStorage.isEncryptionAvailable()) {
    data = safeStorage.encryptString(json);
  } else {
    // eslint-disable-next-line no-console
    console.warn('[kanban:authStore] safeStorage unavailable — storing session unencrypted');
    data = Buffer.from(json, 'utf-8');
  }
  fs.writeFileSync(sessionFile(), data, { mode: 0o600 });
}

export function clearSession(): void {
  try {
    const file = sessionFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore — file may not exist
  }
}
