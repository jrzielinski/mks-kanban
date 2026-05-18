/**
 * Encrypted token cache for the desktop build.
 * Replaces desktopSecret.ts — no more seeded admin credentials.
 * Tokens come from mks-identity (OAuth or email/password flow).
 */
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface DesktopAuth {
  accessToken: string;
  refreshToken: string;
  /** Unix timestamp (seconds) when the access token expires. */
  accessTokenExp: number;
  user: Record<string, unknown>;
}

function authFile(): string {
  return path.join(app.getPath('userData'), 'desktop-auth.json');
}

export function loadAuth(): DesktopAuth | null {
  const file = authFile();
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf-8');
    return JSON.parse(json) as DesktopAuth;
  } catch {
    return null;
  }
}

export function saveAuth(auth: DesktopAuth): void {
  const json = JSON.stringify(auth);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8');
  fs.writeFileSync(authFile(), data, { mode: 0o600 });
}

export function clearAuth(): void {
  try {
    const file = authFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
}
