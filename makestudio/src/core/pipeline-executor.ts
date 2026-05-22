import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PipelineDispatch } from '../types';
import { emitTaskCompleted, emitTaskFailed, emitTaskProgress } from '../network/ws-client';
import {
  checkoutBranch,
  commitAll,
  pushBranch,
  isRepoDirty,
  getCurrentBranch,
  fetchOrigin,
} from './git-ops';
import { parseClaudeOutputStream, parseGenericOutput } from './progress';
import { getCLICommand } from './cli-detector';
import { logTool, logInfo, logSuccess, logError } from '../ui/terminal';
import { spawn, ChildProcess } from 'child_process';
import {
  writeAgentContextToRepo,
  hasPriorSession,
  markSessionStarted,
  clearSession,
  buildRepoSnapshot,
} from './claude-md-writer';

import { swallow } from '../utils/log';
let activeProcess: ChildProcess | null = null;

function resolveWorkDir(pipeline: PipelineDispatch): string {
  if (!pipeline.repoUrl) throw new Error('Pipeline sem repoUrl');

  const repoName = pipeline.repoUrl.replace(/\.git$/, '').split('/').pop() || 'project';
  const WORKDIR_BASE = path.join(os.homedir(), '.makestudio', 'repos');
  const workDir = path.join(WORKDIR_BASE, repoName);

  if (!fs.existsSync(WORKDIR_BASE)) {
    fs.mkdirSync(WORKDIR_BASE, { recursive: true });
  }

  if (fs.existsSync(path.join(workDir, '.git'))) {
    logInfo(`Atualizando repo ${repoName}...`);
    try {
      execSync('git fetch origin', { cwd: workDir, stdio: 'pipe', timeout: 60_000 });
      // Pull develop (where PRs are merged), fallback to default branch
      let pullBranch = 'develop';
      try { execSync('git rev-parse --verify origin/develop', { cwd: workDir, stdio: 'pipe' }); }
      catch { pullBranch = getDefaultBranch(workDir); }
      execSync(`git checkout ${pullBranch} && git pull origin ${pullBranch}`, {
        cwd: workDir, stdio: 'pipe', timeout: 60_000,
      });
      logSuccess('Repo atualizado');
    } catch {
      logInfo('Pull falhou — continuando');
    }
  } else {
    logInfo(`Clonando ${repoName}...`);
    let cloneUrl = pipeline.repoUrl;
    if (pipeline.gitToken && cloneUrl.startsWith('https://')) {
      cloneUrl = cloneUrl.replace('https://', `https://x-access-token:${pipeline.gitToken}@`);
    }
    try {
      // Use argv form (no shell) so a malicious URL can't shell-inject.
      // Also avoids quoting issues with the credentialised URL.
      execSync('git', {
        input: '',
        stdio: 'pipe', timeout: 120_000,
      });
      // Use spawnSync directly with argv array — no shell interpolation.
      // execSync with a single command string still goes through `/bin/sh -c`.
      const { spawnSync } = require('child_process') as typeof import('child_process');
      const r = spawnSync('git', ['clone', cloneUrl, workDir], {
        stdio: 'pipe', timeout: 120_000, encoding: 'utf8',
      });
      if (r.status !== 0) {
        const safeStderr = (r.stderr || '').replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
        throw new Error(`git clone failed (exit ${r.status}): ${safeStderr.slice(0, 400)}`);
      }
      logSuccess('Clone concluído');
    } catch (cloneErr: any) {
      // Sanitize: never let the gitToken propagate via thrown errors → emitTaskFailed → backend log.
      const safeMsg = (cloneErr.message || '').replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
      throw new Error(`Pipeline clone failed: ${safeMsg.slice(0, 400)}`);
    }
  }

  return workDir;
}

