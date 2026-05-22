import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { loadConfig, saveConfig } from '../config/config';
import { ensureAuthenticated } from '../network/auth';
import {
  connectWebSocket,
  registerAgent,
  disconnectWebSocket,
} from '../network/ws-client';
import { detectInstalledCLIs } from '../core/cli-detector';
import { isGitRepo, getRepoRemoteUrl } from '../core/git-ops';
import { runProjectPreparation } from '../core/project-prep';
import { executeTask, cancelActiveTask } from '../core/executor';
import { executePipeline, cancelPipeline } from '../core/pipeline-executor';
import { showBanner, showStatus } from '../ui/banner';
import {
  logInfo,
  logSuccess,
  logError,
  logWarning,
  logTask,
} from '../ui/terminal';
import { TaskDispatch, PipelineDispatch, DecompositionDispatch, AnalysisTrigger } from '../types';
import { runDecompose } from './refine';
import { cleanupOldReplays } from '../core/replay-logger';

import { swallow } from '../utils/log';
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ── Chalk color helper (chalk is already a devDep) ──────────────
function c(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const bold = (t: string) => c(t, 1);
const dim = (t: string) => c(t, 2);
const green = (t: string) => c(t, 32);
const cyan = (t: string) => c(t, 36);
const yellow = (t: string) => c(t, 33);

/**
 * Interactive wizard for configuring multi-repo local paths.
 * Saves configuration to ~/.makestudio/config.json.
 */
async function runRepoWizard(): Promise<{
  repos: { backend?: { path: string }; frontend?: { path: string }; mobile?: { path: string } };
}> {
  const repos: { backend?: { path: string }; frontend?: { path: string }; mobile?: { path: string } } = {};

  console.log('');
  console.log(bold('◆  MakeStudio — Configuração de Repositórios'));
  console.log(dim('│'));
  console.log(`${dim('│')}  Configure paths locais para cada layer do projeto.`);
  console.log(`${dim('│')}  Deixe ${bold('em branco')} para usar auto-clone do GitHub.`);
  console.log(dim('│'));

  const layers: Array<{ key: 'backend' | 'frontend' | 'mobile'; label: string; example: string }> = [
    { key: 'backend', label: 'Backend (NestJS/Node.js/Python/etc.)', example: './meu-projeto-api' },
    { key: 'frontend', label: 'Frontend (React/Next.js/Vue/etc.)', example: './meu-projeto-web' },
    { key: 'mobile', label: 'Mobile (Flutter/React Native/etc.)', example: './meu-projeto-flutter' },
  ];

  for (const layer of layers) {
    const answer = await ask(`${dim('◆')}  ${cyan(layer.label)} ${dim(`(ex: ${layer.example})`)}\n${dim('│')}  Path local ${dim('[Enter para pular]')}: `);
    if (answer) {
      const resolved = path.resolve(answer);
      if (isGitRepo(resolved)) {
        console.log(`${dim('│')}  ${green('✓')} Git repo válido: ${resolved}`);
        repos[layer.key] = { path: resolved };
      } else {
        console.log(`${dim('│')}  ${yellow('⚠')} Não é um repositório Git. Ignorado (use auto-clone).`);
      }
    } else {
      console.log(`${dim('│')}  ${dim('→ Usando auto-clone do GitHub')}`);
    }
    console.log(dim('│'));
  }

  return { repos };
}

export async function startCommand(options: {
  repo?: string;
  repoBackend?: string;
  repoFrontend?: string;
  repoMobile?: string;
  cli?: string;
  simple?: boolean;
  reconfigure?: boolean;
  auto?: boolean; // Auto-pick mode: autonomously pick and execute pending tasks
  autoPoll?: number; // Polling interval in seconds (default: 30)
}): Promise<void> {
  if (!process.env.MAKESTUDIO_REPL) showBanner();

  // Cleanup old replay files (keep last 50)
  cleanupOldReplays();

  // Auth
  let token: string;
  try {
    token = await ensureAuthenticated();
  } catch (err: any) {
    logError(err.message);
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    logError('Configuração não encontrada. Execute: makestudio login');
    process.exit(1);
  }

  // Resolve repo path: explicit --repo flag, or auto-detect current directory
  let repoPath: string | undefined = options.repo ? path.resolve(options.repo) : undefined;

  // Active decompositions keyed by projectId — populated when backend
  // dispatches decomposition:dispatch, drained by decomposition:cancel
  // (or normal completion). Lets the cancel handler abort runDecompose
  // mid-run instead of letting it burn the full budget.
  const activeDecompositions: Map<string, AbortController> = new Map();
  if (repoPath && !isGitRepo(repoPath)) {
    logWarning(`${repoPath} não é um repositório Git. Tasks usarão repoUrl do backend.`);
    repoPath = undefined;
  }
  // Auto-detect: if running from inside a git repo (and no explicit --repo), offer to use it
  if (!repoPath && !options.repoBackend && !options.repoFrontend && !options.repoMobile) {
    const cwd = process.cwd();
    if (isGitRepo(cwd)) {
      try {
        const remoteUrl = getRepoRemoteUrl(cwd);
        const repoName = path.basename(cwd);
        console.log('');
        logInfo(`Detectado repositório git: ${cyan(repoName)}${remoteUrl ? ` (${dim(remoteUrl)})` : ''}`);

        // ── Boilerplate guard: block if remote still points to a template ──
        const BOILERPLATE_PATTERNS = [/boilerplate/i, /template/i, /starter/i, /scaffold/i, /skeleton/i];
        if (remoteUrl && BOILERPLATE_PATTERNS.some(p => p.test(remoteUrl))) {
          console.log('');
          console.log(`  ${yellow('⚠')}  ${yellow('ATENÇÃO: Remote aponta para um boilerplate/template.')}`);
          console.log(`  ${dim('Este diretório ainda não foi inicializado como projeto.')}`);
          console.log('');
          console.log(`  Execute primeiro:`);
          console.log(`    ${cyan('makestudio init')}`);
          console.log('');
          console.log(`  O ${cyan('init')} vai:`);
          console.log(`    ${dim('→')} Criar um novo repositório GitHub para o projeto`);
          console.log(`    ${dim('→')} Trocar o remote de origin para o novo repo`);
          console.log(`    ${dim('→')} Fazer push do código`);
          console.log(`    ${dim('→')} Opcionalmente adaptar o boilerplate com IA (renomear configs, package.json, README)`);
          console.log('');
          process.exit(1);
        }

        const useIt = await ask(`  Usar ${bold(cwd)} para as tasks? [S/n]: `);
        if (useIt.toLowerCase() !== 'n' && useIt.toLowerCase() !== 'nao' && useIt.toLowerCase() !== 'não') {
          repoPath = cwd;
          logSuccess(`Repositório local ativo: ${repoPath}`);

          // ── Protected branch guard ────────────────────────────────
          // Never allow agent to operate on main/master directly
          try {
            const { execSync } = await import('child_process');
            const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
              cwd: repoPath, encoding: 'utf8', stdio: 'pipe',
            }).trim();

            const PROTECTED = new Set(['main', 'master', 'production', 'prod', 'release']);
            if (PROTECTED.has(currentBranch.toLowerCase())) {
              console.log('');
              console.log(`  ${yellow('⚠')}  ${yellow(`Branch protegida detectada: ${bold(currentBranch)}`)}`);
              console.log(`  ${dim('O agent NUNCA deve operar diretamente em main/master.')}`);
              console.log(`  ${dim('Cada task cria sua própria branch de trabalho, mas a base precisa ser develop.')}`);
              console.log('');

              // Check if develop branch exists
              let developExists = false;
              try {
                execSync('git rev-parse --verify develop', { cwd: repoPath, stdio: 'pipe' });
                developExists = true;
              } catch (err) { swallow(err); }

              const action = developExists
                ? await ask(`  Trocar para ${cyan('develop')} agora? [S/n]: `)
                : await ask(`  Criar e trocar para ${cyan('develop')} agora? [S/n]: `);

              if (action.toLowerCase() !== 'n' && action.toLowerCase() !== 'nao' && action.toLowerCase() !== 'não') {
                if (!developExists) {
                  execSync('git checkout -b develop', { cwd: repoPath, stdio: 'pipe' });
                  logSuccess(`Branch ${cyan('develop')} criada a partir de ${currentBranch}`);
                  // Push develop to remote
                  try {
                    execSync('git push -u origin develop', { cwd: repoPath, stdio: 'pipe', timeout: 30_000 });
                    logSuccess(`Push origin/develop concluído`);
                  } catch { logWarning('Push de develop falhou — continuando localmente'); }
                } else {
                  execSync('git checkout develop', { cwd: repoPath, stdio: 'pipe' });
                  logSuccess(`Trocado para branch ${cyan('develop')}`);
                }
              } else {
                logWarning(`Operando em ${bold(currentBranch)} — RISCO: tasks podem commitar direto na branch principal!`);
              }
            }
          } catch (err) { swallow(err); }
        }
      } catch (err) { swallow(err); }
    }
  }

  // Multi-repo configuration
  // Direct flags (--repo-backend, --repo-frontend, --repo-mobile) always take precedence
  // --reconfigure forces the wizard; otherwise repos come from config.json (set previously)
  // By default: no wizard on startup — tasks use auto-clone from GitHub automatically
  let registeredRepos = config.repos || {};
  const hasDirectFlags = options.repoBackend || options.repoFrontend || options.repoMobile;

  if (hasDirectFlags) {
    const directRepos: Record<string, { path: string }> = {};
    if (options.repoBackend) { const p = path.resolve(options.repoBackend); if (isGitRepo(p)) { directRepos.backend = { path: p }; logSuccess(`Backend repo: ${p}`); } }
    if (options.repoFrontend) { const p = path.resolve(options.repoFrontend); if (isGitRepo(p)) { directRepos.frontend = { path: p }; logSuccess(`Frontend repo: ${p}`); } }
    if (options.repoMobile) { const p = path.resolve(options.repoMobile); if (isGitRepo(p)) { directRepos.mobile = { path: p }; logSuccess(`Mobile repo: ${p}`); } }
    registeredRepos = directRepos;
    saveConfig({ ...config, repos: directRepos, wizardConfigured: true });
  } else if (options.reconfigure) {
    // Explicit --reconfigure flag: run wizard with context
    console.log('');
    console.log(bold('◆  MakeStudio — Repositórios Locais'));
    console.log(dim('│'));
    console.log(`${dim('│')}  Por padrão o agent clona repos automaticamente via GitHub (auto-clone).`);
    console.log(`${dim('│')}  Se você já tem o projeto clonado localmente, pode informar o path aqui`);
    console.log(`${dim('│')}  para evitar re-clones e usar seu ambiente de desenvolvimento diretamente.`);
    console.log(`${dim('│')}  ${dim('Deixe em branco para manter auto-clone.')}`);
    console.log(dim('│'));
    const { repos } = await runRepoWizard();
    registeredRepos = repos;
    saveConfig({ ...config, repos, wizardConfigured: true, preferredCli: undefined });
    logSuccess('Configuração salva em ~/.makestudio/config.json (CLI será perguntado novamente)');
    console.log('');
  } else if (!config.wizardConfigured) {
    // First run: mark as configured (no wizard) — auto-clone handles everything
    saveConfig({ ...config, wizardConfigured: true });
  }

  // Detect CLIs
  const installedCLIs = detectInstalledCLIs();
  if (installedCLIs.length === 0) {
    logError('Nenhum CLI de IA detectado. Instale: claude, codex ou gemini');
    process.exit(1);
  }

  // Choose CLI — use saved preference, --cli flag, or ask once then save
  let selectedCLI = options.cli
    ? installedCLIs.find(c => c.name === options.cli)
    : undefined;

  if (!selectedCLI) {
    if (installedCLIs.length === 1) {
      selectedCLI = installedCLIs[0];
    } else if (config.preferredCli) {
      // Use saved preference if the CLI is still installed
      const saved = installedCLIs.find(c => c.name === config.preferredCli);
      if (saved) {
        selectedCLI = saved;
        logSuccess(`CLI: ${saved.name} ${saved.version} ${dim('(salvo — use --reconfigure para mudar)')}`);
      }
    }

    if (!selectedCLI) {
      // Ask once and save to config
      console.log('');
      console.log('  CLIs disponíveis:');
      installedCLIs.forEach((cli, i) => {
        console.log(`    ${i + 1}) ${cli.name} (${cli.version})`);
      });
      console.log('');

      const answer = await ask(`  Qual CLI usar? [1-${installedCLIs.length}]: `);
      const idx = parseInt(answer, 10) - 1;
      selectedCLI = (idx >= 0 && idx < installedCLIs.length) ? installedCLIs[idx] : installedCLIs[0];

      // Save preference so we never ask again
      saveConfig({ ...config, preferredCli: selectedCLI.name });
      logSuccess(`CLI ${selectedCLI.name} salvo como padrão (use --reconfigure para mudar)`);
    }
  }

  if (!selectedCLI) {
    logError('CLI não encontrado.');
    process.exit(1);
  }

  if (repoPath) {
    logInfo(`Repo local: ${repoPath}`);
  } else {
    logInfo(`Repos: auto-clone em ~/.makestudio/repos/ (cada projeto clonado automaticamente)`);
  }
  logSuccess(`CLI selecionado: ${selectedCLI.name} ${selectedCLI.version}`);
  logInfo(`Servidor: ${config.serverUrl}`);

  // ── Auto-preparation: ensure project has analysis and boilerplate context ──
  // Runs only when a local repo path is set (not in auto-clone mode)
  if (repoPath) {
    await runProjectPreparation(repoPath, selectedCLI.name);
  }

  const agentId = crypto.randomUUID();
  const hostname = os.hostname();

  // Check for CLI updates
  try {
    const { getApiClient } = await import('../network/api-client');
    const apiClient = getApiClient();
    const { data } = await apiClient.get('/dark-factory/agents/cli-version');
    const currentVersion = '1.0.0';
    if (data.version && data.version !== currentVersion) {
      logWarning(`Nova versão disponível: ${data.version} (atual: ${currentVersion})`);
      logWarning(`Atualize: npm update -g @makestudio/agent`);
      console.log('');
    }
  } catch (err) { swallow(err); }

  // Connect WebSocket
  logInfo('Conectando ao servidor...');

  connectWebSocket(token, {
    onConnect: () => {
      showStatus(true, `${selectedCLI!.name} ${selectedCLI!.version}`, hostname);
      logSuccess('Conectado ao MakeStudio Agent Gateway');

      // Always re-register on (re)connect (include multi-repo config)
      registerAgent({
        agentId,
        hostname,
        availableCLIs: [selectedCLI!.name],
        repoPath: repoPath || '~/.makestudio/repos',
        projectIds: [],
        repos: Object.keys(registeredRepos).length > 0 ? registeredRepos : undefined,
      });

      logInfo(`Todas as tasks serão executadas com ${selectedCLI!.name.toUpperCase()}`);

      if (options.auto) {
        logSuccess('🤖 MODO AUTO-PICK ativado — buscando tasks automaticamente');
        startAutoPickLoop(selectedCLI!.name, repoPath, Object.keys(registeredRepos).length > 0 ? registeredRepos : undefined, options.autoPoll);
      } else {
        logInfo('Aguardando tasks... (Ctrl+C para sair)');
      }

      // Flush offline queue on reconnect
      import('../core/offline-queue').then(({ pendingCount, flushQueue }) => {
        if (pendingCount() > 0) {
          logInfo(`${pendingCount()} item(ns) na fila offline — sincronizando...`);
          flushQueue().catch(() => {});
        }
      }).catch(() => {});
    },

    onDisconnect: (reason) => {
      showStatus(false);
      if (reason === 'io server disconnect') {
        logError('Servidor encerrou a conexão. Verifique sua licença.');
      } else if (reason === 'transport close' || reason === 'ping timeout') {
        logWarning('Conexão perdida — reconectando automaticamente...');
      } else {
        logWarning(`Desconectado: ${reason} — reconectando...`);
      }
    },

    onError: (error) => {
      const msg = error.message || '';
      if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
        logWarning('Sem conexão com o servidor — aguardando rede voltar...');
      } else {
        logError(`Erro: ${msg}`);
      }
    },

    onTaskDispatch: async (task: TaskDispatch) => {
      // Respect the backend's CLI choice when it picked one this agent has
      // installed (smart routing decisions: codex for explore, claude for
      // reasoning, makestudio for self-hosted, etc.). Fall back to the
      // operator-selected CLI only when backend left it unset or chose a
      // CLI that isn't installed here. Previously this line unconditionally
      // overwrote `task.cli`, silently dropping the backend's routing.
      const installedNames = installedCLIs.map((c) => c.name);
      if (!task.cli || !installedNames.includes(task.cli)) {
        task.cli = selectedCLI!.name;
      }
      logTask(task.taskId, `CLI: ${task.cli}`);
      const layerInfo = task.repoLayer ? ` [${task.repoLayer}]` : '';
      logInfo(`Repo: ${task.repoUrl || repoPath || `local${layerInfo}`}`);
      logInfo(`Branch: ${task.taskBranch || 'current'}`);
      logInfo('Executando task individual...');
      await executeTask(task, repoPath, Object.keys(registeredRepos).length > 0 ? registeredRepos : undefined);
    },

    onPipelineDispatch: async (pipeline: PipelineDispatch) => {
      // Respect backend's CLI choice when installed locally; fall back otherwise.
      const installedNames = installedCLIs.map((c) => c.name);
      if (!pipeline.cli || !installedNames.includes(pipeline.cli)) {
        pipeline.cli = selectedCLI!.name;
      }
      logInfo(`\n${'═'.repeat(50)}`);
      logInfo(`PIPELINE: ${pipeline.tasks.length} tasks em UMA sessão`);
      logInfo(`CLI: ${selectedCLI!.name} | Branch: ${pipeline.taskBranch || 'current'}`);
      pipeline.tasks.forEach(t => logInfo(`  ${t.index}. [${t.taskType.toUpperCase()}] ${t.taskTitle}`));
      logInfo(`${'═'.repeat(50)}\n`);
      await executePipeline(pipeline);
    },

    onDecompositionDispatch: async (data: DecompositionDispatch) => {
      // Respect backend's CLI choice when installed locally; fall back otherwise.
      const installedNames = installedCLIs.map((c) => c.name);
      if (!data.cli || !installedNames.includes(data.cli)) {
        data.cli = selectedCLI!.name;
      }
      logInfo(`\n${'═'.repeat(50)}`);
      logInfo(`DECOMPOSIÇÃO: ${data.requirements.length} requisitos → DUMs + tasks`);
      logInfo(`Projeto: ${data.projectName} | CLI: ${data.cli}`);
      logInfo(`${'═'.repeat(50)}\n`);

      // AbortController so onDecompositionCancel can stop runDecompose mid-run.
      // Without this, decomposition burned full budget even after the user
      // cancelled in the frontend (backend emits decomposition:cancel but the
      // agent had no way to interrupt the running runDecompose call).
      const abortCtrl = new AbortController();
      activeDecompositions.set(data.projectId, abortCtrl);

      try {
        const { getApiClient } = await import('../network/api-client');
        const { ensureAuthenticated } = await import('../network/auth');
        await ensureAuthenticated();
        const api = getApiClient();

        // Build workspace from the repo path sent by the server. When the
        // backend doesn't know the local path yet (new project, no analyze
        // run), prefer ~/.makestudio/dums/<projectId>/ over /tmp so a crash
        // doesn't lose the partial work to a /tmp cleanup at next reboot.
        const osLib = require('os') as typeof import('os');
        const pathLib = require('path') as typeof import('path');
        const fallbackPersistent = pathLib.join(osLib.homedir(), '.makestudio', 'dums', data.projectId);
        const effectiveRepoPath = data.repoPath || repoPath || fallbackPersistent;
        const workspace = {
          hasCodebase: !!data.repoPath && data.repoPath !== osLib.tmpdir(),
          repoPath: effectiveRepoPath,
        };
        try {
          const fsLib = require('fs') as typeof import('fs');
          if (!fsLib.existsSync(effectiveRepoPath)) fsLib.mkdirSync(effectiveRepoPath, { recursive: true });
        } catch (err) { swallow(err); }

        // Use the same runDecompose used by `makestudio refine` — quality gates, incremental save, everything
        const requirementIds = data.requirements.map((r: any) => r.id);
        await runDecompose(api, data.projectId, requirementIds, 'Decomposição via WebSocket', data.cli, workspace as any, { signal: abortCtrl.signal } as any);

        if (abortCtrl.signal.aborted) {
          logWarning(`Decomposição cancelada pelo usuário (projectId=${data.projectId})`);
        } else {
          logSuccess(`Decomposição concluída — DUMs salvos diretamente no servidor`);

          // ─── Quality Hold auto-prompt ─────────────────────────────────────
          // Backend ran the quality gate at decomposition-result. If any tasks
          // entered `held` state, surface that here so the user knows the
          // project is BLOCKED from advancing to designer/executor and how to
          // resolve. Best-effort: a failure to fetch the summary doesn't fail
          // the decomposition.
          try {
            const { getApiClient } = await import('../network/api-client');
            const { ensureAuthenticated } = await import('../network/auth');
            await ensureAuthenticated();
            const apiClient = getApiClient();
            const sumRes = await apiClient.get(
              `/dark-factory/projects/${data.projectId}/quality-hold/summary`,
              { timeout: 5_000 },
            );
            const totalHeld = sumRes.data?.totalHeld || 0;
            if (totalHeld > 0) {
              process.stdout.write('\n');
              logWarning(
                `${totalHeld} task(s) bloqueada(s) pelo quality gate (ISO/IEC/IEEE 29148). ` +
                  `Projeto NÃO avança até resolver.`,
              );
              process.stdout.write(
                `  ${'\x1b[2m'}Liste:${'\x1b[0m'}        /quality-hold list\n` +
                  `  ${'\x1b[2m'}Resumo:${'\x1b[0m'}       /quality-hold summary\n` +
                  `  ${'\x1b[2m'}Reanalisar:${'\x1b[0m'}   /quality-hold reanalyze <taskId>\n` +
                  `  ${'\x1b[2m'}Editar:${'\x1b[0m'}       /quality-hold edit <taskId>\n\n`,
              );
            }
          } catch (err) { swallow(err); }
        }
      } catch (err: any) {
        if (abortCtrl.signal.aborted) {
          logWarning(`Decomposição cancelada pelo usuário (projectId=${data.projectId})`);
        } else {
          logError(`Falha na decomposição: ${err.message}`);
          // Notify server so frontend knows decomposition failed (clears stuck "in progress" state)
          try {
            const { getApiClient } = await import('../network/api-client');
            const { ensureAuthenticated } = await import('../network/auth');
            await ensureAuthenticated();
            const apiErr = getApiClient();
            await apiErr.post(`/dark-factory/projects/${data.projectId}/decomposition-failed`, {
              error: err.message?.substring(0, 500) || 'Unknown error',
            });
          } catch (err) { swallow(err); }
        }
      } finally {
        activeDecompositions.delete(data.projectId);
      }
    },

    onDecompositionCancel: (data) => {
      const abortCtrl = activeDecompositions.get(data.projectId);
      if (abortCtrl) {
        logWarning(`Cancelando decomposição (projectId=${data.projectId} — ${data.reason || 'cancelled'})`);
        abortCtrl.abort();
      } else {
        logWarning(`decomposition:cancel para projeto ${data.projectId} mas nenhuma decomp ativa`);
      }
    },

    onBootstrapRepoDispatch: async (data) => {
      const { bootstrapRepoFromBoilerplate } = await import('../core/bootstrap-repo');
      const { emitBootstrapRepoCompleted, emitBootstrapRepoFailed } = await import('../network/ws-client');
      logInfo(`\n${'═'.repeat(50)}`);
      logInfo(`BOOTSTRAP REPO: ${data.owner}/${data.name} from ${data.boilerplateId}`);
      logInfo(`${'═'.repeat(50)}\n`);
      try {
        const result = await bootstrapRepoFromBoilerplate({
          owner: data.owner,
          name: data.name,
          isPrivate: data.private,
          boilerplateId: data.boilerplateId,
          templateRepo: (data as any).templateRepo,
        });
        emitBootstrapRepoCompleted(data.jobId, result.repoUrl, result.branch);
        logSuccess(`Repo criado: ${result.repoUrl}`);
      } catch (err: any) {
        emitBootstrapRepoFailed(data.jobId, err.message || String(err));
        logError(`Bootstrap falhou: ${err.message}`);
      }
    },

    onAnalysisTrigger: async (data: AnalysisTrigger) => {
      const fsSync = require('fs') as typeof import('fs');
      const osLib = require('os') as typeof import('os');
      const pathLib = require('path') as typeof import('path');

      const safeName = (data.projectName || data.projectId || 'project')
        .replace(/[^a-zA-Z0-9-_]/g, '-').substring(0, 30).toLowerCase();
      const shortId = (data.projectId || '').substring(0, 8);
      const defaultDir = pathLib.join(osLib.homedir(), '.makestudio', 'repos', `${safeName}-${shortId}`);

      // If backend already knows the local path, use it directly (no prompt needed)
      let targetPath = data.localPath
        || (repoPath && repoPath !== osLib.tmpdir() ? repoPath : null)
        || null;

      // New project — ask user where to place it
      if (!targetPath) {
        const projectLabel = data.projectName ? `"${data.projectName}"` : `projeto ${data.projectId}`;
        process.stdout.write(`\n`);
        process.stdout.write(`  Novo projeto ${projectLabel} detectado.\n`);
        process.stdout.write(`  Onde criar o repositório local?\n`);
        process.stdout.write(`  [Enter para usar padrão] ${defaultDir}\n`);
        process.stdout.write(`  > `);

        const answer = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
          const timer = setTimeout(() => {
            rl.close();
            resolve('');
          }, 60_000);
          rl.once('line', (line) => {
            clearTimeout(timer);
            rl.close();
            resolve(line.trim());
          });
        });

        // Resolve to absolute path — supports ~, relative paths, plain names
        const raw = answer || defaultDir;
        const expanded = raw.startsWith('~') ? raw.replace('~', osLib.homedir()) : raw;
        // If just a name with no slashes, place inside ~/develop/
        const resolved = expanded.includes(pathLib.sep) || expanded.startsWith('/')
          ? pathLib.resolve(expanded)
          : pathLib.join(osLib.homedir(), 'develop', expanded);
        targetPath = resolved;
        process.stdout.write(`  → ${targetPath}\n`);
      }

      logInfo(`\n${'═'.repeat(50)}`);
      logInfo(`ANÁLISE MAKESTUDIO: projeto ${data.projectId}`);
      logInfo(`Diretório: ${targetPath}`);
      logInfo(`CLI: ${selectedCLI!.name}`);
      logInfo(`${'═'.repeat(50)}\n`);

      // Ensure target directory exists before spawning (new projects have no local dir yet)
      if (!fsSync.existsSync(targetPath)) {
        fsSync.mkdirSync(targetPath, { recursive: true });
      }

      // Spawn as subprocess to avoid process.exit killing the agent
      const args = ['analyze', '--deep', '--cli', selectedCLI!.name, '--project-id', data.projectId];
      args.push('--path', targetPath);

      const child = spawn(process.execPath, [process.argv[1], ...args], {
        stdio: 'inherit',
        cwd: targetPath,
        env: process.env,
      });

      child.on('close', (code) => {
        if (code === 0) {
          logSuccess(`Análise concluída para projeto ${data.projectId}`);
        } else {
          logError(`Análise encerrou com código ${code} para projeto ${data.projectId}`);
        }
      });
    },

    onTaskCancel: (data) => {
      logWarning(`Task cancelada: ${data.taskId} — ${data.reason}`);
      // Kill BOTH single-task and pipeline executors. cancelActiveTask only
      // touches executor.ts (single-task). Without cancelPipeline the agent
      // would silently keep running a multi-task pipeline after the backend
      // marks it cancelled, surfacing task:completed long after the user
      // stopped caring.
      cancelActiveTask();
      try { cancelPipeline(); } catch (err) { swallow(err); }
    },

    onSessionReplaced: (data) => {
      logError(data.message);
      logError('Encerrando agent...');
      disconnectWebSocket();
      process.exit(1);
    },
  });

  // Graceful shutdown
  const shutdown = () => {
    logInfo('Encerrando agent...');
    cancelActiveTask();
    disconnectWebSocket();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive forever
  await new Promise(() => {});
}

