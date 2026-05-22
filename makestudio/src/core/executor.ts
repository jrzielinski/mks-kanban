import { spawn, ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskDispatch, TaskResult, AgentRepos } from '../types';
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
import { loadConfig } from '../config/config';
import { logTool, logInfo, logSuccess, logError, logWarning } from '../ui/terminal';
import { startReplaySession, endReplaySession, logReplay, logToolCall as replayToolCall, logGitOp, logCost, logVerify, logRetry } from './replay-logger';
import { runVerification, buildRetryPrompt } from './verify-runner';
import { hudStartTask, hudToolCall, hudTaskCompleted, hudTaskFailed, hudVerifyAttempt, hudClearVerify, hudReset, printTaskSummary } from '../ui/hud';
import { pluginRegistry } from './plugin-registry';
import {
  writeAgentContextToRepo,
  hasPriorSession,
  markSessionStarted,
  buildRepoSnapshot,
} from './claude-md-writer';

import { swallow } from '../utils/log';
// Helper: log locally AND emit via WebSocket
let _taskId = '';
let _startTime = 0;
// Cached path to the makestudio binary for cli=self self-hosting mode.
// Resolved lazily on first use, then frozen — process.argv[1] can become
// stale if the user runs `nvm use <other>` mid-session.
let selfBinPath: string | undefined;

function progress(type: string, message: string) {
  emitTaskProgress(_taskId, type, Date.now() - _startTime, { message });
}

function pInfo(msg: string) { logInfo(msg); progress('info', msg); }
function pOk(msg: string) { logSuccess(msg); progress('result', msg); }
function pErr(msg: string) { logError(msg); progress('error', msg); }
function pGit(msg: string) { logInfo(msg); progress('git', msg); }

let activeProcess: ChildProcess | null = null;

const WORKDIR_BASE = path.join(os.homedir(), '.makestudio', 'repos');

export function cancelActiveTask(): void {
  if (activeProcess) {
    activeProcess.kill('SIGTERM');
    setTimeout(() => {
      if (activeProcess && !activeProcess.killed) {
        activeProcess.kill('SIGKILL');
      }
    }, 5000);
  }
}

/**
 * Resolve the working directory for a task.
 * Priority:
 * 1. task.repoUrl → clone/update in ~/.makestudio/repos/{name}
 * 2. task.repoLayer + registeredRepos[layer].path → use local path
 * 3. fallbackRepoPath (from --repo flag)
 * 4. throw if nothing configured
 */
function resolveWorkDir(task: TaskDispatch, fallbackRepoPath?: string, registeredRepos?: AgentRepos): string {
  if (task.repoUrl) {
    // Extract repo name from URL
    const repoName = task.repoUrl
      .replace(/\.git$/, '')
      .split('/')
      .pop() || 'project';

    const workDir = path.join(WORKDIR_BASE, repoName);

    // Ensure base dir exists
    if (!fs.existsSync(WORKDIR_BASE)) {
      fs.mkdirSync(WORKDIR_BASE, { recursive: true });
    }

    if (fs.existsSync(path.join(workDir, '.git'))) {
      // Repo already cloned — fetch latest
      pGit(`Atualizando repo ${repoName}...`);
      try {
        execSync('git fetch origin', { cwd: workDir, stdio: 'pipe', timeout: 60_000 });
        const defaultBranch = getDefaultBranch(workDir);
        pGit(`Pull origin/${defaultBranch}...`);
        execSync(`git checkout ${defaultBranch} && git pull origin ${defaultBranch}`, {
          cwd: workDir, stdio: 'pipe', timeout: 60_000,
        });
        pOk('Repo atualizado');
      } catch {
        pInfo('Pull falhou (non-fatal) — continuando');
      }
    } else {
      pGit(`Clonando ${repoName}...`);

      let cloneUrl = task.repoUrl;
      if (task.gitToken && cloneUrl.startsWith('https://')) {
        // Inject token for auth
        cloneUrl = cloneUrl.replace('https://', `https://x-access-token:${task.gitToken}@`);
      }

      try {
        execSync(`git clone '${cloneUrl.replace(/'/g, "'\\''")}' '${workDir.replace(/'/g, "'\\''")}' `, {
          stdio: 'pipe',
          timeout: 120_000,
        });
      } catch (cloneErr: any) {
        // Strip tokens from error messages before propagating
        const safeMsg = (cloneErr.message || '').replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
        throw new Error(`Clone failed: ${safeMsg}`);
      }
      pOk(`Clone concluído`);
    }

    return workDir;
  }

  // Use configured local repo path if repoLayer matches
  if (task.repoLayer && registeredRepos?.[task.repoLayer]?.path) {
    const localPath = registeredRepos[task.repoLayer]!.path;
    pInfo(`Usando repo local configurado para ${task.repoLayer}: ${localPath}`);
    return localPath;
  }

  // Fallback to single --repo path
  if (fallbackRepoPath) {
    return fallbackRepoPath;
  }

  // Oneshot tasks run in a temp dir — no project context to confuse the LLM
  if (task.oneshot) {
    return os.tmpdir();
  }

  throw new Error('Task sem repoUrl e nenhum --repo configurado. Configure repos com: makestudio start --reconfigure');
}

