import { swallow } from '../utils/log';
/**
 * `analyze` command — cache module. Extracted from analyze.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import chalk from 'chalk';

const dim    = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green  = chalk.hex('#22C55E');
const cyan   = chalk.hex('#22D3EE');
const red    = chalk.hex('#EF4444');
const blue   = chalk.hex('#60A5FA');
import type { CodebaseAnalysis } from './analyze';

export const CACHE_FILE = '.makestudio/analysis.json';
const CACHE_MAX_AGE_HOURS = 72;

export function getCachePath(targetPath: string): string {
  return path.join(targetPath, CACHE_FILE);
}

export function readCache(targetPath: string): CodebaseAnalysis | null {
  const cachePath = getCachePath(targetPath);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const stat = fs.statSync(cachePath);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours > CACHE_MAX_AGE_HOURS) return null;
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch { return null; }
}

export function saveCache(targetPath: string, data: CodebaseAnalysis): void {
  try {
    const cacheDir = path.join(targetPath, '.makestudio');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(getCachePath(targetPath), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) { swallow(err); }
}
