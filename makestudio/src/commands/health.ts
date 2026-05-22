import { spawn } from 'child_process';
import { loadConfig } from '../config/config';
import { detectInstalledCLIs } from '../core/cli-detector';
import { getCLICommand } from '../core/cli-detector';
import { logInfo, logSuccess, logError, logWarning, logDivider } from '../ui/terminal';
import chalk from 'chalk';

const HEALTH_PROMPT = 'Reply with exactly: {"status":"ok","message":"health check passed"}';

interface HealthResult {
  check: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

function runCLIHealthCheck(cli: string, extraFlags: string[]): Promise<HealthResult> {
  return new Promise((resolve) => {
    const command = getCLICommand(cli);
    let args: string[] = [];

    if (cli === 'claude') {
      args = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--max-turns', '3',
        '--disallowed-tools', 'Agent',
        ...extraFlags,
      ];
    } else if (cli === 'codex') {
      args = ['exec', '--full-auto', ...extraFlags];
    } else if (cli === 'gemini') {
      args = ['-y', ...extraFlags];
    } else {
      resolve({ check: `CLI ${cli}`, ok: false, error: 'CLI não suportado' });
      return;
    }

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('error', (err) => {
      resolve({ check: `CLI ${cli}`, ok: false, error: err.message });
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        // Try to get a meaningful error message
        const errMsg = stderr.split('\n').find(l => l.trim().length > 0) ?? `exit code ${code}`;
        resolve({ check: `CLI ${cli}`, ok: false, error: errMsg });
        return;
      }

      // Try to find {"status":"ok"} anywhere in the output
      const combined = (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, '');
      const match = combined.match(/\{"status"\s*:\s*"ok"/);
      if (match) {
        resolve({ check: `CLI ${cli}`, ok: true, detail: 'Respondeu corretamente ao health prompt' });
      } else {
        // Still consider ok if exit code 0 but no JSON match
        resolve({ check: `CLI ${cli}`, ok: true, detail: 'Executou sem erro (JSON não encontrado na saída)' });
      }
    });

    // Write the prompt to stdin
    proc.stdin.write(HEALTH_PROMPT);
    proc.stdin.end();
  });
}

export async function healthCommand(opts: { cli?: string; verbose?: boolean }): Promise<void> {
  logDivider();
  logInfo(chalk.bold('MakeStudio — Health Check'));
  console.log();

  const config = loadConfig();
  const results: HealthResult[] = [];

  // ── 1. Config check ──────────────────────────────────────────────
  const hasToken = !!(config?.token);
  results.push({
    check: 'Configuração (~/.makestudio/config.json)',
    ok: hasToken,
    detail: hasToken ? `Servidor: ${config!.serverUrl}` : undefined,
    error: hasToken ? undefined : 'Não autenticado — execute: makestudio login',
  });

  // ── 2. CLI detection ──────────────────────────────────────────────
  const detectedCLIs = detectInstalledCLIs();
  if (detectedCLIs.length === 0) {
    results.push({
      check: 'CLIs de IA',
      ok: false,
      error: 'Nenhum CLI detectado (claude, codex, gemini)',
    });
  } else {
    results.push({
      check: 'CLIs de IA',
      ok: true,
      detail: detectedCLIs.map(c => `${c.name} ${c.version}`).join(', '),
    });
  }

  // ── 3. Config flags ───────────────────────────────────────────────
  const extraFlags = config?.cliExtraFlags ?? {};
  const flagSummary = Object.entries(extraFlags)
    .filter(([, flags]) => flags && flags.length > 0)
    .map(([cli, flags]) => `${cli}: [${flags!.join(' ')}]`)
    .join(', ');
  results.push({
    check: 'Flags configuradas (cliExtraFlags)',
    ok: true,
    detail: flagSummary || 'Nenhuma flag extra configurada',
  });

  // ── 4. CLI execution test ─────────────────────────────────────────
  const cliToTest = opts.cli
    ? detectedCLIs.filter(c => c.name === opts.cli)
    : detectedCLIs;

  if (cliToTest.length === 0 && opts.cli) {
    results.push({ check: `Execução: ${opts.cli}`, ok: false, error: 'CLI não instalado' });
  } else {
    for (const cli of cliToTest) {
      logInfo(`Testando execução com ${chalk.cyan(cli.name)}...`);
      const extraCLIFlags = extraFlags[cli.name as 'claude' | 'codex' | 'gemini'] ?? [];
      const execResult = await runCLIHealthCheck(cli.name, extraCLIFlags);
      execResult.check = `Execução: ${cli.name}`;
      results.push(execResult);
    }
  }

  // ── Print results ─────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold('  Resultados:'));
  console.log();
  for (const r of results) {
    const icon = r.ok ? chalk.green('  ✓') : chalk.red('  ✗');
    const label = r.ok ? chalk.white(r.check) : chalk.red(r.check);
    console.log(`${icon}  ${label}`);
    if (r.detail) {
      console.log(`     ${chalk.hex('#94A3B8')(r.detail)}`);
    }
    if (r.error) {
      console.log(`     ${chalk.yellow(r.error)}`);
    }
  }
  console.log();

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    logSuccess('Tudo certo! O agent está pronto para trabalhar.');
  } else {
    logWarning(`${failed.length} problema(s) encontrado(s). Corrija antes de iniciar o agent.`);
    if (failed.some(f => f.error?.includes('unknown option'))) {
      console.log();
      console.log(chalk.yellow('  💡 Flag inválida detectada. Para remover flags problemáticas:'));
      console.log(chalk.cyan('     makestudio config --show'));
      console.log(chalk.cyan('     # Edite ~/.makestudio/config.json e remova a flag de cliExtraFlags'));
    }
  }

  logDivider();

  if (failed.length > 0) {
    process.exit(1);
  }
}
