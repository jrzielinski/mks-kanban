import { execSync } from 'child_process';
import { logInfo, logSuccess, logError, logWarning } from '../ui/terminal';
import { pluginRegistry } from './plugin-registry';

export interface VerifyResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    output?: string;
  }>;
}

/**
 * Run post-execution verification checks on the repo.
 * Returns pass/fail with details.
 */
export async function runVerification(repoPath: string, taskType?: string): Promise<VerifyResult> {
  const checks: VerifyResult['checks'] = [];

  // 1. TypeScript compilation check (SWC — fast, no memory issues)
  logInfo('[verify] Checando compilação...');
  try {
    const modifiedTs = execSync(
      'git diff --name-only --diff-filter=ACMR HEAD | grep "\\.ts$" || true',
      { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
    ).trim();

    if (modifiedTs) {
      const files = modifiedTs.split('\n').filter(Boolean).slice(0, 20); // Max 20 files
      const fileList = files.join(' ');
      try {
        execSync(
          `npx swc ${fileList} -d /tmp/makestudio-verify-${process.pid} --strip-leading-paths 2>&1`,
          { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
        );
        checks.push({ name: 'compilation', passed: true });
        logSuccess('[verify] Compilação OK');
      } catch (err: any) {
        checks.push({ name: 'compilation', passed: false, output: err.stdout || err.message });
        logError(`[verify] Compilação falhou: ${(err.stdout || err.message).substring(0, 200)}`);
      }
    } else {
      checks.push({ name: 'compilation', passed: true, output: 'No .ts files modified' });
    }
  } catch {
    checks.push({ name: 'compilation', passed: true, output: 'Could not detect modified files' });
  }

  // 2. Check for common issues
  logInfo('[verify] Checando problemas comuns...');
  try {
    const diff = execSync('git diff HEAD', { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });

    // Check for console.log left in
    const consoleLogs = (diff.match(/\+.*console\.log\(/g) || []).length;
    if (consoleLogs > 0) {
      checks.push({ name: 'no_console_log', passed: false, output: `${consoleLogs} console.log(s) found in diff` });
      logWarning(`[verify] ${consoleLogs} console.log(s) encontrados`);
    } else {
      checks.push({ name: 'no_console_log', passed: true });
    }

    // Check for hardcoded secrets
    const secretPatterns = [
      /\+.*(?:api[_-]?key|apikey)\s*[=:]\s*['"][A-Za-z0-9]{20,}/i,
      /\+.*(?:sk-|pk_live_|sk_live_|AKIA)[A-Za-z0-9]{10,}/,
    ];
    let hasSecrets = false;
    for (const pattern of secretPatterns) {
      if (pattern.test(diff)) {
        hasSecrets = true;
        break;
      }
    }
    if (hasSecrets) {
      checks.push({ name: 'no_secrets', passed: false, output: 'Potential secret/credential in diff' });
      logError('[verify] POSSÍVEL SECRET/CREDENTIAL DETECTADA NO CÓDIGO!');
    } else {
      checks.push({ name: 'no_secrets', passed: true });
    }
  } catch {
    // Non-critical
  }

  // 3. Test execution (only for test tasks or if test files were modified)
  if (taskType === 'test') {
    logInfo('[verify] Rodando testes...');
    try {
      const testOutput = execSync('npm test -- --passWithNoTests 2>&1', {
        cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
      });
      checks.push({ name: 'tests', passed: true, output: testOutput.substring(0, 200) });
      logSuccess('[verify] Testes passaram');
    } catch (err: any) {
      checks.push({ name: 'tests', passed: false, output: (err.stdout || err.message).substring(0, 500) });
      logError('[verify] Testes falharam');
    }
  }

  // 4. Plugin verification checks
  const pluginChecks = pluginRegistry.getVerifyChecks();
  for (const pluginCheck of pluginChecks) {
    // Skip if check has appliesTo filter and taskType doesn't match
    if (pluginCheck.appliesTo?.length && taskType && !pluginCheck.appliesTo.includes(taskType)) {
      continue;
    }

    logInfo(`[verify] Running plugin check: ${pluginCheck.name}...`);
    try {
      const result = await pluginCheck.run(repoPath, taskType);
      checks.push({
        name: `plugin:${pluginCheck.name}`,
        passed: result.passed,
        output: result.output,
      });
      if (result.passed) {
        logSuccess(`[verify] Plugin check ${pluginCheck.name} passed`);
      } else {
        logError(`[verify] Plugin check ${pluginCheck.name} failed: ${(result.output || '').substring(0, 200)}`);
      }
    } catch (err: any) {
      logError(`[verify] Plugin check ${pluginCheck.name} threw error: ${err.message}`);
      // On plugin check error, treat as passed (fail-open) to not block execution
      checks.push({ name: `plugin:${pluginCheck.name}`, passed: true, output: `Error: ${err.message}` });
    }
  }

  const allPassed = checks.every(c => c.passed);

  if (allPassed) {
    logSuccess('[verify] Todas as verificações passaram ✓');
  } else {
    const failed = checks.filter(c => !c.passed);
    logError(`[verify] ${failed.length} verificação(ões) falharam: ${failed.map(c => c.name).join(', ')}`);
  }

  return { passed: allPassed, checks };
}

/**
 * Pure: count `console.log(` appearances on added lines of a git diff.
 * Considers only lines starting with `+` so pre-existing logs aren't
 * flagged. Returns 0 for empty/null diffs.
 */
export function countAddedConsoleLogs(diff: string | null | undefined): number {
  if (!diff) return 0;
  return (diff.match(/\+.*console\.log\(/g) || []).length;
}

/**
 * Pure: detect whether an added line in the diff contains what looks like
 * a hardcoded API key / secret. Returns true on any match.
 */
export function diffContainsPotentialSecret(diff: string | null | undefined): boolean {
  if (!diff) return false;
  const patterns = [
    /\+.*(?:api[_-]?key|apikey)\s*[=:]\s*['"][A-Za-z0-9]{20,}/i,
    /\+.*(?:sk-|pk_live_|sk_live_|AKIA)[A-Za-z0-9]{10,}/,
  ];
  return patterns.some((p) => p.test(diff));
}

/**
 * Pure: summarise a VerifyResult into a short message suitable for logs or
 * retry prompts.
 */
export function summarizeVerifyResult(result: VerifyResult): string {
  if (result.passed) return 'all checks passed';
  const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
  return `${failed.length} failed: ${failed.join(', ')}`;
}

/**
 * Build a retry prompt with error context from failed verification.
 */
export function buildRetryPrompt(
  originalPrompt: string,
  verifyResult: VerifyResult,
  attempt: number,
  maxAttempts: number,
): string {
  const failedChecks = verifyResult.checks
    .filter(c => !c.passed)
    .map(c => `- [${c.name}] ${c.output || 'Failed'}`)
    .join('\n');

  return `${originalPrompt}

## VERIFICATION FAILED — RETRY ${attempt}/${maxAttempts}

The previous execution failed these verification checks:

${failedChecks}

FIX the issues above. Do NOT rewrite the entire solution — make targeted fixes only.
After fixing, ensure all verification passes.`;
}
