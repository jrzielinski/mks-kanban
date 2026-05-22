import { swallow } from '../utils/log';
/**
 * last-run.json — persists the choices made in the last execute run
 * so `/resume` or re-running `/execute` can skip the menu prompts and
 * pick up exactly where it left off.
 *
 * Saved at <projectPath>/.makestudio/last-run.json.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface LastRunState {
  version: 1;
  projectId: string;
  projectName?: string;
  cli: string;
  executionMode: 'all' | 'by-phase' | 'single' | 'from-phase' | 'dry-run';
  fromPhaseIdx?: number;
  onlyDum?: string;
  skipCheckpoint?: boolean;
  skipDoctor?: boolean;
  doctorDeep?: boolean;
  plan?: boolean;
  planDums?: string;
  skipReview?: boolean;
  reviewFix?: boolean;
  isolate?: boolean;
  isolateDums?: string;
  startedAt: string;
  lastUpdatedAt: string;
  lastActiveDum?: string;       // DUM number last started
  lastActiveTask?: string;      // Task title last started
  completedDums: string[];      // DUM numbers completed during THIS run
  totalDumsPlanned?: number;
}

function filePath(projectPath: string): string {
  return path.join(projectPath, '.makestudio', 'last-run.json');
}

export function saveLastRun(projectPath: string, state: LastRunState): void {
  try {
    const f = filePath(projectPath);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

export function loadLastRun(projectPath: string): LastRunState | null {
  try {
    const f = filePath(projectPath);
    if (!fs.existsSync(f)) return null;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!data || data.version !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

export function clearLastRun(projectPath: string): void {
  try {
    const f = filePath(projectPath);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (err) { swallow(err); }
}

export function updateLastRun(projectPath: string, patch: Partial<LastRunState>): void {
  const current = loadLastRun(projectPath);
  if (!current) return;
  saveLastRun(projectPath, {
    ...current,
    ...patch,
    lastUpdatedAt: new Date().toISOString(),
  });
}

/**
 * Age of the last run in minutes. Used to decide if it's worth offering resume.
 */
export function lastRunAgeMinutes(projectPath: string): number | null {
  const s = loadLastRun(projectPath);
  if (!s) return null;
  const t = new Date(s.lastUpdatedAt).getTime();
  return Math.round((Date.now() - t) / 60_000);
}
