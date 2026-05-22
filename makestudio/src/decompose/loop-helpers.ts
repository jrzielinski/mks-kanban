import * as fs from 'fs';
import * as path from 'path';
import type { ExistingDumSummary } from './types';

/**
 * Severity ranking for issue ordering — higher rank = more severe.
 * Used to pick the dominant criterion when a DUM has multiple issues,
 * so the cause-of-retry telemetry reflects the worst problem rather
 * than a random one.
 */
export function severityRank(severity: string | undefined): number {
  switch ((severity || '').toUpperCase()) {
    case 'BLOCKER': return 3;
    case 'MAJOR':   return 2;
    case 'MINOR':   return 1;
    default:        return 0;
  }
}

/** Fetch the project's existing DUMs from the backend. Returns [] on any failure. */
export async function fetchExistingDums(api: any, projectId: string): Promise<ExistingDumSummary[]> {
  try {
    const res = await api.get(`/dark-factory/projects/${projectId}/dums/list`, { timeout: 10_000 });
    return res.data?.dums || [];
  } catch {
    return [];
  }
}

/** Glob for the locally-written `dum_NNN.json` files under .makestudio/dums/. */
export async function listDumFiles(cwd: string): Promise<string[]> {
  const dir = path.join(cwd, '.makestudio', 'dums');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^dum_\d+\.json$/.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
