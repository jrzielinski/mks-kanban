import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as readline from 'readline';
import { execSync, spawn } from 'child_process';
import { isGitRepo, getRepoRemoteUrl, commitAll } from '../core/git-ops';
import { detectInstalledCLIs } from '../core/cli-detector';
import { loadConfig } from '../config/config';
import { logInfo, logSuccess, logError, logWarning } from '../ui/terminal';
import { showBanner } from '../ui/banner';

import { swallow } from '../utils/log';
// ── Known boilerplate URL patterns ────────────────────────────────
const BOILERPLATE_PATTERNS = [
  /boilerplate/i,
  /template/i,
  /starter/i,
  /scaffold/i,
  /skeleton/i,
  /blueprint/i,
];

function isBoilerplateRemote(remoteUrl: string): boolean {
  return BOILERPLATE_PATTERNS.some((p) => p.test(remoteUrl));
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ── ANSI helpers ──────────────────────────────────────────────────
function c(text: string, code: number) { return `\x1b[${code}m${text}\x1b[0m`; }
const bold   = (t: string) => c(t, 1);
const dim    = (t: string) => c(t, 2);
const green  = (t: string) => c(t, 32);
const cyan   = (t: string) => c(t, 36);
const yellow = (t: string) => c(t, 33);
const red    = (t: string) => c(t, 31);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function ghAvailable(): boolean {
  try { execSync('gh --version', { stdio: 'pipe' }); return true; } catch { return false; }
}

function getGithubUser(): string | null {
  try { return execSync('gh api user --jq .login', { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; }
}

function createGithubRepo(owner: string, name: string, priv: boolean, description: string): string | null {
  try {
    const visibility = priv ? '--private' : '--public';
    const desc = description ? `--description "${description.replace(/"/g, '\\"')}"` : '';
    const result = execSync(
      `gh repo create ${owner}/${name} ${visibility} ${desc} --confirm 2>&1 || true`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();

    // gh repo create returns the URL on success
    if (result.includes('github.com')) {
      const match = result.match(/https:\/\/github\.com\/[^\s]+/);
      if (match) return match[0];
    }
    return `https://github.com/${owner}/${name}`;
  } catch (err: any) {
    // May already exist — return URL anyway
    return `https://github.com/${owner}/${name}`;
  }
}

function setRemoteOrigin(repoPath: string, newUrl: string): void {
  try {
    execSync('git remote remove origin', { cwd: repoPath, stdio: 'pipe' });
  } catch (err) { swallow(err); }
  execSync(`git remote add origin ${newUrl}`, { cwd: repoPath, stdio: 'pipe' });
}

function getDefaultBranch(repoPath: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch { return 'main'; }
}

const PASCAL = (s: string) => s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const SCREAMING = (s: string) => s.toUpperCase().replace(/-/g, '_');

function buildAdaptPrompt(projectName: string): string {
  return `You are helping initialize a new software project named "${projectName}" (slug: ${projectName}, PascalCase: ${PASCAL(projectName)}, SCREAMING_SNAKE: ${SCREAMING(projectName)}).

The current directory is a boilerplate/template that needs to be adapted for this project. Perform these changes:

1. Search for boilerplate/template placeholder names in these files:
   - All package.json files (name, description fields)
   - docker-compose.yml / docker-compose.yaml (service names, container_name, volume names, network names)
   - README.md (title, description, badges, installation instructions)
   - Any .env.example files (APP_NAME, SERVICE_NAME, DB_NAME variables)
   - pubspec.yaml (name, description for Flutter)
   - Any other config files that reference the boilerplate name

2. Replace placeholder names with the correct casing:
   - kebab-case slugs → ${projectName}
   - PascalCase → ${PASCAL(projectName)}
   - SCREAMING_SNAKE_CASE → ${SCREAMING(projectName)}

3. After all changes, create a brief CHANGES.md file summarizing what was modified.

Do NOT modify source code logic, only config files, manifests, and documentation.
Work file by file, showing each file as you modify it.`;
}

/**
 * Spawns the AI CLI to adapt the boilerplate. Shows live output with heartbeat.
 * Returns a Promise that resolves when done.
 */
async function runAIAdaptation(repoPath: string, projectName: string, cliName: string): Promise<void> {
  const prompt = buildAdaptPrompt(projectName);

  // Write prompt to temp file to avoid shell length limits
  const promptFile = path.join(os.tmpdir(), `makestudio-init-prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  console.log('');
  logInfo(`Iniciando ${cyan(cliName.toUpperCase())} para adaptar o boilerplate...`);
  logInfo(`Projeto: ${cyan(projectName)} | Dir: ${dim(repoPath)}`);
  console.log('');

  const { command, args } = buildCLIArgs(cliName, promptFile);

  return new Promise<void>((resolve) => {
    const startTime = Date.now();

    // Heartbeat: show elapsed time every 5s so user knows it's alive
    let lastTool = '';
    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const timeStr = min > 0 ? `${min}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
      process.stdout.write(`\r  ${dim('⏳')} ${cyan(cliName.toUpperCase())} rodando... ${dim(timeStr)}${lastTool ? ` | ${dim(lastTool)}` : ''}   `);
    }, 3_000);

    const proc = spawn(command, args, {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Parse stdout — for Claude: stream-json → extract readable lines
    // For Codex/Gemini: plain text, print directly
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();

      if (cliName === 'claude') {
        // Parse Claude stream-json and extract human-readable content
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            // Tool use event
            if (evt.type === 'assistant' && evt.message?.content) {
              for (const block of evt.message.content) {
                if (block.type === 'tool_use') {
                  const toolLabel = block.name === 'str_replace_based_edit_tool'
                    ? `✏  ${block.input?.path || ''}`
                    : block.name === 'read_file' ? `📖 ${block.input?.path || ''}`
                    : block.name === 'list_directory' ? `📂 ${block.input?.path || ''}`
                    : block.name;
                  lastTool = toolLabel;
                  // Print on new line to not mess with heartbeat
                  process.stdout.write(`\r  ${green('→')} ${toolLabel.substring(0, 80)}\n`);
                } else if (block.type === 'text' && block.text?.trim()) {
                  const txt = block.text.trim().substring(0, 120);
                  process.stdout.write(`\r  ${dim('·')} ${dim(txt)}\n`);
                }
              }
            }
            // Result event — final message
            if (evt.type === 'result' && evt.result) {
              process.stdout.write(`\r  ${green('✓')} ${evt.result.substring(0, 100)}\n`);
            }
          } catch {
            // Not JSON — print raw (Codex/Gemini plain text)
            const trimmed = text.trim();
            if (trimmed) process.stdout.write(`\r  ${dim(trimmed.substring(0, 120))}\n`);
          }
        }
      } else {
        // Codex/Gemini: print raw output line by line
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) process.stdout.write(`\r  ${dim(trimmed.substring(0, 120))}\n`);
        }
      }
    });

    // stderr — always print (errors, progress messages from CLI)
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) process.stdout.write(`\r  ${yellow('!')} ${dim(trimmed.substring(0, 120))}\n`);
      }
    });

    proc.on('close', (code) => {
      clearInterval(heartbeat);
      // Clean up temp prompt file
      try { fs.unlinkSync(promptFile); } catch (err) { swallow(err); }

      process.stdout.write('\n');
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      if (code === 0 || code === null) {
        logSuccess(`${cliName.toUpperCase()} concluiu em ${elapsed}s`);
      } else {
        logWarning(`${cliName.toUpperCase()} encerrou com código ${code} em ${elapsed}s`);
      }
      resolve();
    });

    proc.on('error', (err) => {
      clearInterval(heartbeat);
      try { fs.unlinkSync(promptFile); } catch (err) { swallow(err); }
      logError(`Falha ao iniciar ${cliName}: ${err.message}`);
      resolve(); // Don't block init on AI failure
    });
  });
}

