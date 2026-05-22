import { swallow } from '../utils/log';
/**
 * Shared utilities used by the slash-command handlers and by router.ts.
 * Centralised here so individual handler modules don't need to import
 * `chalk` or duplicate the gh-preflight / detached-REPL boilerplate.
 */
import chalk from 'chalk';
import { destroyRepl, recreateRepl } from './lifecycle';

export const dim = chalk.hex('#64748B');
export const yellow = chalk.hex('#FBBF24');
export const green = chalk.hex('#22C55E');
export const cyan = chalk.hex('#22D3EE');
export const red = chalk.hex('#EF4444');
export const bold = chalk.bold;

let ghPreflightCache: { ok: boolean; reason?: string; at: number } | null = null;
const GH_PREFLIGHT_TTL_MS = 60_000;

/** Exposed so tui-router can invalidate after `!gh auth login`. */
export function invalidateGhPreflight(): void {
  ghPreflightCache = null;
}

/**
 * Pre-flight for any gh-dependent command. Returns {ok:true} or a
 * ready-to-print friendly hint explaining exactly what the user needs
 * to do. Cached for 60s to avoid running `gh auth status` on every call.
 */
export function ghPreflight(cwd: string): { ok: true } | { ok: false; hint: string } {
  const now = Date.now();
  if (ghPreflightCache && (now - ghPreflightCache.at) < GH_PREFLIGHT_TTL_MS) {
    return ghPreflightCache.ok ? { ok: true } : { ok: false, hint: ghPreflightCache.reason! };
  }
  try {
    const { execSync } = require('child_process');
    // 1. gh CLI installed?
    try {
      execSync('gh --version', { stdio: 'pipe', timeout: 5_000 });
    } catch {
      const hint = 'gh CLI not installed.\n    Install: https://cli.github.com/  (macOS: brew install gh)';
      ghPreflightCache = { ok: false, reason: hint, at: now };
      return { ok: false, hint };
    }
    // 2. Authenticated?
    try {
      execSync('gh auth status', { stdio: 'pipe', timeout: 5_000 });
    } catch {
      const hint = 'Not logged into GitHub.\n    Run:  gh auth login';
      ghPreflightCache = { ok: false, reason: hint, at: now };
      return { ok: false, hint };
    }
    // 3. Cwd has a GitHub remote?
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe', timeout: 3_000 });
    } catch {
      const hint = 'Not inside a git repository.';
      ghPreflightCache = { ok: false, reason: hint, at: now };
      return { ok: false, hint };
    }
    ghPreflightCache = { ok: true, at: now };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, hint: `pre-flight failed: ${e.message}` };
  }
}

export function ghErrorHint(err: any): string {
  const msg = err?.stderr?.toString() || err?.message || String(err);
  const first = msg.split('\n').find((l: string) => l.trim()) || msg;
  if (/not logged into any github/i.test(msg) || /not authenticated/i.test(msg)) {
    return 'Not logged into GitHub.\n    Run:  gh auth login';
  }
  if (/could not resolve to a (pullrequest|issue)/i.test(msg)) {
    return `${first}\n    hint: this repo has no PR/issue with that number. Try /pr list.`;
  }
  if (/no git remotes/i.test(msg) || /no default remote/i.test(msg) || /no remote configured/i.test(msg)) {
    return `${first}\n    hint: this cwd has no GitHub remote configured.`;
  }
  if (/command not found|ENOENT/i.test(msg)) {
    return 'gh CLI not installed. Install: https://cli.github.com/';
  }
  return first;
}

class ReplCommandExit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

/**
 * Use ONLY for commands that create their own readline.createInterface().
 * Destroys the REPL readline first, recreates it after.
 * Commands that just print output should NOT use this.
 */
