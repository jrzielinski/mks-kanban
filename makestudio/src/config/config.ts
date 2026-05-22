import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioConfig } from '../types';

const CONFIG_DIR = path.join(os.homedir(), '.makestudio');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): MakeStudioConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw) as MakeStudioConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: MakeStudioConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

export function clearConfig(): void {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