function getDefaultBranch(repoPath: string): string {
  try {
    return execSync(
      "git remote show origin | grep 'HEAD branch' | awk '{print $NF}'",
      { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
    ).trim() || 'develop';
  } catch { return 'develop'; }
}

export async function executePipeline(
  pipeline: PipelineDispatch,
): Promise<void> {
  const startTime = Date.now();
  const { pipelineId, tasks, cli, taskBranch } = pipeline;

  try {
    // Resolve repo
    const repoPath = resolveWorkDir(pipeline);
    logInfo(`Diretório: ${repoPath}`);

    // Stash if dirty
    if (isRepoDirty(repoPath)) {
      try {
        execSync('git stash', { cwd: repoPath, stdio: 'pipe' });
        logSuccess('Stash aplicado');
      } catch {
        emitTaskFailed(pipelineId, 'Stash falhou');
        return;
      }
    }

    // Fetch + checkout branch
    fetchOrigin(repoPath);
    const originalBranch = getCurrentBranch(repoPath);

    if (taskBranch) {
      logInfo(`Checkout: ${taskBranch}`);
      checkoutBranch(repoPath, taskBranch, true);

      // Merge develop (always develop, not main — PRs target develop)
      try {
        // Try develop first, fallback to main
        let baseBranch = 'develop';
        try {
          execSync('git rev-parse --verify origin/develop', { cwd: repoPath, stdio: 'pipe' });
        } catch {
          baseBranch = getDefaultBranch(repoPath);
        }
        logInfo(`Merge origin/${baseBranch} na branch de trabalho...`);
        execSync(`git merge origin/${baseBranch} --no-edit`, {
          cwd: repoPath, stdio: 'pipe', timeout: 30_000,
        });
        logSuccess(`Merge com ${baseBranch} concluído`);
      } catch {
        try { execSync('git merge --abort', { cwd: repoPath, stdio: 'pipe' }); } catch (err) { swallow(err); }
        logError('Conflito ao fazer merge — continuando');
      }
    }

    // Write numbered task files
    const taskDir = path.join(os.tmpdir(), `makestudio-pipeline-${pipelineId}`);
    if (fs.existsSync(taskDir)) {
      fs.rmSync(taskDir, { recursive: true });
    }
    fs.mkdirSync(taskDir, { recursive: true });

    for (const task of tasks) {
      const fileName = `${String(task.index).padStart(3, '0')}-${task.taskType.toUpperCase()}.md`;
      const filePath = path.join(taskDir, fileName);
      fs.writeFileSync(filePath, task.prompt, 'utf8');
      logInfo(`Criado: ${fileName} (${Math.round(task.prompt.length / 1024)}KB)`);
    }

    // Build the master prompt
    const masterPrompt = `Você vai executar ${tasks.length} tasks de desenvolvimento em sequência.

## BRANCH DE TRABALHO — CRÍTICO
Você ESTÁ na branch **${taskBranch || 'feature'}**. NUNCA mude de branch!
NÃO faça checkout para main, develop, ou qualquer outra branch.
Todos os commits devem ser feitos NA BRANCH ATUAL (${taskBranch || 'feature'}).

Os arquivos de task estão em: ${taskDir}
Arquivos (na ordem de execução):
${tasks.map(t => `- ${String(t.index).padStart(3, '0')}-${t.taskType.toUpperCase()}.md: "${t.taskTitle}"`).join('\n')}

## INSTRUÇÕES
1. Leia cada arquivo .md NA ORDEM (001 primeiro, depois 002, etc.)
2. Para cada task, PRIMEIRO verifique se já está implementada no código (pre-check)
3. Se já implementada: emita a tag dedicada <already-implemented>[explicação com caminhos de arquivo]</already-implemented> no bloco daquela task e passe pra próxima
4. Se não implementada: execute o que está descrito
5. Após cada task com alterações: git add -A && git commit -m "feat(${taskBranch || 'task'}): [TIPO] título da task"
6. NÃO faça git push — o sistema gerencia o push
7. NÃO mude de branch — trabalhe APENAS em ${taskBranch || 'feature'}
8. Mantenha o contexto entre tasks — use o que aprendeu nas anteriores
9. Ao terminar cada task, emita um delimitador <task-result index="N" status="success|already_implemented|failed">...resumo + files_changed + commits...</task-result> para que o sistema possa atribuir a saída à task correta.

## REGRAS
- LEIA o código existente antes de modificar
- NUNCA recrie arquivos que já existem — EDITE-OS
- Siga os padrões do projeto
- Se uma task depende da anterior, use o que já foi criado
- PROIBIDO: git checkout main, git checkout develop, git switch

Comece lendo o primeiro arquivo e executando.`;

    // ── Write the agent-context file in the convention of the CLI that
    // will drive the pipeline (CLAUDE.md / AGENTS.md / GEMINI.md). Stale
    // siblings from a previous run with a different CLI are removed.
    if (pipeline.claudeMd) {
      const wrote = writeAgentContextToRepo(repoPath, pipeline.claudeMd, cli);
      if (wrote) {
        const fname = cli === 'codex' ? 'AGENTS.md' : cli === 'gemini' ? 'GEMINI.md' : 'CLAUDE.md';
        logSuccess(`Agent context gravado em ${fname}`);
      }
    }

    // ── Prepend repo snapshot on the first dispatch of this session ──
    const priorSession = hasPriorSession(pipeline.sessionId, taskBranch);
    let effectivePrompt = masterPrompt;
    if (!priorSession) {
      const snap = buildRepoSnapshot(repoPath);
      if (snap) effectivePrompt = `${snap}\n\n${masterPrompt}`;
    }

    // Spawn ONE CLI process
    logInfo(`Iniciando ${cli.toUpperCase()} — ${tasks.length} tasks em uma sessão${priorSession ? ' (--continue)' : ''}`);

    const cliPath = getCLICommand(cli);
    const args = buildCLIArgs(cli, { continueSession: priorSession && cli === 'claude' });

    // Mark the session so a future dispatch on the same branch continues it.
    markSessionStarted(pipeline.sessionId, taskBranch);

    const result = await spawnCLI(cliPath, args, repoPath, pipelineId, startTime, effectivePrompt);
    logSuccess(`Pipeline finalizou — custo: $${result.costUsd.toFixed(4)}`);

    // Git: commit remaining + push
    if (isRepoDirty(repoPath)) {
      logInfo('Commitando alterações restantes...');
      commitAll(repoPath, `feat(${taskBranch || 'pipeline'}): pipeline execution`);
      logSuccess('Commit final criado');
    }

    if (taskBranch) {
      logInfo(`Push origin/${taskBranch}...`);
      const pushed = pushBranch(repoPath, taskBranch);
      pushed ? logSuccess(`Push concluído`) : logError('Push falhou');
    }

    // Clean up task files
    try { fs.rmSync(taskDir, { recursive: true }); } catch (err) { swallow(err); }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    logSuccess(`Pipeline concluído em ${Math.floor(elapsed/60)}m${elapsed%60}s — custo: $${result.costUsd.toFixed(4)}`);

    // Pipeline finished — drop the session marker so the next pipeline on
    // the same branch starts fresh instead of stacking --continue.
    clearSession(pipeline.sessionId, taskBranch);

    emitTaskCompleted(pipelineId, result.content, result.costUsd, {
      branch: taskBranch,
      commits: tasks.length,
      pushed: true,
    });

    // Restore branch
    if (taskBranch && originalBranch !== taskBranch) {
      try { checkoutBranch(repoPath, originalBranch, false); } catch (err) { swallow(err); }
    }
  } catch (err: any) {
    logError(`Pipeline falhou: ${err.message}`);
    emitTaskFailed(pipelineId, err.message);
  } finally {
    activeProcess = null;
  }
}

function buildCLIArgs(
  cli: string,
  options?: { continueSession?: boolean },
): string[] {
  switch (cli) {
    case 'claude':
      return [
        ...(options?.continueSession ? ['--continue'] : []),
        '-p', '--output-format', 'stream-json', '--verbose',
        '--dangerously-skip-permissions', '--max-turns', '200',
      ];
    case 'codex':
      // Codex: fresh session every dispatch. Continuity between pipeline
      // runs on the same branch is handled by the AGENTS.md file written
      // at the repo root (mirror of CLAUDE.md content).
      // --full-auto runs codex in bubblewrap, which fails on hosts with
      // unprivileged user_namespace restrictions; bypass it (equivalent
      // to claude's --dangerously-skip-permissions, which we already pass).
      return ['exec', '--dangerously-bypass-approvals-and-sandbox'];
    case 'gemini':
      // Gemini: same strategy as Codex — continuity through GEMINI.md.
      return ['-y'];
    default:
      return [];
  }
}

async function spawnCLI(
  command: string, args: string[], cwd: string,
  pipelineId: string, startTime: number, prompt: string,
): Promise<{ content: string; costUsd: number }> {
  return new Promise((resolve, reject) => {
    // Filter env to allow-list — same as executor.ts. Without this, every
    // secret in the agent's env (TOKEN, AWS_KEY, etc.) leaks to the
    // spawned CLI and into its logs. Also prevents the LLM from observing
    // what credentials the operator has via `env | grep`.
    const safeEnv: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      if (/^(PATH|HOME|LANG|LC_|TERM|NODE_|npm_|SHELL|USER|LOGNAME|TMPDIR|XDG_|EDITOR|VISUAL)/.test(key)) {
        safeEnv[key] = process.env[key]!;
      }
    }
    const proc = spawn(command, args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], env: safeEnv,
    });
    activeProcess = proc;

    // Global timeout: kill if running > 60min. Pipelines run multiple
    // tasks in one CLI session so the cap is higher than single-task
    // executor (30min). Without this a stuck pipeline never finishes.
    const PIPELINE_TIMEOUT_MS = 60 * 60 * 1000;
    const processTimeout = setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
        reject(new Error(`Pipeline timed out after ${PIPELINE_TIMEOUT_MS / 60_000} minutes`));
      }
    }, PIPELINE_TIMEOUT_MS);

    if (proc.stdin) {
      proc.stdin.on('error', () => { /* prevent EPIPE crash */ });
      proc.stdin.write(prompt); proc.stdin.end();
    }

    let stdout = '', stderr = '', costUsd = 0;
    const isClaude = command.includes('claude');
    let lineBuffer = '';
    // Cap stdout/stderr to prevent OOM on long pipelines (5+ tasks ×
    // verbose tool outputs). Same shape as executor.ts.
    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stdout.length + text.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(-(MAX_OUTPUT_BYTES / 2)) + text;
      } else {
        stdout += text;
      }
      lineBuffer += text;
      const parts = lineBuffer.split('\n');
      lineBuffer = parts.pop() || '';

      for (const line of parts) {
        if (!line.trim()) continue;
        if (isClaude) {
          const event = parseClaudeOutputStream(pipelineId, line, startTime);
          if (event) {
            if (event.type === 'tool_call' && event.tool) logTool(event.tool, event.file || '');
            else if (event.type === 'text' && event.message) logInfo(event.message.substring(0, 120));
            else if (event.type === 'result') {
              logSuccess(event.message || 'Concluído');
              try { const p = JSON.parse(line); if (p.total_cost_usd) costUsd = p.total_cost_usd; } catch (err) { swallow(err); }
            }
          }
        } else {
          const event = parseGenericOutput(pipelineId, line, startTime);
          if (event?.message) logInfo(event.message);
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderr.length + text.length > MAX_OUTPUT_BYTES / 10) {
        stderr = stderr.slice(-(MAX_OUTPUT_BYTES / 20)) + text;
      } else {
        stderr += text;
      }
    });

    proc.on('close', (code) => {
      clearTimeout(processTimeout);
      activeProcess = null;
      if (code === 0 || code === null) {
        let content = stdout;
        if (isClaude) {
          const lines = stdout.split('\n');
          let lastText = '';
          for (const line of lines) {
            try {
              const p = JSON.parse(line);
              if (p.type === 'result') { resolve({ content: p.result || lastText, costUsd }); return; }
              if (p.type === 'assistant' && p.message?.content) {
                for (const b of p.message.content) {
                  if (b.type === 'text') lastText += b.text || '';
                }
              }
            } catch (err) { swallow(err); }
          }
          resolve({ content: lastText || content, costUsd });
        } else {
          resolve({ content, costUsd });
        }
      } else {
        reject(new Error(`CLI exited with code ${code}: ${stderr || 'Unknown error'}`));
      }
    });

    proc.on('error', (err) => { clearTimeout(processTimeout); activeProcess = null; reject(err); });
  });
}

export function cancelPipeline(): void {
  if (activeProcess) {
    activeProcess.kill('SIGTERM');
    setTimeout(() => { if (activeProcess && !activeProcess.killed) activeProcess.kill('SIGKILL'); }, 5000);
  }
}
