import { swallow } from '../utils/log';
/**
 * `execute` command — state module. Extracted from execute.ts.
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
import { getChangedFiles } from './execute-deps';
import { saveLastRun } from '../core/last-run';

import { IN_PROGRESS_FILE, InProgressEntry, InProgressFile, LocalCLIResult } from './execute-types';


export function readInProgressFile(): InProgressFile {
  try {
    if (!fs.existsSync(IN_PROGRESS_FILE)) return { tasks: [] };
    const content = fs.readFileSync(IN_PROGRESS_FILE, 'utf8');
    return JSON.parse(content) as InProgressFile;
  } catch {
    return { tasks: [] };
  }
}

export function writeInProgressFile(data: InProgressFile): void {
  try {
    fs.mkdirSync(path.dirname(IN_PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(IN_PROGRESS_FILE, JSON.stringify(data, null, 2));
  } catch (err) { swallow(err); }
}

export function addInProgressTask(taskId: string, dumId: string): void {
  const data = readInProgressFile();
  if (!data.tasks.find(t => t.id === taskId)) {
    data.tasks.push({ id: taskId, dumId, startedAt: new Date().toISOString() });
    writeInProgressFile(data);
  }
}

export function removeInProgressTask(taskId: string): void {
  const data = readInProgressFile();
  data.tasks = data.tasks.filter(t => t.id !== taskId);
  writeInProgressFile(data);
}

export async function recoverOrphanedTasks(api: any): Promise<void> {
  const data = readInProgressFile();
  if (data.tasks.length === 0) return;

  console.log(`${yellow('!')} Detectadas ${data.tasks.length} task(s) órfã(s) do último run — revertendo para pending...`);

  for (const entry of data.tasks) {
    try {
      await api.put(`/dark-factory/tasks/${entry.id}`, { status: 'pending' }, { timeout: 8_000 });
      console.log(`  ${green('✓')} Task ${entry.id.slice(0, 8)}... revertida para pending`);
    } catch (err: any) {
      console.log(`  ${yellow('!')} Não foi possível reverter task ${entry.id.slice(0, 8)}...: ${err.message}`);
    }
  }

  // Clear the file after recovery attempt
  writeInProgressFile({ tasks: [] });
}

export function writeExecutionState(
  cwd: string,
  dums: any[],
  tasksMap: Map<string, any[]>,
  runFilesByDum?: Record<string, string[]>,
): void {
  try {
    const dfDir = path.join(cwd, '.makestudio');
    fs.mkdirSync(dfDir, { recursive: true });

    // Load previously persisted files-by-DUM so we don't lose history when execute restarts
    const prevPath = path.join(dfDir, 'execution-state.json');
    let previousFiles: Record<string, string[]> = {};
    if (fs.existsSync(prevPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
        const prevDums = Array.isArray(prev) ? prev : (prev.dums || []);
        for (const entry of prevDums) {
          if (entry.dumNumber && Array.isArray(entry.filesCreated)) {
            previousFiles[entry.dumNumber] = entry.filesCreated;
          }
        }
      } catch (err) { swallow(err); }
    }

    const mergedFiles: Record<string, string[]> = { ...previousFiles, ...(runFilesByDum || {}) };

    const dumsState = dums.map(d => {
      const tasks = tasksMap.get(d.id) || [];
      return {
        dumNumber: d.dumNumber,
        title: d.title,
        type: d.type,
        status: d.stage,
        blockedByDumIds: d.blockedByDumIds || d.metadata?.blockedByDumIds || [],
        dependsOn: d.dependsOn || [],
        pendingTasks: tasks.filter(t => !['completed', 'done'].includes(t.status)).length,
        totalTasks: tasks.length,
        filesCreated: mergedFiles[d.dumNumber] || [],
      };
    });

    // Derive convention hints from accumulated filesCreated:
    // count how many files went under each top-2-level directory prefix.
    // Claude reads this to learn "mobile contracts live in app/lib/shared/contracts/".
    const prefixCounts: Record<string, number> = {};
    for (const list of Object.values(mergedFiles)) {
      for (const f of list) {
        const parts = f.split('/').slice(0, 4).join('/');
        if (parts) prefixCounts[parts] = (prefixCounts[parts] || 0) + 1;
      }
    }
    const conventionHints = Object.entries(prefixCounts)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([prefix, n]) => ({ prefix, count: n }));

    const state = {
      generatedAt: new Date().toISOString(),
      totalDums: dumsState.length,
      doneDums: dumsState.filter(d => d.pendingTasks === 0).length,
      conventionHints,
      dums: dumsState,
    };

    fs.writeFileSync(prevPath, JSON.stringify(state, null, 2));
  } catch (err) { swallow(err); }
}

export async function saveArtifacts(
  api: any,
  dum: any,
  projectId: string,
  tenantId: string,
  cwd: string,
  baseSha?: string,
): Promise<void> {
  const changedFiles = getChangedFiles(cwd, baseSha);
  if (changedFiles.length === 0) {
    console.log(`${dim('│')}    ${yellow('⚠')} ${dim('nenhum arquivo alterado detectado — 0 artifacts salvos')}`);
    return;
  }

  // Save all non-trivial changed files as artifacts. Skip tests, mocks, generated files.
  // Priority: all source files in src/, lib/, app/, api/, web/, mobile/, packages/.
  const PROJECT_ROOTS = /^(src|lib|app|api|web|mobile|packages|server|client|shared)\//;
  const SKIP_PATTERNS = /\.(test|spec|mock)\.|__tests__|node_modules|\.generated\./;

  const candidates = changedFiles
    .filter(f => PROJECT_ROOTS.test(f))
    .filter(f => !SKIP_PATTERNS.test(f))
    .slice(0, 30); // upper cap per DUM

  if (candidates.length === 0) {
    console.log(`${dim('│')}    ${dim(`nenhum arquivo fonte relevante entre ${changedFiles.length} mudanças`)}`);
    return;
  }

  let saved = 0;
  let failed = 0;
  for (const filePath of candidates) {
    try {
      const abs = path.join(cwd, filePath);
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (stat.size === 0 || stat.size > 500_000) continue; // skip empty or too-large

      const content = fs.readFileSync(abs, 'utf8');
      if (content.trim().length < 10) continue;

      // Classify artifact type by file extension + content signals
      let artifactType: 'CODE' | 'SPEC' | 'CONFIG' = 'CODE';
      if (/\.(json|yaml|yml|env)$/.test(filePath)) artifactType = 'CONFIG';
      else if (/\.md$/.test(filePath)) artifactType = 'SPEC';

      try {
        await api.post('/dark-factory/artifacts', {
          projectId,
          dumId: dum.id,
          type: artifactType,
          title: path.basename(filePath),
          filePath,
          content: content.substring(0, 8000),
          status: 'APPROVED',
        }, {
          headers: { 'x-tenant-id': tenantId },
          timeout: 15_000,
        });
        saved++;
      } catch (err: any) {
        failed++;
        // Log first failure to surface backend issues instead of silently swallowing
        if (failed === 1) {
          const msg = err.response?.data?.message || err.message;
          console.log(`${dim('│')}    ${yellow('⚠')} Falha ao salvar ${filePath}: ${dim(msg)}`);
        }
      }
    } catch (err) { swallow(err); }
  }

  const tail = failed > 0 ? ` · ${red(`${failed} falharam`)}` : '';
  console.log(`${dim('│')}    ${green('✓')} ${dim(`${saved}/${candidates.length} artifacts salvos no backend`)}${tail}`);
}