function buildCLIArgs(cli: string, promptFile: string): { command: string; args: string[] } {
  switch (cli) {
    case 'claude':
      // -p with stream-json so we can parse tool calls for live progress
      return {
        command: 'claude',
        args: ['-p', fs.readFileSync(promptFile, 'utf8'), '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      };
    case 'codex':
      return { command: 'codex', args: ['exec', '--full-auto', fs.readFileSync(promptFile, 'utf8')] };
    case 'gemini':
      return { command: 'gemini', args: ['-y', fs.readFileSync(promptFile, 'utf8')] };
    default:
      return { command: cli, args: [fs.readFileSync(promptFile, 'utf8')] };
  }
}

// ── Main init command ─────────────────────────────────────────────

export async function initCommand(options: {
  path?: string;
  cli?: string;
  yes?: boolean;
}): Promise<void> {
  if (!process.env.MAKESTUDIO_REPL) showBanner();

  const targetPath = options.path ? path.resolve(options.path) : process.cwd();

  if (!isGitRepo(targetPath)) {
    logError('Diretório não é um repositório Git.');
    logInfo('Execute: git init && git add -A && git commit -m "init"');
    process.exit(1);
  }

  const remoteUrl = getRepoRemoteUrl(targetPath);
  const dirName = path.basename(targetPath);

  console.log('');
  console.log(bold('◆  MakeStudio Init — Configurar Novo Projeto'));
  console.log(dim('│'));
  console.log(`${dim('│')}  Diretório: ${cyan(targetPath)}`);

  if (remoteUrl) {
    console.log(`${dim('│')}  Remote atual: ${dim(remoteUrl)}`);

    if (isBoilerplateRemote(remoteUrl)) {
      console.log(dim('│'));
      console.log(`${dim('│')}  ${yellow('⚠')}  ${yellow('Remote aponta para um boilerplate/template.')}`);
      console.log(`${dim('│')}  ${dim('Vamos criar um novo repositório GitHub para este projeto.')}`);
    }
  } else {
    console.log(`${dim('│')}  ${dim('Sem remote configurado.')}`);
  }

  console.log(dim('│'));

  // ── Gather project info ───────────────────────────────────────

  // Project name
  const defaultName = slugify(dirName);
  const nameInput = options.yes ? defaultName : await ask(`${dim('◆')}  Nome do projeto ${dim(`[${defaultName}]`)}: `);
  const projectName = nameInput || defaultName;
  console.log(dim('│'));

  // GitHub owner
  const detectedUser = ghAvailable() ? getGithubUser() : null;
  const ownerDefault = detectedUser || 'minha-org';
  const ownerInput = options.yes ? ownerDefault : await ask(`${dim('◆')}  GitHub owner (usuário ou org) ${dim(`[${ownerDefault}]`)}: `);
  const owner = ownerInput || ownerDefault;
  console.log(dim('│'));

  // Repo name
  const repoDefault = projectName;
  const repoInput = options.yes ? repoDefault : await ask(`${dim('◆')}  Nome do repo no GitHub ${dim(`[${repoDefault}]`)}: `);
  const repoName = repoInput || repoDefault;
  console.log(dim('│'));

  // Visibility
  const visibilityInput = options.yes ? 'privado' : await ask(`${dim('◆')}  Visibilidade ${dim('[privado]')}: ${dim('privado/publico')}: `);
  const isPrivate = !visibilityInput.toLowerCase().startsWith('pub');
  console.log(`${dim('│')}  ${dim(`→ Repositório ${isPrivate ? 'privado' : 'público'}`)}`);
  console.log(dim('│'));

  // Description
  const descInput = options.yes ? '' : await ask(`${dim('◆')}  Descrição ${dim('[opcional]')}: `);
  console.log(dim('│'));

  // AI adaptation — ask if wanted, then which CLI
  let doAIAdaptation = false;
  let selectedAdaptCLI: string | undefined = options.cli;

  if (!options.yes) {
    const installedCLIs = detectInstalledCLIs();
    if (installedCLIs.length > 0) {
      const aiAnswer = await ask(`${dim('◆')}  Adaptar boilerplate com IA (renomear configs, package.json, README)? ${dim('[s/N]')}: `);
      doAIAdaptation = aiAnswer.toLowerCase() === 's' || aiAnswer.toLowerCase() === 'sim';
      console.log(dim('│'));

      if (doAIAdaptation && !selectedAdaptCLI) {
        if (installedCLIs.length === 1) {
          selectedAdaptCLI = installedCLIs[0].name;
          console.log(`${dim('│')}  ${dim(`→ Usando ${installedCLIs[0].name} ${installedCLIs[0].version}`)}`);
        } else {
          console.log(`${dim('│')}  CLIs disponíveis:`);
          installedCLIs.forEach((cli, i) => {
            console.log(`${dim('│')}    ${dim(`${i + 1})`)} ${cyan(cli.name)} ${dim(cli.version)}`);
          });
          const cliAnswer = await ask(`${dim('◆')}  Qual CLI usar? ${dim(`[1-${installedCLIs.length}]`)}: `);
          const idx = parseInt(cliAnswer, 10) - 1;
          selectedAdaptCLI = (idx >= 0 && idx < installedCLIs.length)
            ? installedCLIs[idx].name
            : installedCLIs[0].name;
        }
        console.log(dim('│'));
      }
    } else {
      console.log(`${dim('│')}  ${yellow('⚠')}  ${dim('Nenhum CLI de IA detectado. Adaptação não disponível.')}`);
      console.log(dim('│'));
    }
  }

  // ── Summary ───────────────────────────────────────────────────

  const newRepoUrl = `https://github.com/${owner}/${repoName}`;
  const currentBranch = getDefaultBranch(targetPath);

  console.log(`${dim('│')}  ${bold('Resumo:')}`);
  console.log(`${dim('│')}    Projeto:   ${cyan(projectName)}`);
  console.log(`${dim('│')}    Repo:      ${cyan(newRepoUrl)}`);
  console.log(`${dim('│')}    Branch:    ${cyan(currentBranch)}`);
  console.log(`${dim('│')}    Remote:    ${dim(remoteUrl || 'nenhum')} → ${green(newRepoUrl)}`);
  if (doAIAdaptation && selectedAdaptCLI) {
    console.log(`${dim('│')}    Adaptação: ${cyan('sim')} via ${cyan(selectedAdaptCLI.toUpperCase())} (renomear configs)`);
  }
  console.log(dim('│'));

  if (!options.yes) {
    const confirm = await ask(`  Prosseguir? [S/n]: `);
    if (confirm.toLowerCase() === 'n' || confirm.toLowerCase() === 'nao' || confirm.toLowerCase() === 'não') {
      logWarning('Operação cancelada.');
      return;
    }
  }

  console.log('');

  // ── AI adaptation (before creating remote, so we commit the changes) ──

  if (doAIAdaptation && selectedAdaptCLI) {
    if (selectedAdaptCLI) {
      await runAIAdaptation(targetPath, projectName, selectedAdaptCLI);

      // Commit the AI's changes
      try {
        const commits = commitAll(targetPath, `init: adapt boilerplate for ${projectName}`);
        if (commits > 0) {
          logSuccess(`Alterações da IA commitadas (${commits} commit)`);
        }
      } catch (err) { swallow(err); }
    }
  }

  // ── Create GitHub repo ────────────────────────────────────────

  if (!ghAvailable()) {
    console.log('');
    logWarning('CLI `gh` não encontrado. Pulando criação automática do repo.');
    logInfo('Instale: brew install gh && gh auth login');
    logInfo(`Crie manualmente: https://github.com/new`);
    logInfo(`Depois execute:`);
    console.log(`    git remote set-url origin ${newRepoUrl}`);
    console.log(`    git push -u origin ${currentBranch}`);
  } else {
    logInfo(`Criando repo ${owner}/${repoName} no GitHub...`);
    const createdUrl = createGithubRepo(owner, repoName, isPrivate, descInput);

    if (createdUrl) {
      logSuccess(`Repositório criado: ${createdUrl}`);
    } else {
      logWarning('Não foi possível confirmar criação — prosseguindo com update do remote');
    }

    // ── Update remote ─────────────────────────────────────────

    logInfo('Atualizando remote origin...');
    try {
      setRemoteOrigin(targetPath, newRepoUrl);
      logSuccess(`Remote origin → ${newRepoUrl}`);
    } catch (err: any) {
      logError(`Falha ao atualizar remote: ${err.message}`);
      process.exit(1);
    }

    // ── Push ──────────────────────────────────────────────────

    logInfo(`Push ${currentBranch} → origin...`);
    try {
      execSync(`git push -u origin ${currentBranch}`, {
        cwd: targetPath,
        stdio: 'inherit',
        timeout: 60_000,
      });
      logSuccess(`Push concluído: origin/${currentBranch}`);
    } catch (err: any) {
      logWarning(`Push falhou: ${err.message}`);
      logInfo('Execute manualmente: git push -u origin ' + currentBranch);
    }
  }

  // ── Done ──────────────────────────────────────────────────────

  console.log('');
  console.log(bold(green('✓  Projeto inicializado com sucesso!')));
  console.log('');
  console.log(`  Próximos passos:`);
  console.log(`    ${dim('1.')} Configure o projeto no MakeStudio (URL: ${cyan(newRepoUrl)})`);
  console.log(`    ${dim('2.')} Execute ${cyan('makestudio start')} para conectar o agent`);
  console.log('');
}
