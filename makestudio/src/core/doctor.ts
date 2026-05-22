import { swallow } from '../utils/log';
/**
 * doctor.ts
 *
 * Runtime smoke test with autonomous fix loop.
 *
 * Detects project stacks (api/web/mobile), runs verification per stack in parallel,
 * captures failures, and invokes a local CLI to auto-fix. Retries up to maxPasses.
 *
 * Used both standalone (`makestudio doctor`) and as the final phase of `makestudio execute`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import chalk from 'chalk';
import { getCLICommand } from './cli-detector';

const dim = chalk.hex('#64748B');
const cyan = chalk.hex('#22D3EE');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red = chalk.hex('#EF4444');
const bold = chalk.bold;

// ── Types ────────────────────────────────────────────────────────

export type StackType = 'api' | 'web' | 'mobile';

export interface StackInfo {
  type: StackType;
  label: string;
  dir: string; // absolute path to the stack root
  framework?: string; // nestjs, react, vite, flutter, etc
}

export interface DoctorCheckResult {
  stack: StackInfo;
  phase: string; // 'compose', 'install', 'build', 'start', 'health', 'analyze'
  success: boolean;
  errors: string; // captured stderr/stdout on failure
  durationMs: number;
}

export interface DoctorOptions {
  repoPath: string;
  cli: string; // claude/codex/gemini
  deep?: boolean; // include flutter build apk
  maxPasses?: number; // default 3
  skipFix?: boolean; // run checks only, no auto-fix
}

export interface DoctorReport {
  passed: boolean;
  passes: number;
  stacks: StackInfo[];
  finalResults: DoctorCheckResult[];
}

// ── Stack detection ──────────────────────────────────────────────

export function detectStacks(repoPath: string): StackInfo[] {
  const stacks: StackInfo[] = [];

  // API candidates
  const apiDirs = ['api', 'server', 'backend'];
  for (const dir of apiDirs) {
    const pkgPath = path.join(repoPath, dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const framework = deps['@nestjs/core'] ? 'nestjs'
          : deps['express'] ? 'express'
          : deps['fastify'] ? 'fastify'
          : 'node';
        stacks.push({ type: 'api', label: `API (${framework})`, dir: path.join(repoPath, dir), framework });
        break;
      } catch (err) { swallow(err); }
    }
  }
  // Root package.json as API fallback (if no subdir API but root has nestjs/express)
  if (!stacks.some(s => s.type === 'api')) {
    const rootPkg = path.join(repoPath, 'package.json');
    if (fs.existsSync(rootPkg)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(rootPkg, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps['@nestjs/core'] || deps['express'] || deps['fastify']) {
          const framework = deps['@nestjs/core'] ? 'nestjs' : deps['express'] ? 'express' : 'fastify';
          stacks.push({ type: 'api', label: `API (${framework})`, dir: repoPath, framework });
        }
      } catch (err) { swallow(err); }
    }
  }

  // WEB candidates
  const webDirs = ['web', 'frontend', 'client'];
  for (const dir of webDirs) {
    const pkgPath = path.join(repoPath, dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const framework = deps['next'] ? 'next'
          : deps['vite'] ? 'vite+react'
          : deps['react'] ? 'react'
          : deps['vue'] ? 'vue'
          : 'web';
        stacks.push({ type: 'web', label: `WEB (${framework})`, dir: path.join(repoPath, dir), framework });
        break;
      } catch (err) { swallow(err); }
    }
  }

  // MOBILE candidates
  const mobileDirs = ['app', 'mobile', 'flutter'];
  for (const dir of mobileDirs) {
    const pubspec = path.join(repoPath, dir, 'pubspec.yaml');
    if (fs.existsSync(pubspec)) {
      stacks.push({ type: 'mobile', label: `MOBILE (flutter)`, dir: path.join(repoPath, dir), framework: 'flutter' });
      break;
    }
  }
  // Root pubspec.yaml as fallback
  if (!stacks.some(s => s.type === 'mobile')) {
    if (fs.existsSync(path.join(repoPath, 'pubspec.yaml'))) {
      stacks.push({ type: 'mobile', label: `MOBILE (flutter)`, dir: repoPath, framework: 'flutter' });
    }
  }

  return stacks;
}

// ── Shell helper with timeout ────────────────────────────────────

function shellRun(cmd: string, cwd: string, timeoutMs = 60_000): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { cwd, timeout: timeoutMs, shell: '/bin/sh', stdio: 'pipe' }).toString();
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return {
      code: e.status || 1,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || e.message || '').toString(),
    };
  }
}

// ── API doctor ───────────────────────────────────────────────────

async function checkApi(stack: StackInfo): Promise<DoctorCheckResult> {
  const started = Date.now();
  const mkResult = (phase: string, success: boolean, errors: string): DoctorCheckResult => ({
    stack,
    phase,
    success,
    errors,
    durationMs: Date.now() - started,
  });

  // 1. Ensure node_modules exists
  if (!fs.existsSync(path.join(stack.dir, 'node_modules'))) {
    console.log(`${dim('  [API]')} ${dim('npm install...')}`);
    const install = shellRun('npm install --prefer-offline --no-audit --no-fund', stack.dir, 180_000);
    if (install.code !== 0) return mkResult('install', false, install.stderr || install.stdout);
  }

  // 2. docker compose up -d if present
  const composeFile = fs.existsSync(path.join(stack.dir, 'docker-compose.yml'))
    ? path.join(stack.dir, 'docker-compose.yml')
    : fs.existsSync(path.join(path.dirname(stack.dir), 'docker-compose.yml'))
      ? path.join(path.dirname(stack.dir), 'docker-compose.yml')
      : null;

  if (composeFile) {
    console.log(`${dim('  [API]')} ${dim('docker compose up -d...')}`);
    const compose = shellRun(`docker compose -f "${composeFile}" up -d`, stack.dir, 120_000);
    if (compose.code !== 0) {
      // Not fatal — user may have services running differently. Log but continue.
      console.log(`${dim('  [API]')} ${yellow('⚠')} ${dim(`docker compose falhou (ignorando): ${compose.stderr.split('\n')[0]}`)}`);
    } else {
      // Wait a bit for postgres to accept connections
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // 3. Start the app in background, wait for "ready" signal
  console.log(`${dim('  [API]')} ${dim('iniciando aplicação (up to 90s)...')}`);
  const startResult = await startBackendAndWait(stack);
  return mkResult(startResult.phase, startResult.success, startResult.errors);
}

async function startBackendAndWait(stack: StackInfo): Promise<{ phase: string; success: boolean; errors: string }> {
  return new Promise((resolve) => {
    // Detect start script — prefer start:dev, then start
    let startScript = 'start';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(stack.dir, 'package.json'), 'utf8'));
      if (pkg.scripts?.['start:swc']) startScript = 'start:swc';
      else if (pkg.scripts?.['start:dev']) startScript = 'start:dev';
      else if (pkg.scripts?.['dev']) startScript = 'dev';
      else if (pkg.scripts?.['start']) startScript = 'start';
    } catch (err) { swallow(err); }

    const READY_PATTERNS = [
      /nest application successfully started/i,
      /listening on (port )?\d+/i,
      /server (is )?running/i,
      /ready on http/i,
      /started on port/i,
    ];
    const ERROR_PATTERNS = [
      /application failed to start/i,
      /error\s+\[bootstrap\]/i,
      /unhandledpromiserejection/i,
      /cannot find module/i,
      /is not a function/i,
      /is not supported by/i,
    ];

    const proc = spawn('npm', ['run', startScript], {
      cwd: stack.dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development' },
    });

    let outputBuffer = '';
    let errorBuffer = '';
    let resolved = false;

    const cleanup = () => {
      try { proc.kill('SIGKILL'); } catch (err) { swallow(err); }
    };

    const finish = (phase: string, success: boolean, errors: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ phase, success, errors });
    };

    proc.stdout?.on('data', (buf: Buffer) => {
      const chunk = buf.toString();
      outputBuffer += chunk;
      // Detect ready
      if (READY_PATTERNS.some(p => p.test(chunk))) {
        finish('start', true, '');
        return;
      }
      // Detect error
      if (ERROR_PATTERNS.some(p => p.test(chunk))) {
        finish('start', false, outputBuffer.slice(-4000));
      }
    });
    proc.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString();
      errorBuffer += chunk;
      outputBuffer += chunk;
      if (ERROR_PATTERNS.some(p => p.test(chunk))) {
        finish('start', false, (errorBuffer + '\n' + outputBuffer).slice(-4000));
      }
    });
    proc.on('exit', (code) => {
      if (resolved) return;
      if (code === 0) finish('start', true, '');
      else finish('start', false, (errorBuffer + '\n' + outputBuffer).slice(-4000));
    });

    // 90s hard timeout
    setTimeout(() => {
      if (resolved) return;
      // If we saw no "ready" and no error, assume the app is hung
      finish('start', false, `Timeout após 90s sem sinal de ready.\n${outputBuffer.slice(-3000)}`);
    }, 90_000);
  });
}

// ── WEB doctor ───────────────────────────────────────────────────

async function checkWeb(stack: StackInfo): Promise<DoctorCheckResult> {
  const started = Date.now();
  const mkResult = (phase: string, success: boolean, errors: string): DoctorCheckResult => ({
    stack,
    phase,
    success,
    errors,
    durationMs: Date.now() - started,
  });

  if (!fs.existsSync(path.join(stack.dir, 'node_modules'))) {
    console.log(`${dim('  [WEB]')} ${dim('npm install...')}`);
    const install = shellRun('npm install --prefer-offline --no-audit --no-fund', stack.dir, 180_000);
    if (install.code !== 0) return mkResult('install', false, install.stderr || install.stdout);
  }

  console.log(`${dim('  [WEB]')} ${dim('npm run build...')}`);
  const build = shellRun('npm run build 2>&1', stack.dir, 240_000);
  if (build.code !== 0) {
    return mkResult('build', false, (build.stderr + '\n' + build.stdout).slice(-4000));
  }
  return mkResult('build', true, '');
}

// ── MOBILE doctor ────────────────────────────────────────────────

async function checkMobile(stack: StackInfo, deep: boolean): Promise<DoctorCheckResult> {
  const started = Date.now();
  const mkResult = (phase: string, success: boolean, errors: string): DoctorCheckResult => ({
    stack,
    phase,
    success,
    errors,
    durationMs: Date.now() - started,
  });

  console.log(`${dim('  [MOBILE]')} ${dim('fvm flutter pub get...')}`);
  const pubGet = shellRun('fvm flutter pub get', stack.dir, 120_000);
  if (pubGet.code !== 0) {
    return mkResult('pub-get', false, (pubGet.stderr + '\n' + pubGet.stdout).slice(-4000));
  }

  console.log(`${dim('  [MOBILE]')} ${dim('fvm flutter analyze...')}`);
  const analyze = shellRun('fvm flutter analyze --no-fatal-infos 2>&1', stack.dir, 90_000);
  if (analyze.code !== 0) {
    return mkResult('analyze', false, analyze.stdout.slice(-4000));
  }

  if (deep) {
    console.log(`${dim('  [MOBILE]')} ${dim('fvm flutter build apk --debug (pode levar 2-5min)...')}`);
    const build = shellRun('fvm flutter build apk --debug 2>&1', stack.dir, 600_000);
    if (build.code !== 0) {
      return mkResult('build', false, build.stdout.slice(-4000));
    }
  }

  return mkResult(deep ? 'build' : 'analyze', true, '');
}

// ── Auto-fix loop ────────────────────────────────────────────────

async function autoFix(result: DoctorCheckResult, cli: string): Promise<boolean> {
  const prompt = `You are fixing a runtime error in a ${result.stack.type.toUpperCase()} project (${result.stack.framework}).

⚠️ SCOPE RESTRICTION
You are operating INSIDE the directory: ${result.stack.dir}
Do NOT modify files outside this directory. Do NOT explore other stacks.

## THE ERROR
Phase that failed: ${result.phase}

\`\`\`
${result.errors}
\`\`\`

## YOUR TASK
Read the error carefully. Identify the root cause. Fix the minimum number of files to make the error go away.

Common causes for this type of error:
- TypeORM: \`string | null\` needs explicit \`@Column({ type: 'varchar', nullable: true })\`
- SWC + CJS default imports: use \`import x from 'pkg'\` not \`import * as x from 'pkg'\`
- Helmet CSP blocking external assets: relax \`contentSecurityPolicy.directives.scriptSrc\` / \`styleSrc\` to include needed CDN
- Missing env var: add fallback or default in code
- Vite/Next build error: usually a type mismatch or broken import
- Flutter null safety: add \`?\` or \`!\` or initialize in constructor

DO NOT ask questions. DO NOT explain. Just edit the files and fix the error.
After editing, the system will retry the verification automatically.`;

  const cliCmd = getCLICommand(cli);
  const args: string[] = [];
  if (cli === 'claude') {
    args.push('-p', '--dangerously-skip-permissions', '--max-turns', '15');
  } else if (cli === 'codex') {
    args.push('exec', '--full-auto');
  } else if (cli === 'gemini') {
    args.push('-y');
  }

  return new Promise((resolve) => {
    const proc = spawn(cliCmd, args, {
      cwd: result.stack.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    // 10min hard timeout per fix
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (err) { swallow(err); }
      resolve(false);
    }, 10 * 60 * 1000);

    proc.stdout?.on('data', (buf: Buffer) => {
      const line = buf.toString().split('\n').find(l => l.trim().length > 5 && l.length < 200);
      if (line) process.stdout.write(`\r  ${dim(line.trim().substring(0, 80))}\n`);
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ── Main orchestrator ────────────────────────────────────────────

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const { repoPath, cli, deep = false, maxPasses = 3, skipFix = false } = opts;

  console.log(dim('│'));
  console.log(`${dim('│')}  ${cyan('🩺 Doctor — runtime smoke test')}`);
  console.log(dim('│'));

  const stacks = detectStacks(repoPath);
  if (stacks.length === 0) {
    console.log(`${dim('│')}  ${yellow('⚠')} Nenhuma stack detectada (api/web/mobile)`);
    return { passed: true, passes: 0, stacks: [], finalResults: [] };
  }

  console.log(`${dim('│')}  ${dim('Stacks detectadas:')}`);
  for (const s of stacks) {
    console.log(`${dim('│')}    ${cyan('·')} ${s.label} ${dim(`(${path.relative(repoPath, s.dir) || '.'})`)}`);
  }

  let finalResults: DoctorCheckResult[] = [];

  for (let pass = 1; pass <= maxPasses; pass++) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${cyan(`Passada ${pass}/${maxPasses}`)} ${dim('— executando verificações em paralelo...')}`);
    console.log(dim('│'));

    const results = await Promise.all(
      stacks.map(async (stack): Promise<DoctorCheckResult> => {
        try {
          if (stack.type === 'api') return await checkApi(stack);
          if (stack.type === 'web') return await checkWeb(stack);
          if (stack.type === 'mobile') return await checkMobile(stack, deep);
        } catch (err: any) {
          return {
            stack,
            phase: 'unknown',
            success: false,
            errors: err?.message || String(err),
            durationMs: 0,
          };
        }
        return { stack, phase: 'skipped', success: true, errors: '', durationMs: 0 };
      }),
    );

    finalResults = results;

    console.log(dim('│'));
    for (const r of results) {
      const icon = r.success ? green('✓') : red('✗');
      const time = `${Math.round(r.durationMs / 1000)}s`;
      console.log(`${dim('│')}  ${icon} ${bold(r.stack.label)} ${dim(`[${r.phase}] ${time}`)}`);
      if (!r.success) {
        const firstLine = r.errors.split('\n').find(l => l.trim().length > 3) || '';
        if (firstLine) console.log(`${dim('│')}    ${dim(red(firstLine.substring(0, 120)))}`);
      }
    }

    const failed = results.filter(r => !r.success);
    if (failed.length === 0) {
      console.log(dim('│'));
      console.log(`${dim('│')}  ${green('✓')} ${bold('Todas as stacks passaram')} ${dim(`(passada ${pass})`)}`);
      return { passed: true, passes: pass, stacks, finalResults };
    }

    if (skipFix) {
      console.log(dim('│'));
      console.log(`${dim('│')}  ${yellow('⚠')} ${dim('--skip-fix ativo — não vou tentar corrigir')}`);
      return { passed: false, passes: pass, stacks, finalResults };
    }

    if (pass === maxPasses) {
      console.log(dim('│'));
      console.log(`${dim('│')}  ${red('✗')} ${bold(`Limite de ${maxPasses} passadas atingido`)} ${dim('— revisar manualmente')}`);
      for (const r of failed) {
        console.log(`${dim('│')}    ${red('·')} ${r.stack.label}:`);
        const tail = r.errors.split('\n').slice(-10).join('\n');
        for (const line of tail.split('\n')) {
          if (line.trim()) console.log(`${dim('│')}      ${dim(line.substring(0, 120))}`);
        }
      }
      return { passed: false, passes: pass, stacks, finalResults };
    }

    // Auto-fix each failed stack in parallel
    console.log(dim('│'));
    console.log(`${dim('│')}  ${cyan('🔧 Auto-fix')} ${dim(`— ${failed.length} stack(s) falhas via ${cli.toUpperCase()}`)}`);
    await Promise.all(failed.map(r => autoFix(r, cli)));
    console.log(`${dim('│')}  ${dim('Auto-fix completado, retestando...')}`);
  }

  return { passed: false, passes: maxPasses, stacks, finalResults };
}
