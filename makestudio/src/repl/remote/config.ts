import { swallow } from '../../utils/log';
/**
 * remote/config.ts — persistent remote-control settings at ~/.makestudio/remote.json
 *
 * {
 *   "enabled": false,
 *   "relayUrl": "https://api.zielinski.dev.br",
 *   "token": "<random-hex>"
 * }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

export interface RemoteConfig {
  enabled: boolean;
  relayUrl: string;
  token: string;
}

const CONFIG_FILE = path.join(os.homedir(), '.makestudio', 'remote.json');
const DEFAULT_RELAY_URL = 'https://api.zielinski.dev.br';

function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function loadRemoteConfig(): RemoteConfig {
  let loaded: Partial<RemoteConfig> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) { swallow(err); }

  const cfg: RemoteConfig = {
    enabled: loaded.enabled ?? false,
    relayUrl: loaded.relayUrl || DEFAULT_RELAY_URL,
    token: loaded.token || generateToken(),
  };

  // Persist if anything changed
  try {
    const existing = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : '';
    const serialized = JSON.stringify(cfg, null, 2);
    if (existing !== serialized) {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, serialized);
    }
  } catch (err) { swallow(err); }

  return cfg;
}

export function saveRemoteConfig(cfg: RemoteConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (err) { swallow(err); }
}

export function rotateToken(cfg: RemoteConfig): string {
  cfg.token = generateToken();
  saveRemoteConfig(cfg);
  return cfg.token;
}
