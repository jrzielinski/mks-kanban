import { execSync } from 'child_process';
import { CLIInfo } from '../types';
import { pluginRegistry } from './plugin-registry';

interface CLICheck {
  name: string;
  command: string;
  versionFlag: string;
}

const SUPPORTED_CLIS: CLICheck[] = [
  // Self-hosting: MakeStudio's own headless mode. Always "installed" — it IS
  // this binary. Detected first so it appears as the default option when
  // every external CLI is missing. `--cli makestudio` routes to runHeadless
  // via the executor's buildCLICommand, reusing the REPL's safety/tools stack.
  { name: 'makestudio', command: 'makestudio', versionFlag: '--version' },
  { name: 'claude', command: 'claude', versionFlag: '--version' },
  { name: 'codex', command: 'codex', versionFlag: '--version' },
  { name: 'gemini', command: 'gemini', versionFlag: '--version' },
];

// Process-wide cache. detectInstalledCLIs() forks 4 subprocesses (one per
// supported CLI plus a `which`) on every call — in tight loops like
// per-requirement decomposition or refine, that adds up to hundreds of
// shell invocations per run. The set of installed CLIs cannot change
// during a process lifetime, so a simple memoization is safe.
let _cachedCLIs: CLIInfo[] | null = null;

/** Force re-detection on next call. Useful for tests. */
export function invalidateCLIDetectorCache(): void {
  _cachedCLIs = null;
}

export function detectInstalledCLIs(): CLIInfo[] {
  if (_cachedCLIs !== null) return _cachedCLIs;

  const installed: CLIInfo[] = [];

  for (const cli of SUPPORTED_CLIS) {
    // Self-reference fast path: when the CLI is "makestudio", the binary IS
    // this running process. Skip the subprocess probe (would fork a child of
    // ourselves just to print the version) and report directly.
    if (cli.name === 'makestudio') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { version } = require('../../package.json');
        installed.push({
          name: 'makestudio',
          version: version || '0.0.0',
          path: process.argv[1] || 'makestudio',
        });
      } catch {
        installed.push({ name: 'makestudio', version: 'unknown', path: process.argv[1] || 'makestudio' });
      }
      continue;
    }

    try {
      const version = execSync(`${cli.command} ${cli.versionFlag} 2>/dev/null`, {
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();

      // Try to find the full path
      let cliPath = cli.command;
      try {
        cliPath = execSync(`which ${cli.command} 2>/dev/null`, {
          encoding: 'utf8',
          timeout: 5_000,
        }).trim();
      } catch {
        // Fallback to command name
      }

      installed.push({
        name: cli.name,
        version: version.split('\n')[0] || version,
        path: cliPath,
      });
    } catch {
      // CLI not installed, skip
    }
  }

  // Detect plugin CLI strategies
  const pluginStrategies = pluginRegistry.getCLIStrategies();
  for (const strategy of pluginStrategies) {
    // Skip if already detected as built-in
    if (installed.some(c => c.name === strategy.name)) continue;
    try {
      const detected = strategy.detect instanceof Function
        ? null // async detect handled separately via detectPluginCLIs()
        : null;
      // For sync detection during initial scan, we just register the name
      // The async detect() is called in detectPluginCLIsAsync()
      if (detected) installed.push(detected);
    } catch {
      // Plugin CLI not available
    }
  }

  _cachedCLIs = installed;
  return installed;
}

/**
 * Async detection for plugin CLIs — call after loadAllPlugins().
 */
export async function detectPluginCLIs(): Promise<CLIInfo[]> {
  const pluginCLIs: CLIInfo[] = [];
  const strategies = pluginRegistry.getCLIStrategies();

  for (const strategy of strategies) {
    try {
      const info = await strategy.detect();
      if (info) {
        pluginCLIs.push(info);
      }
    } catch {
      // Plugin CLI detection failed — skip
    }
  }

  return pluginCLIs;
}

export function isCLIAvailable(cliName: string): boolean {
  const installed = detectInstalledCLIs();
  return installed.some(cli => cli.name === cliName);
}

export function getCLICommand(cliName: string): string {
  const installed = detectInstalledCLIs();
  return selectCLICommand(installed, cliName);
}

/**
 * Pure helper: pick the resolved path for a given CLI name from a list of
 * detected CLIs. Falls back to the name itself when no match is found so
 * callers can still spawn it via $PATH.
 *
 * Extracted from `getCLICommand` so it can be unit-tested without having
 * to mock `execSync`.
 */
export function selectCLICommand(installed: CLIInfo[], cliName: string): string {
  const cli = installed.find((c) => c.name === cliName);
  return cli?.path || cliName;
}

/**
 * Pure helper: returns the list of CLI names this agent natively supports
 * (before plug-in CLIs are added). Kept alongside `SUPPORTED_CLIS` so the
 * spec can assert the canonical list.
 */
export function getSupportedCLINames(): string[] {
  return SUPPORTED_CLIS.map((c) => c.name);
}