// ── Auto-Pick Loop ──────────────────────────────────────────────

let autoPickTimer: ReturnType<typeof setInterval> | null = null;
let autoPickBusy = false;

function startAutoPickLoop(
  cliName: string,
  repoPath: string | undefined,
  registeredRepos: any | undefined,
  pollIntervalSec?: number,
): void {
  const interval = (pollIntervalSec || 30) * 1000;

  // Detect repo URL for matching with backend projects
  let repoUrl: string | undefined;
  if (repoPath) {
    try {
      const { getRepoRemoteUrl } = require('../core/git-ops');
      repoUrl = getRepoRemoteUrl(repoPath) || undefined;
    } catch (err) { swallow(err); }
  }

  logInfo(`🤖 [auto-pick] Polling a cada ${pollIntervalSec || 30}s`);
  if (repoUrl) logInfo(`🤖 [auto-pick] Filtrando por repo: ${repoUrl}`);
  if (repoPath) logInfo(`🤖 [auto-pick] Filtrando por path: ${repoPath}`);

  autoPickTimer = setInterval(async () => {
    if (autoPickBusy) return;
    autoPickBusy = true;

    try {
      const { getApiClient } = await import('../network/api-client');
      const { ensureAuthenticated } = await import('../network/auth');
      await ensureAuthenticated();
      const api = getApiClient();

      // Build query params to filter tasks by repo/path
      const params: Record<string, string> = {};
      if (repoUrl) params.repoUrl = repoUrl;
      else if (repoPath) params.repoPath = repoPath;

      const { data } = await api.get('/dark-factory/agents/auto-pick', { params, timeout: 15_000 });

      if (data.found && data.task) {
        logInfo(`🤖 [auto-pick] Task encontrada: [${data.task.type?.toUpperCase()}] ${data.task.title} (${data.task.projectName})`);
        if (data.pendingCount > 1) {
          logInfo(`🤖 [auto-pick] +${data.pendingCount - 1} task(s) pendente(s) neste projeto`);
        }

        // Claim the task
        const { data: claimResult } = await api.post(`/dark-factory/agents/auto-pick/${data.task.id}/claim`);

        if (claimResult.claimed) {
          logSuccess(`🤖 [auto-pick] Task claimed: ${data.task.title}`);

          // Ask backend to execute the task properly (with full prompt, hooks, etc.)
          // Instead of running locally with a raw description, trigger server-side execution
          try {
            logInfo(`🤖 [auto-pick] Disparando execução no servidor com prompt completo...`);
            await api.post(`/dark-factory/tasks/${data.task.id}/execute`, {
              strategy: 'local',
              mode: 'real',
              cli: cliName,
            });
            logSuccess(`🤖 [auto-pick] Task despachada via servidor (prompt completo + hooks)`);
          } catch (execErr: any) {
            // Fallback: execute locally with description as prompt. The
            // gitToken comes from the auto-pick GET response (backend now
            // includes it from project.metadata). Without it, private
            // repos fail 401 in the fallback while normal dispatch
            // succeeded — exact symptom: timeout on /tasks/:id/execute
            // → fallback → clone returns 401 → task FAILED.
            const gitToken: string | undefined = data.task.gitToken;
            logWarning(`🤖 [auto-pick] Fallback: execução local com prompt básico${gitToken ? '' : ' (sem gitToken — repo privado pode falhar)'}`);
            const task: TaskDispatch = {
              taskId: data.task.id,
              taskTitle: data.task.title,
              taskType: data.task.type,
              prompt: data.task.description || data.task.title,
              cli: cliName,
              repoUrl: data.task.repoUrl || undefined,
              taskBranch: data.task.taskBranch || undefined,
              repoLayer: data.task.repoLayer || undefined,
              gitToken,
            };
            await executeTask(task, repoPath, registeredRepos);
          }
          logSuccess(`🤖 [auto-pick] Task concluída — voltando a polling`);
        } else {
          logWarning(`🤖 [auto-pick] Claim falhou: ${claimResult.reason}`);
        }
      }
      // If no task found, silently continue polling
    } catch (err: any) {
      // Silent on polling errors — don't spam terminal
      if (!err.message?.includes('ECONNREFUSED')) {
        logWarning(`🤖 [auto-pick] Erro: ${err.message?.substring(0, 100)}`);
      }
    } finally {
      autoPickBusy = false;
    }
  }, interval);
}

export function stopAutoPickLoop(): void {
  if (autoPickTimer) {
    clearInterval(autoPickTimer);
    autoPickTimer = null;
    logInfo('🤖 Auto-pick parado');
  }
}
