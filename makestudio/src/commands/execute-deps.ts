import { swallow } from '../utils/log';
/**
 * `execute` command — deps module. Extracted from execute.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import chalk from 'chalk';

const dim = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green = chalk.hex('#22C55E');
const cyan = chalk.hex('#22D3EE');
const red = chalk.hex('#EF4444');
const blue = chalk.hex('#60A5FA');
import { typeRank, extractNumericPart } from './execute-helpers';


export function topologicalSort(dums: any[]): any[] {
  // Build lookup maps: by id AND by dumNumber (since dependsOn uses DUM numbers now)
  const id2dum = new Map(dums.map(d => [d.id, d]));
  const number2dum = new Map<string, any>();
  for (const d of dums) {
    if (d.dumNumber) number2dum.set(d.dumNumber.toUpperCase(), d);
  }

  // Resolve a single dependency reference (UUID, "DUM-002", or "dum_002") to a DUM
  const resolveDep = (ref: string): any | null => {
    if (!ref) return null;
    // Try UUID lookup first
    if (id2dum.has(ref)) return id2dum.get(ref);
    // Normalize "dum_002" or "DUM-002" → "DUM-002"
    const numMatch = ref.match(/\d+/);
    if (!numMatch) return null;
    const normalized = `DUM-${numMatch[0].padStart(3, '0')}`;
    return number2dum.get(normalized) || null;
  };

  // Collect all dependencies for a DUM from every known field
  const getDeps = (d: any): any[] => {
    const refs = new Set<string>();
    // New entity column (array of DUM numbers): ["DUM-002", "DUM-005"]
    for (const r of (d.dependsOn || [])) refs.add(r);
    // Legacy: blockedByDumIds (array of real UUIDs) stored on DUM or in metadata
    for (const r of (d.blockedByDumIds || [])) refs.add(r);
    for (const r of (d.metadata?.blockedByDumIds || [])) refs.add(r);
    // Parent (if any)
    if (d.parentDumId) refs.add(d.parentDumId);
    return Array.from(refs).map(resolveDep).filter(Boolean) as any[];
  };

  const visited = new Set<string>();
  const inStack = new Set<string>(); // cycle guard
  const result: any[] = [];

  function visit(d: any) {
    if (visited.has(d.id)) return;
    if (inStack.has(d.id)) return; // cycle — skip, don't add again
    inStack.add(d.id);

    const deps = getDeps(d);
    // Sort deps by same type-rank criteria so traversal order is stable
    deps.sort((a, b) => {
      const ra = typeRank(a.type) - typeRank(b.type);
      if (ra !== 0) return ra;
      return extractNumericPart(a.dumNumber) - extractNumericPart(b.dumNumber);
    });
    for (const dep of deps) visit(dep);

    inStack.delete(d.id);
    visited.add(d.id);
    result.push(d);
  }

  // Primary seed order: level ASC → type rank ASC → dumNumber ASC.
  // This makes dependency-free DUMs flow in a logical "contracts first, then database,
  // then backend, then integration, then infra, then visual" order — not by createdAt.
  const seedOrder = [...dums].sort((a, b) => {
    const la = a.level || 2;
    const lb = b.level || 2;
    if (la !== lb) return la - lb;
    const ta = typeRank(a.type);
    const tb = typeRank(b.type);
    if (ta !== tb) return ta - tb;
    return extractNumericPart(a.dumNumber) - extractNumericPart(b.dumNumber);
  });

  for (const d of seedOrder) visit(d);
  return result;
}

export async function assertDependenciesComplete(
  dum: any,
  api: any,
): Promise<{ ok: boolean; blocking: string[] }> {
  const blockedByIds: string[] = dum.blockedByDumIds || dum.metadata?.blockedByDumIds || [];
  if (blockedByIds.length === 0) return { ok: true, blocking: [] };

  const blocking: string[] = [];
  for (const depId of blockedByIds) {
    try {
      const res = await api.get(`/dark-factory/tasks/dum/${depId}`, { timeout: 8_000 });
      const tasks: any[] = res.data?.tasks || res.data || [];
      const pending = tasks.filter(
        (t: any) => !['completed', 'done'].includes(t.status),
      ).length;
      if (pending > 0) {
        const dumRes = await api.get(`/dark-factory/dums/${depId}`, { timeout: 5_000 }).catch(() => null);
        const depNum = dumRes?.data?.dumNumber || depId.slice(0, 8);
        blocking.push(`${depNum} (${pending} tasks pendentes)`);
      }
    } catch (err) { swallow(err); }
  }

  return { ok: blocking.length === 0, blocking };
}

export async function verifyArtifactsOnDisk(
  dum: any,
  cwd: string,
  api: any,
): Promise<{ ok: boolean; missing: string[] }> {
  const blockedByIds: string[] = dum.blockedByDumIds || dum.metadata?.blockedByDumIds || [];
  const missing: string[] = [];

  for (const depId of blockedByIds) {
    try {
      const res = await api.get(`/dark-factory/artifacts/project/${depId}`, { timeout: 5_000 }).catch(() => null);
      if (!res) continue;
      const artifacts = res.data?.artifacts || res.data || [];
      for (const artifact of artifacts) {
        if (artifact.filePath) {
          const fullPath = path.join(cwd, artifact.filePath);
          if (!fs.existsSync(fullPath)) {
            missing.push(artifact.filePath);
          }
        }
      }
    } catch (err) { swallow(err); }
  }

  return { ok: missing.length === 0, missing };
}

export function getChangedFiles(cwd: string, baseSha?: string): string[] {
  const files = new Set<string>();
  const collect = (out: string) => {
    for (const line of out.split('\n')) {
      const cleaned = line.replace(/^[A-Z?!]{1,2}\s+/, '').trim();
      if (!cleaned) continue;
      // Handle renames: "old -> new"
      const maybeRenamed = cleaned.includes(' -> ') ? cleaned.split(' -> ')[1] : cleaned;
      if (/\.(ts|tsx|dart|js|jsx|py|sql|json|yaml|yml|md|env|prisma)$/.test(maybeRenamed)) {
        files.add(maybeRenamed);
      }
    }
  };

  // 1. Working-tree state (untracked + modified — independent of commits)
  try {
    const out = execSync('git status --porcelain', { cwd, timeout: 10_000 }).toString();
    collect(out);
  } catch (err) { swallow(err); }

  // 2. Committed changes since baseSha (if caller provided one)
  if (baseSha) {
    try {
      const out = execSync(`git diff --name-only ${baseSha} HEAD`, { cwd, timeout: 10_000 }).toString();
      collect(out);
    } catch (err) { swallow(err); }
  }

  return Array.from(files);
}

export function getCurrentSha(cwd: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { cwd, timeout: 5_000 }).toString().trim();
  } catch {
    return undefined;
  }
}

export async function runIntegrationCheckpoint(
  dum: any,
  cwd: string,
): Promise<{ passed: boolean; errors: string }> {
  const isDart = (dum.title || '').toLowerCase().includes('flutter') || dum.type === 'visual';
  const checkCmd = isDart
    ? 'fvm flutter analyze --no-fatal-infos 2>&1 | tail -10'
    : `npx swc src/ -d /tmp/swc-checkpoint-${dum.id?.slice(0, 8) || 'check'} --strip-leading-paths 2>&1 | tail -8`;

  try {
    const out = execSync(checkCmd, { cwd, timeout: 60_000, shell: '/bin/sh' }).toString();
    const failed = out.toLowerCase().includes('error:') || out.includes('error ts') || out.includes('✗');
    return { passed: !failed, errors: failed ? out.trim() : '' };
  } catch (e: any) {
    const errText = e.stdout?.toString() || e.stderr?.toString() || e.message || '';
    const failed = errText.toLowerCase().includes('error') || errText.length > 0;
    return { passed: !failed, errors: errText.slice(0, 500) };
  }
}
