import { swallow } from '../utils/log';
/**
 * workspace-resolver.ts
 *
 * Resolves where the project lives on the filesystem.
 * Handles: local path, git clone, or skip (no codebase access).
 * Creates a working branch for decomposition.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { execSync } from 'child_process';
import {
  isGitRepo,
  getCurrentBranch,
  checkoutBranch,
  fetchOrigin,
} from './git-ops';
import { logInfo, logSuccess, logError, logWarning } from '../ui/terminal';
import chalk from 'chalk';

export interface WorkspaceResolution {
  repoPath: string;
  wasCloned: boolean;
  originalBranch: string | null;
  workingBranch: string;
  hasCodebase: boolean;
}

export interface WorkspaceOptions {
  projectId: string;
  projectName: string;
  repoUrl?: string;
  repoBranch?: string;
  localPath?: string;
  repoOverride?: string; // --repo flag
}

const dim = chalk.hex('#64748B');
const cyan = chalk.hex('#22D3EE');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

/**
 * Pure: extract the lowercase repository name from a URL like
 * "https://github.com/user/bingo-mania.git" → "bingo-mania". Returns an
 * empty string when no URL is given or when no match is found.
 */
export function extractRepoName(repoUrl?: string): string {
  if (!repoUrl) return '';
  const match = repoUrl.match(/\/([^/]+?)(?:\.git)?$/);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Pure: normalise a free-form project name into lowercase tokens of length
 * >= 3 so autoDetectProjectPath can compare against folder names.
 * e.g. "Bingo Mania - 75 e 90" → ["bingo", "mania"].
 */
export function tokenizeProjectName(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Pure: decide whether the intersection between `nameTokens` and the
 * lowercased folder name entry is significant enough to count as a
 * candidate, and compute a score. Callers add a git-repo bonus elsewhere.
 *
 * Returns null when the match is too weak to keep.
 */
export function scoreFolderNameMatch(
  entryLower: string,
  nameTokens: string[],
): number | null {
  const matched = nameTokens.filter((t) => entryLower.includes(t));
  if (matched.length >= 2 || (matched.length === 1 && nameTokens.length === 1)) {
    return matched.length * 10;
  }
  return null;
}

/**
 * Search common dev directories for a folder matching the project name or repo URL.
 */
function autoDetectProjectPath(projectName: string, repoUrl?: string): string | null {
  const home = os.homedir();
  const searchDirs = [
    path.join(home, 'develop'),
    path.join(home, 'projects'),
    path.join(home, 'repos'),
    path.join(home, 'src'),
    path.join(home, 'workspace'),
    path.join(home, 'code'),
    path.join(home, 'dev'),
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    home,
  ];

  // Extract repo name from URL (e.g., "https://github.com/user/bingo-mania.git" → "bingo-mania")
  let repoName = '';
  if (repoUrl) {
    const match = repoUrl.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) repoName = match[1].toLowerCase();
  }

  // Normalize project name for matching (e.g., "Bingo Mania - 75 e 90" → ["bingo", "mania"])
  const nameTokens = projectName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 2);

  const candidates: Array<{ path: string; score: number }> = [];

  for (const searchDir of searchDirs) {
    if (!fs.existsSync(searchDir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(searchDir);
    } catch { continue; }

    for (const entry of entries) {
      const fullPath = path.join(searchDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) continue;
      } catch { continue; }

      const entryLower = entry.toLowerCase();

      // Check if it's the exact repo name
      if (repoName && entryLower === repoName && isGitRepo(fullPath)) {
        // Check remote URL matches
        try {
          const remoteUrl = execSync('git remote get-url origin', { cwd: fullPath, stdio: 'pipe' }).toString().trim();
          if (repoUrl && remoteUrl.includes(repoName)) {
            return fullPath; // Exact match by remote URL
          }
        } catch (err) { swallow(err); }
        candidates.push({ path: fullPath, score: 100 });
        continue;
      }

      // Score by how many project name tokens match the folder name
      const matchedTokens = nameTokens.filter(t => entryLower.includes(t));
      if (matchedTokens.length >= 2 || (matchedTokens.length === 1 && nameTokens.length === 1)) {
        const score = matchedTokens.length * 10 + (isGitRepo(fullPath) ? 50 : 0);
        candidates.push({ path: fullPath, score });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Return highest scoring candidate
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].path;
}

/**
 * Ask the user where the project is and prepare the workspace.
 */
export async function askProjectLocation(options: WorkspaceOptions): Promise<WorkspaceResolution> {
  const shortId = options.projectId.substring(0, 8);

  // If --repo flag was provided, use it directly
  if (options.repoOverride) {
    return setupLocalRepo(options.repoOverride, shortId);
  }

  // 1. If we have a saved localPath, verify it still exists
  if (options.localPath && fs.existsSync(options.localPath) && isGitRepo(options.localPath)) {
    console.log(`${dim('│')}  ${green('✓')} Projeto encontrado: ${dim(options.localPath)}`);
    const useIt = await ask(`${dim('│')}  Usar este diretório? [S/n]: `);
    if (!useIt || useIt.match(/^[sS]$/)) {
      return setupLocalRepo(options.localPath, shortId);
    }
  }

  // 2. Auto-detect: search common dev directories
  console.log(`${dim('│')}  ${dim('Procurando projeto no sistema...')}`);
  const detected = autoDetectProjectPath(options.projectName, options.repoUrl);

  if (detected) {
    console.log(`${dim('│')}  ${green('✓')} Encontrado: ${cyan(detected)}`);
    const useIt = await ask(`${dim('│')}  Usar este diretório? [S/n]: `);
    if (!useIt || useIt.match(/^[sS]$/)) {
      return setupLocalRepo(detected, shortId);
    }
  }

  // 3. If repoUrl exists, offer to clone automatically
  if (options.repoUrl) {
    console.log(`${dim('│')}`);
    console.log(`${dim('│')}  Repositório configurado: ${cyan(options.repoUrl)}`);
    const cloneIt = await ask(`${dim('│')}  Clonar automaticamente? [S/n]: `);
    if (!cloneIt || cloneIt.match(/^[sS]$/)) {
      return cloneAndSetup(options.repoUrl, options.repoBranch, options.projectName, shortId);
    }
  }

  // 4. Interactive menu (fallback)
  console.log(`${dim('│')}`);
  console.log(`${dim('│')}  Onde está o projeto ${cyan(options.projectName)}?`);
  console.log(`${dim('│')}    ${cyan('1)')} Criar novo repositório local ${dim('(projeto novo)')}`);
  console.log(`${dim('│')}    ${cyan('2)')} Informar caminho manualmente`);
  console.log(`${dim('│')}    ${cyan('0)')} Pular ${dim('(sem acesso ao codebase)')}`);
  console.log(`${dim('│')}`);

  const choice = await ask(`${dim('│')}  Opção: `);

  if (choice === '1') {
    return scaffoldNewRepo(options.projectName, shortId);
  }

  if (choice === '2') {
    const defaultPath = process.cwd();
    const pathInput = await ask(`${dim('│')}  Caminho ${dim(`[${defaultPath}]`)}: `);
    const repoPath = pathInput || defaultPath;

    if (!fs.existsSync(repoPath)) {
      console.log(`${dim('│')}  ${yellow('⚠')} Diretório não encontrado. Continuando sem codebase.`);
      return noCodebase();
    }

    return setupLocalRepo(repoPath, shortId);
  }

  return noCodebase();
}

/**
 * Setup a local repository: fetch, create working branch.
 */
async function setupLocalRepo(repoPath: string, shortId: string): Promise<WorkspaceResolution> {
  const workingBranch = `darkfactory/decompose-${shortId}`;

  if (!isGitRepo(repoPath)) {
    logWarning(`${repoPath} não é um repositório git. Usando sem branch.`);
    return {
      repoPath,
      wasCloned: false,
      originalBranch: null,
      workingBranch: '',
      hasCodebase: true,
    };
  }

  const originalBranch = getCurrentBranch(repoPath);

  try {
    fetchOrigin(repoPath);
  } catch {
    // Non-fatal — may not have remote
  }

  try {
    checkoutBranch(repoPath, workingBranch, true);
    logSuccess(`Branch criada: ${workingBranch}`);
  } catch {
    // Branch may already exist
    try {
      checkoutBranch(repoPath, workingBranch, false);
    } catch {
      logWarning(`Não foi possível criar branch. Usando ${originalBranch}.`);
      return {
        repoPath,
        wasCloned: false,
        originalBranch,
        workingBranch: originalBranch || '',
        hasCodebase: true,
      };
    }
  }

  return {
    repoPath,
    wasCloned: false,
    originalBranch,
    workingBranch,
    hasCodebase: true,
  };
}

/**
 * Clone a repository and setup workspace.
 */
async function cloneAndSetup(
  repoUrl: string,
  repoBranch: string | undefined,
  projectName: string,
  shortId: string,
): Promise<WorkspaceResolution> {
  const safeName = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').substring(0, 30);
  const targetDir = path.join(os.homedir(), '.makestudio', 'repos', `${safeName}-${shortId}`);

  if (fs.existsSync(targetDir) && isGitRepo(targetDir)) {
    logInfo(`Repo já clonado: ${targetDir}`);
    return setupLocalRepo(targetDir, shortId);
  }

  logInfo(`Clonando ${repoUrl}...`);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  try {
    const branchArg = repoBranch ? `--branch ${repoBranch}` : '';
    execSync(`git clone --depth 10 ${branchArg} ${repoUrl} ${targetDir}`, {
      stdio: 'pipe',
      timeout: 120_000,
    });
    logSuccess(`Clonado em ${targetDir}`);
  } catch (err: any) {
    logError(`Falha ao clonar: ${err.message}`);
    return noCodebase();
  }

  const resolution = await setupLocalRepo(targetDir, shortId);
  resolution.wasCloned = true;
  return resolution;
}

/**
 * Scaffold a brand-new local git repo for a project that has no codebase yet.
 * Creates ~/.makestudio/repos/{projectName}-{shortId}/ with git init + initial commit.
 */
async function scaffoldNewRepo(projectName: string, shortId: string): Promise<WorkspaceResolution> {
  const safeName = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').substring(0, 30).toLowerCase();
  const targetDir = path.join(os.homedir(), '.makestudio', 'repos', `${safeName}-${shortId}`);

  fs.mkdirSync(targetDir, { recursive: true });
  logInfo(`Criando repositório em ${targetDir}...`);

  try {
    execSync('git init -b main', { cwd: targetDir, stdio: 'pipe' });
  } catch {
    execSync('git init', { cwd: targetDir, stdio: 'pipe' });
    try { execSync('git checkout -b main', { cwd: targetDir, stdio: 'pipe' }); } catch (err) { swallow(err); }
  }

  try {
    execSync('git config user.email "agent@makestudio.local"', { cwd: targetDir, stdio: 'pipe' });
    execSync('git config user.name "MakeStudio Agent"', { cwd: targetDir, stdio: 'pipe' });
  } catch (err) { swallow(err); }

  fs.writeFileSync(
    path.join(targetDir, 'README.md'),
    `# ${projectName}\n\nProject scaffolded by MakeStudio.\n`,
  );
  fs.mkdirSync(path.join(targetDir, '.darkfactory'), { recursive: true });

  try {
    execSync('git add .', { cwd: targetDir, stdio: 'pipe' });
    execSync('git commit -m "init: MakeStudio project scaffold"', { cwd: targetDir, stdio: 'pipe' });
  } catch (err) { swallow(err); }

  logSuccess(`Novo repositório criado: ${targetDir}`);
  return {
    repoPath: targetDir,
    wasCloned: false,
    originalBranch: 'main',
    workingBranch: 'main',
    hasCodebase: true,
  };
}

/**
 * No codebase access — use /tmp.
 */
function noCodebase(): WorkspaceResolution {
  return {
    repoPath: os.tmpdir(),
    wasCloned: false,
    originalBranch: null,
    workingBranch: '',
    hasCodebase: false,
  };
}

/**
 * Cleanup: go back to original branch.
 */
export function cleanupWorkspace(resolution: WorkspaceResolution): void {
  if (!resolution.originalBranch || !resolution.hasCodebase) return;
  if (resolution.repoPath === os.tmpdir()) return;

  try {
    checkoutBranch(resolution.repoPath, resolution.originalBranch, false);
    logInfo(`Branch restaurada: ${resolution.originalBranch}`);
  } catch {
    // Non-fatal
  }
}
