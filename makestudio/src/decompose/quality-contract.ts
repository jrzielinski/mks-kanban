/**
 * quality-contract.ts
 *
 * Fetches the project's QUALITY_CONTRACT.md from the backend and writes it
 * to `<repoPath>/.makestudio/QUALITY_CONTRACT.md` so the CLI sees the ISO
 * 29148 contract on every operation in this project.
 *
 * Usage from runDecompose:
 *   await ensureQualityContract(api, projectId, repoPath);
 *   // ... continue with decomposition
 *
 * The function is idempotent — if the file already exists and is recent
 * (<24h old), it skips the network call. To force regeneration (e.g.,
 * after a stack change) call `ensureQualityContract(..., { force: true })`.
 */

import * as fs from 'fs';
import * as path from 'path';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Backend version contract — bump when QualityContractGeneratorService
 * changes shape. Agent compares the cached file's marker with this; if
 * mismatch, refetches even if file is fresh.
 *
 * Format: simple string compared verbatim. Backend doesn't yet emit a
 * machine-readable version stamp in the contract — this is forward-looking
 * for when the backend adds `<!-- CONTRACT_VERSION: ... -->`.
 */
const EXPECTED_CONTRACT_VERSION = 'v2-2026-04-29-no-fake-tools';

export interface EnsureContractOptions {
  /** Re-fetch even if a recent file exists. */
  force?: boolean;
}

export async function ensureQualityContract(
  api: any,
  projectId: string,
  repoPath: string,
  opts: EnsureContractOptions = {},
): Promise<{ written: boolean; reason: string; filePath: string }> {
  const targetDir = path.join(repoPath, '.makestudio');
  const filePath = path.join(targetDir, 'QUALITY_CONTRACT.md');

  // Skip if recent file exists, version matches, and we're not forcing.
  if (!opts.force && fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath);
      const age = Date.now() - stat.mtimeMs;
      const head = fs.readFileSync(filePath, 'utf8').slice(0, 400);
      const versionMismatch = head.includes('<!-- CONTRACT_VERSION:')
        && !head.includes(`<!-- CONTRACT_VERSION: ${EXPECTED_CONTRACT_VERSION} -->`);
      if (age < STALE_THRESHOLD_MS && !versionMismatch) {
        return { written: false, reason: `cached (age=${Math.round(age / 60000)}min)`, filePath };
      }
    } catch {
      // fall through to fetch
    }
  }

  let content: string;
  try {
    const res = await api.get(
      `/dark-factory/projects/${projectId}/quality-contract`,
      { timeout: 10_000 },
    );
    content = res.data?.content;
    if (!content) {
      return { written: false, reason: 'backend returned empty content', filePath };
    }
  } catch (err: any) {
    // Network failure must not block decomposition — decomposition uses
    // the prompt-embedded contract anyway. We just don't get the
    // persistent file.
    return {
      written: false,
      reason: `fetch failed (${err?.response?.status || 'network'}: ${err?.message || 'unknown'})`,
      filePath,
    };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return { written: true, reason: 'written', filePath };
  } catch (err: any) {
    return { written: false, reason: `write failed: ${err?.message || 'unknown'}`, filePath };
  }
}
