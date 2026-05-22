import type * as readline from 'readline';
import type { ReplContext } from './context';

/**
 * Arguments passed to a slash command handler. Carries everything the
 * old switch-based dispatch had access to:
 *   - `ctx`: the REPL context (messages, providerInfo, helpers, etc.)
 *   - `rl`: the readline interface (used by /quit + interactive helpers)
 *   - `argsStr`: the rest of the input after the command, joined with ' '
 *   - `rest`: the same rest, split as tokens
 *   - `command`: the lowercase command name with leading slash, e.g. '/clear'
 */
export interface SlashContext {
  ctx: ReplContext;
  rl: readline.Interface;
  argsStr: string;
  rest: string[];
  command: string;          // lowercase, e.g. '/help'
  cmd: string;              // case-preserving original token, e.g. '/Help'
  trimmed: string;          // the full input.trim(), e.g. '/help foo'
  input: string;            // the raw input string passed to routeInput
}

export type SlashHandler = (sc: SlashContext) => Promise<void> | void;

export interface SlashCommand {
  /** All names this handler responds to, including the leading slash. */
  names: string[];
  handler: SlashHandler;
  /** When true, the command executes immediately even while the agent is
   *  processing a turn (busy). The App's handleSubmit intercepts these
   *  commands BEFORE the queue, running them in parallel. Used for side
   *  questions (/ask) that shouldn't interrupt the main agent. */
  immediate?: boolean;
  /** When true, the command is omitted from /help, Tab-complete, and any
   *  programmatic listing. Still works when typed exactly. Easter-egg
   *  commands (/matrix, /fire, …) use this. */
  hidden?: boolean;
}

const registry = new Map<string, SlashCommand>();

/**
 * Register one slash command. Each name maps to the same handler — the
 * handler can inspect `sc.command` to differentiate behavior between
 * aliases when needed (e.g. /pr vs /pr-comments share a handler).
 */
export function registerSlashCommand(cmd: SlashCommand): void {
  if (!cmd.names || cmd.names.length === 0) {
    throw new Error('SlashCommand must declare at least one name');
  }
  for (const n of cmd.names) registry.set(n.toLowerCase(), cmd);
}

/** Look up a command by name (lowercase, with leading slash). */
export function findSlashCommand(name: string): SlashCommand | undefined {
  return registry.get(name.toLowerCase());
}

/** Register many commands at once. */
export function registerSlashCommands(cmds: SlashCommand[]): void {
  for (const c of cmds) registerSlashCommand(c);
}

/** Number of distinct (handler-deduped) commands registered. */
export function slashCommandCount(): number {
  return new Set(registry.values()).size;
}

/** Test-only: clear the registry. */
export function __resetSlashRegistryForTests(): void {
  registry.clear();
}