function getDefaultBranch(repoPath: string): string {
  try {
    const result = execSync(
      "git remote show origin | grep 'HEAD branch' | awk '{print $NF}'",
      { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 },
    ).trim();
    return result || 'develop';
  } catch {
    return 'develop';
  }
}

export async function executeTask(
  task: TaskDispatch,
  fallbackRepoPath?: string,
  registeredRepos?: AgentRepos,
): Promise<void> {
  const startTime = Date.now();
  const { taskId, cli, taskBranch, maxTurns } = task;
  _taskId = taskId;
  _startTime = startTime;

  // ── Plugin hook: beforeTaskExec ──
  if (pluginRegistry.count() > 0) {
    try {
      task = await pluginRegistry.runBeforeTaskExec(task);
    } catch (err: any) {
      logWarning(`[plugins] beforeTaskExec error (non-fatal): ${err.message}`);
    }
  }

  // ── Enrich prompt with hook context from backend ──
  let prompt = task.prompt;
  if (task.hookContext) {
    prompt += '\n\n' + task.hookContext;
    pInfo(`Hook context injetado (+${Math.round(task.hookContext.length / 1024)}KB)`);
  }

  // ── Session replay: start ──
  const replayId = `task_${taskId}_${Date.now()}`;
  startReplaySession(replayId);
  logReplay('task_start', taskId, {
    title: task.taskTitle, type: task.taskType, tier: task.modelTier, cli,
  });

  // ── HUD: start task ──
  hudStartTask({
    title: task.taskTitle || taskId,
    type: task.taskType,
    tier: task.modelTier,
  });

  const maxRetries = task.persistenceMode ? (task.maxRetries || 10) : (task.maxRetries || 3);
  let totalCostUsd = 0;
  let retryCount = 0;

  try {
    // Resolve working directory (clone if needed, or use local path)
    const repoPath = resolveWorkDir(task, fallbackRepoPath, registeredRepos);
    pInfo(`Diretório: ${repoPath}`);
    logReplay('workdir', taskId, { repoPath });

    const isOneshot = !!task.oneshot;

    if (!isOneshot) {
      // Validate repo is clean
      if (isRepoDirty(repoPath)) {
        pGit('Repo com alterações — aplicando stash...');
        logGitOp(taskId, 'stash', 'dirty repo');
        try {
          execSync('git stash', { cwd: repoPath, stdio: 'pipe' });
          pOk('Stash aplicado');
        } catch {
          pErr('Stash falhou — abortando');
          emitTaskFailed(taskId, 'Repositório com alterações. Stash falhou.');
          return;
        }
      }

      pGit('git fetch origin...');
      fetchOrigin(repoPath);
      logGitOp(taskId, 'fetch', 'origin');
      pOk('Fetch concluído');

      const originalBranch = getCurrentBranch(repoPath);
      pGit(`Branch atual: ${originalBranch}`);

      if (taskBranch) {
        pGit(`Checkout: ${taskBranch}`);
        checkoutBranch(repoPath, taskBranch, true);
        logGitOp(taskId, 'checkout', taskBranch);
        pOk(`Branch ${taskBranch} pronta`);

        // Merge develop into working branch to avoid conflicts
        try {
          let baseBranch = 'develop';
          try { execSync('git rev-parse --verify origin/develop', { cwd: repoPath, stdio: 'pipe' }); }
          catch { baseBranch = getDefaultBranch(repoPath); }
          pGit(`Merge origin/${baseBranch} na branch de trabalho...`);
          execSync(`git merge origin/${baseBranch} --no-edit`, {
            cwd: repoPath, stdio: 'pipe', timeout: 30_000,
          });
          logGitOp(taskId, 'merge', baseBranch);
          pOk(`Merge com ${baseBranch} concluído — branch atualizada`);
        } catch (mergeErr: any) {
          try { execSync('git merge --abort', { cwd: repoPath, stdio: 'pipe' }); } catch (err) { swallow(err); }
          pErr('Conflito ao fazer merge com develop — continuando sem merge');
        }
      }
    }

    // ── Write agent-context file in the convention of the CLI that will
    // actually run the task (CLAUDE.md / AGENTS.md / GEMINI.md). Any stale
    // sibling from a previous dispatch with a different CLI is removed.
    if (task.claudeMd) {
      const wrote = writeAgentContextToRepo(repoPath, task.claudeMd, cli);
      if (wrote) {
        const fname = cli === 'codex' ? 'AGENTS.md' : cli === 'gemini' ? 'GEMINI.md' : 'CLAUDE.md';
        pOk(`Agent context gravado em ${fname}`);
      }
    }

    // ── Repo snapshot: prepend a short "where am I" section the first time
    // the agent runs on this (sessionId, branch). Gives the CLI a head start
    // without forcing Glob/Grep rounds just to learn the layout.
    const priorSession = hasPriorSession(task.sessionId, taskBranch);
    const shouldAttachSnapshot = !priorSession;

    // ── Execute with VERIFY/RETRY LOOP ──
    let currentPrompt = prompt;
    if (shouldAttachSnapshot) {
      const snap = buildRepoSnapshot(repoPath);
      if (snap) currentPrompt = `${snap}\n\n${currentPrompt}`;
    }
    let finalContent = '';
    let lastResult: { content: string; costUsd: number } | null = null;
    let verifyResult: { passed: boolean; checks: Array<{ name: string; passed: boolean; output?: string }> } | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      pInfo(`Prompt: ${Math.round(currentPrompt.length / 1024)}KB ${attempt > 1 ? `(retry ${attempt}/${maxRetries})` : ''}`);

      if (attempt > 1) {
        hudVerifyAttempt(attempt, maxRetries);
        logRetry(taskId, attempt, 'verify failed');
        logWarning(`[retry] Tentativa ${attempt}/${maxRetries}...`);
      }

      // Pass `continueSession=true` on Claude Code when the backend declared
      // a session id and we've already seen it on this branch. The CLI then
      // picks up the previous conversation instead of starting cold.
      const continueSession = priorSession && cli === 'claude';
      const { args } = buildCLICommand(cli, maxTurns, { continueSession });
      const cliPath = getCLICommand(cli);
      pInfo(`Iniciando ${cli.toUpperCase()}${continueSession ? ' (--continue)' : ''}...`);

      // Record the session so the next task on the same branch continues it.
      markSessionStarted(task.sessionId, taskBranch);

      const result = await spawnCLI(cliPath, args, repoPath, taskId, startTime, currentPrompt);
      totalCostUsd += result.costUsd;
      lastResult = result;
      logCost(taskId, result.costUsd, cli);
      pOk(`${cli.toUpperCase()} finalizou — custo: $${result.costUsd.toFixed(4)}`);

      // ── Post-execution VERIFICATION ──
      if (!isOneshot && task.taskType !== 'planning' && task.taskType !== 'design') {
        pInfo('[verify] Rodando verificações pós-execução...');
        verifyResult = await runVerification(repoPath, task.taskType);
        logVerify(taskId, verifyResult.passed, verifyResult.checks.map(c => `${c.name}:${c.passed}`).join(','));

        if (!verifyResult.passed && attempt < maxRetries) {
          // Build retry prompt with error context
          currentPrompt = buildRetryPrompt(prompt, verifyResult, attempt + 1, maxRetries);
          retryCount++;

          // ── LEARNING: report failure context to backend ──
          const failedChecks = verifyResult.checks.filter(c => !c.passed).map(c => c.output || c.name).join('; ');
          emitTaskProgress(taskId, 'verify_failed', Date.now() - startTime, {
            message: `Verification failed (attempt ${attempt}/${maxRetries}): ${failedChecks}`,
          });

          continue; // RETRY
        }

        if (verifyResult.passed) {
          hudClearVerify();
          pOk('[verify] Todas as verificações passaram ✓');

          // ── LEARNING: report success after retry ──
          if (retryCount > 0) {
            emitTaskProgress(taskId, 'verify_fixed', Date.now() - startTime, {
              message: `Fixed after ${retryCount} retry(ies). Learning saved.`,
            });
          }
        }
      }

      break; // Verification passed or max retries hit
    }

    // If verification ran but failed on final attempt, report the task as
    // FAILED to the backend. Emitting task:completed here would leak a
    // broken artifact into the pipeline — the backend treats task:completed
    // as success regardless of progress messages. We still end replay and
    // reset HUD cleanly.
    if (verifyResult && !verifyResult.passed) {
      const failedNames = verifyResult.checks?.filter(c => !c.passed).map(c => c.name).join(', ');
      const failMsg = `Verification failed after ${retryCount} retries: ${failedNames}`;
      pErr(failMsg);
      emitTaskProgress(taskId, 'verify_failed', Date.now() - startTime, { message: failMsg });
      hudTaskFailed();
      logReplay('task_end', taskId, { status: 'failed', error: failMsg });
      endReplaySession();
      emitTaskFailed(taskId, failMsg);
      return;
    }

    // Check for .md files created by CLI
    finalContent = lastResult?.content || '';
    try {
      const mdFiles = execSync('git diff --name-only --diff-filter=A HEAD', { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').filter(f => f.endsWith('.md'));
      if (mdFiles.length === 0) {
        const untrackedMd = execSync("git ls-files --others --exclude-standard '*.md'", { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').filter(Boolean);
        mdFiles.push(...untrackedMd);
      }
      if (mdFiles.length > 0) {
        const mdContents = mdFiles.map(f => {
          try { return fs.readFileSync(path.join(repoPath, f), 'utf8'); } catch { return ''; }
        }).filter(Boolean);
        if (mdContents.length > 0) {
          finalContent = mdContents.join('\n\n---\n\n');
          pInfo(`Capturado conteúdo de ${mdFiles.length} arquivo(s) .md`);
        }
      }
    } catch (err) { swallow(err); }

    // Git operations (skip for oneshot tasks)
    let gitInfo: TaskResult['gitInfo'] = taskBranch ? { branch: taskBranch } : undefined;

    if (!isOneshot) {
      let commits = 0;
      const originalBranch = getCurrentBranch(repoPath);

      if (isRepoDirty(repoPath)) {
        pGit('Commitando alterações...');
        commits = commitAll(repoPath, `feat(${taskBranch || 'task'}): ${task.taskTitle || taskId}`);
        logGitOp(taskId, 'commit', `${commits} commits`);
        pOk(`${commits} commit(s) criado(s)`);
      } else {
        pInfo('Sem alterações pra commitar');
      }

      if (taskBranch) {
        // ── Plugin hook: beforeGitPush ──
        let pushAllowed = true;
        if (pluginRegistry.count() > 0) {
          try {
            pushAllowed = await pluginRegistry.runBeforeGitPush({ repoPath, branch: taskBranch, taskId });
          } catch (err) { swallow(err); }
        }

        if (pushAllowed) {
          pGit(`Push origin/${taskBranch}...`);
          const pushed = pushBranch(repoPath, taskBranch);
          gitInfo = { branch: taskBranch, commits, pushed };
          logGitOp(taskId, 'push', pushed ? 'success' : 'failed');
          pushed ? pOk(`Push concluído: origin/${taskBranch}`) : pErr('Push falhou');
        } else {
          gitInfo = { branch: taskBranch, commits, pushed: false };
          pInfo(`Push vetado por plugin — branch ${taskBranch} não enviada`);
        }
      }

      if (taskBranch && originalBranch !== taskBranch) {
        try { checkoutBranch(repoPath, originalBranch, false); } catch (err) { swallow(err); }
      }
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // ── HUD: task summary ──
    hudTaskCompleted(totalCostUsd);
    printTaskSummary({
      title: task.taskTitle || taskId,
      type: task.taskType,
      costUsd: totalCostUsd,
      durationMs: Date.now() - startTime,
      toolCalls: 0, // TODO: count from stream-json
      verified: retryCount === 0,
      retries: retryCount,
    });

    // ── Session replay: end ──
    logReplay('task_end', taskId, { status: 'completed', costUsd: totalCostUsd, retries: retryCount });
    endReplaySession();

    pOk(`Task concluída em ${Math.floor(elapsed/60)}m${elapsed%60}s — custo: $${totalCostUsd.toFixed(4)}${retryCount > 0 ? ` (${retryCount} retries)` : ''}`);

    // ── Plugin hook: afterTaskExec ──
    if (pluginRegistry.count() > 0) {
      try {
        await pluginRegistry.runAfterTaskExec(task, { taskId, content: finalContent, costUsd: totalCostUsd, gitInfo });
      } catch (err) { swallow(err); }
    }

    emitTaskCompleted(taskId, finalContent, totalCostUsd, gitInfo);
  } catch (err: any) {
    hudTaskFailed();
    logReplay('task_end', taskId, { status: 'failed', error: err.message });
    endReplaySession();
    emitTaskFailed(taskId, err.message || 'Erro desconhecido na execução');
  } finally {
    activeProcess = null;
    hudReset();
  }
}

function buildCLICommand(
  cli: string,
  maxTurns?: number,
  options?: { continueSession?: boolean },
): { command: string; args: string[] } {
  const config = loadConfig();
  const extraFlags = config?.cliExtraFlags ?? {};

  switch (cli) {
    case 'claude':
      // claude CLI: -p = print mode, prompt via stdin, --verbose required for stream-json
      // --continue tells the CLI to pick up the previous conversation on
      // this working directory — used when the backend signalled that this
      // task belongs to an ongoing pipeline session on the same branch.
      return {
        command: 'claude',
        args: [
          ...(options?.continueSession ? ['--continue'] : []),
          '-p',
          '--output-format', 'stream-json',
          '--verbose',
          '--dangerously-skip-permissions',
          ...(maxTurns ? ['--max-turns', String(maxTurns)] : []),
          ...(extraFlags.claude ?? []),
        ],
      };
    case 'codex':
      // OpenAI Codex CLI has no stable `--continue` equivalent that we can
      // rely on across versions, so we always start fresh. Continuity
      // between pipeline tasks comes from AGENTS.md at the repo root,
      // which the backend regenerates on each dispatch with an updated
      // prior-task summary.
      return {
        command: 'codex',
        // --full-auto runs codex inside a bubblewrap sandbox; on hosts
        // where unprivileged user_namespaces are restricted, bwrap fails
        // with "Failed RTM_NEWADDR" and codex aborts before any tool call.
        // The user already opted into the local agent (makestudio start),
        // so bypass sandbox + approvals — equivalent to claude's `--yes`.
        args: ['exec', '--dangerously-bypass-approvals-and-sandbox', ...(extraFlags.codex ?? [])],
      };
    case 'gemini':
      // Gemini CLI: same story as Codex — continuity is provided through
      // GEMINI.md at the repo root rather than a CLI resume flag.
      return {
        command: 'gemini',
        args: ['-y', ...(extraFlags.gemini ?? [])],
      };
    case 'makestudio':
    case 'self':
    case 'ms': {
      // Self-hosting mode: DarkFactory invokes the MakeStudio agent itself
      // instead of delegating to claude/codex/gemini. Eliminates the
      // external-CLI dependency (user doesn't need claude CLI installed),
      // gives us full control over safety rails + instrumentation, and
      // reuses everything we built in the REPL (permissions, hooks,
      // verification subagent, checkpoints, etc.).
      //
      // We shell out to our own binary with `-p` / `--yes` so the spawn
      // loop stays unchanged. runHeadless emits structured events via
      // --json so the executor's output parser can attribute tool_use /
      // text / result blocks the same way it does for Claude's stream-json.
      //
      // Alternative would be in-process `await runHeadless(...)` — simpler
      // BUT shares the parent's ReplContext / event loop / memory heap;
      // a runaway task would corrupt the orchestrator. Spawning a child
      // keeps DarkFactory's isolation guarantees.
      //
      // Resolve the binary at startup, not at every spawn. process.argv[1]
      // can disappear under nvm if the user switched node versions during
      // the agent's lifetime (the path becomes stale). We cache + verify
      // existence; on miss, fall back to the `makestudio` name in PATH.
      const fs = require('fs') as typeof import('fs');
      const cachedPath = (selfBinPath ??=
        process.argv[1] && fs.existsSync(process.argv[1])
          ? process.argv[1]
          : 'makestudio');
      return {
        command: cachedPath,
        args: [
          '-p',
          '--yes',            // DarkFactory already validated the task; skip per-tool prompts
          '--json',           // structured output for executor's parser
          ...(options?.continueSession ? ['-c'] : []),
          ...(maxTurns ? ['--max-turns', String(maxTurns)] : []),
          ...(extraFlags.makestudio ?? []),
        ],
      };
    }
    default: {
      // Check plugin CLI strategies
      const pluginStrategy = pluginRegistry.getCLIStrategies().find(s => s.name === cli);
      if (pluginStrategy) {
        return pluginStrategy.buildCommand('', { maxTurns, extraFlags: [], modelTier: undefined });
      }
      return { command: cli, args: [] };
    }
  }
}

async function spawnCLI(
  command: string,
  args: string[],
  cwd: string,
  taskId: string,
  startTime: number,
  prompt?: string,
): Promise<{ content: string; costUsd: number }> {
  return new Promise((resolve, reject) => {
    // Filter environment to avoid leaking secrets to spawned CLI
    const safeEnv: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      // Pass only safe env vars (PATH, HOME, LANG, NODE, npm, etc.)
      if (/^(PATH|HOME|LANG|LC_|TERM|NODE_|npm_|SHELL|USER|LOGNAME|TMPDIR|XDG_|EDITOR|VISUAL)/.test(key)) {
        safeEnv[key] = process.env[key]!;
      }
    }

    const proc = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: safeEnv,
    });

    activeProcess = proc;

    // Global timeout: kill process if it runs longer than 30 minutes
    const processTimeout = setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
        reject(new Error('Task timed out after 30 minutes'));
      }
    }, 30 * 60 * 1000);

    // Heartbeat every 30s so frontend knows the task is alive
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logInfo(`[heartbeat] ${command} rodando há ${elapsed}s...`);
      emitTaskProgress(taskId, 'info', Date.now() - startTime, { message: `⏳ Processando... ${elapsed}s` });
    }, 30_000);

    // Send prompt via stdin then close
    if (prompt && proc.stdin) {
      proc.stdin.on('error', () => {}); // Prevent EPIPE crash
      proc.stdin.write(prompt);
      proc.stdin.end();
    } else if (proc.stdin) {
      proc.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    let costUsd = 0;
    const isClaude = command.includes('claude');
    let lineBuffer = '';
    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB cap to prevent OOM

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Cap stdout to avoid OOM on extremely verbose tasks — keep the tail (most recent)
      if (stdout.length + text.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(-(MAX_OUTPUT_BYTES / 2)) + text;
      } else {
        stdout += text;
      }

      // Buffer partial lines — only process complete lines (ending with \n)
      lineBuffer += text;
      const parts = lineBuffer.split('\n');
      // Keep the last part (may be incomplete) in buffer
      lineBuffer = parts.pop() || '';

      for (const line of parts) {
        if (!line.trim()) continue;
        if (isClaude) {
          const event = parseClaudeOutputStream(taskId, line, startTime);
          if (event) {
            if (event.type === 'tool_call' && event.tool) {
              logTool(event.tool, event.file || '');
            } else if (event.type === 'text' && event.message) {
              logInfo(event.message.substring(0, 120));
            } else if (event.type === 'result') {
              logSuccess(event.message || 'Concluído');
              try {
                const parsed = JSON.parse(line);
                if (parsed.total_cost_usd) costUsd = parsed.total_cost_usd;
              } catch (err) { swallow(err); }
            }
          }
        } else {
          const event = parseGenericOutput(taskId, line, startTime);
          if (event?.message) logInfo(event.message);
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Cap stderr to avoid OOM
      if (stderr.length + text.length > MAX_OUTPUT_BYTES / 10) {
        stderr = stderr.slice(-(MAX_OUTPUT_BYTES / 20)) + text;
      } else {
        stderr += text;
      }
      // Log stderr in real-time — critical for debugging
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          logError(`[stderr] ${trimmed}`);
          emitTaskProgress(taskId, 'error', Date.now() - startTime, { message: `[stderr] ${trimmed}` });
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(processTimeout);
      clearInterval(heartbeat);
      activeProcess = null;
      logInfo(`[spawn] ${command} encerrou com código ${code}, stdout=${stdout.length}b, stderr=${stderr.length}b`);
      if (code === 0 || code === null) {
        let content = stdout;
        if (isClaude) content = extractClaudeResult(stdout);
        resolve({ content, costUsd });
      } else {
        reject(new Error(`CLI exited with code ${code}: ${stderr.slice(0, 500) || 'Unknown error'}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(processTimeout);
      clearInterval(heartbeat);
      activeProcess = null;
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });
  });
}

function extractClaudeResult(stdout: string): string {
  const lines = stdout.split('\n');
  let lastText = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);

      // Result event — authoritative final output
      if (parsed.type === 'result') {
        return parsed.result || lastText;
      }

      // Assistant message — extract all text blocks
      if (parsed.type === 'assistant') {
        // Format 1: { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
        if (parsed.message?.content && Array.isArray(parsed.message.content)) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              lastText += block.text;
            }
          }
        }
        // Format 2: { type: "assistant", subtype: "text", text: "..." }
        if (parsed.subtype === 'text' && parsed.text) {
          lastText += parsed.text;
        }
      }
    } catch {
      // Not JSON — skip
    }
  }

  return lastText;
}