export async function withDetachedRepl(fn: () => Promise<void>): Promise<void> {
  await destroyRepl();
  // The TUI (Ink) keeps stdin in raw mode for keystroke handling. When a
  // subcommand creates its own readline.createInterface and the TTY is
  // still raw, Enter (CR=0x0D) is delivered as `^M` instead of being
  // translated into a newline by the line-discipline → user can't submit.
  // Force the TTY back to cooked mode here; recreateRepl() puts it back
  // when the subcommand returns.
  // Always force cooked mode regardless of current `isRaw` state — Ink's
  // unmount is asynchronous (useEffect cleanup runs on the next tick) so
  // checking `isRaw` here returns the pre-unmount value when the slash
  // command runs synchronously after destroyRepl(). Calling setRawMode
  // unconditionally is safe — it's a no-op when already cooked.
  let restoreRaw = false;
  try {
    if (process.stdin.isTTY) {
      (process.stdin as any).setRawMode(false);
      // Also resume stdin so readline gets keystrokes (Ink may have
      // paused it during unmount).
      if (process.stdin.isPaused()) process.stdin.resume();
      restoreRaw = true;
    }
  } catch (err) { swallow(err); }
  // Detach the TUI bridge too — otherwise helpers like askTuiOrReadline
  // see "bridge installed" and route through the (now unmounted) Ink
  // input box, hanging forever. We restore via recreateRepl() at the
  // end which re-mounts Ink and reinstalls the bridge.
  let detachedBridge: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const b = require('./tui/bridge');
    detachedBridge = b.getTuiBridge();
    if (detachedBridge) b.uninstallTuiBridge(detachedBridge);
  } catch (err) { swallow(err); }
  const originalExit = process.exit;

  (process as any).exit = (code?: number) => {
    throw new ReplCommandExit(code || 0);
  };

  try {
    await fn();
  } catch (err: any) {
    if (err instanceof ReplCommandExit) {
      if (err.code !== 0) {
        console.log(`  ${yellow('!')} Comando terminou com codigo ${err.code}`);
      }
    } else {
      console.log(`  ${yellow('!')} Erro: ${err.message || err}`);
    }
  } finally {
    (process as any).exit = originalExit;
    void restoreRaw;
    void detachedBridge;
    recreateRepl();
  }
}

/**
 * Catch process.exit() from commands/plugins without touching readline.
 * Use for non-interactive commands (no own readline).
 */
export async function withExitGuard(fn: () => Promise<void>): Promise<void> {
  const originalExit = process.exit;
  (process as any).exit = (code?: number) => {
    throw new ReplCommandExit(code || 0);
  };
  try {
    await fn();
  } catch (err: any) {
    if (err instanceof ReplCommandExit) {
      // Silent on exit codes 0/1/2 — command already printed its output.
      // Only show for unexpected exits (3+).
      if (err.code >= 3) {
        console.log(`  ${yellow('!')} Comando terminou com codigo ${err.code}`);
      }
    } else {
      console.log(`  ${yellow('!')} Erro: ${err.message || err}`);
    }
  } finally {
    (process as any).exit = originalExit;
  }
}

/**
 * Plugin-registered slash commands. Plugins contribute their own
 * `/<name>` handlers via plugin-repl-bridge.registerPluginSlashCommand;
 * router.ts checks this map BEFORE the registry lookup so plugins can
 * add commands without editing router-internal code.
 */
export interface PluginSlashCommandRecord {
  name: string;
  description: string;
  argumentHint?: string;
  handler: (args: string, ctx: any) => Promise<void> | void;
}
const pluginSlashCommands = new Map<string, PluginSlashCommandRecord>();

export function registerPluginSlashCommand(cmd: PluginSlashCommandRecord): void {
  if (!cmd?.name) throw new Error('plugin slash command must have a name');
  const clean = cmd.name.replace(/^\//, '');
  pluginSlashCommands.set(clean.toLowerCase(), { ...cmd, name: clean });
}

export function lookupPluginSlashCommand(name: string): PluginSlashCommandRecord | undefined {
  return pluginSlashCommands.get(name.toLowerCase());
}

export function listPluginSlashCommands(): Array<{ name: string; description: string; argumentHint?: string }> {
  return Array.from(pluginSlashCommands.values()).map((c) => ({
    name: c.name, description: c.description, argumentHint: c.argumentHint,
  }));
}

export function __clearPluginSlashCommandsForTests(): void {
  pluginSlashCommands.clear();
}
