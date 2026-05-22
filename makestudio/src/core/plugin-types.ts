/**
 * plugin-types.ts
 *
 * Type definitions for the MakeStudio Plugin System.
 * Plugins can extend the agent with new commands, CLI strategies,
 * verification checks, context providers, and lifecycle hooks.
 */

import { TaskDispatch, TaskResult, CLIInfo } from '../types';
import { VerifyResult } from './verify-runner';

// ── Plugin Context ──────────────────────────────────────────────

/**
 * Context passed to plugins during initialization.
 * Provides read-only access to agent configuration and utilities.
 */
export interface PluginContext {
  /** Agent version */
  agentVersion: string;
  /** Home directory for MakeStudio (~/.makestudio) */
  homeDir: string;
  /** Current agent configuration (read-only) */
  config: Record<string, any>;
  /** Logger utilities */
  logger: PluginLogger;
}

export interface PluginLogger {
  info(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

// ── Plugin Commands ─────────────────────────────────────────────

export interface PluginCommandOption {
  flags: string;
  description: string;
  defaultValue?: string;
}

export interface PluginCommand {
  /** Command name (e.g. 'deploy') — becomes `makestudio <name>` */
  name: string;
  description: string;
  options?: PluginCommandOption[];
  /** Handler function invoked when the command is executed */
  handler: (options: Record<string, any>) => Promise<void>;
}

// ── CLI Strategies ──────────────────────────────────────────────

export interface PluginCLIStrategy {
  /** CLI identifier (e.g. 'cursor', 'aider') */
  name: string;
  /** Detect if the CLI is installed — return version string or null */
  detect: () => Promise<CLIInfo | null>;
  /** Build the spawn command and args for this CLI */
  buildCommand: (prompt: string, options: CLIBuildOptions) => { command: string; args: string[] };
  /** Parse stdout stream lines to extract progress events (optional) */
  parseOutput?: (line: string, taskId: string, startTime: number) => CLIOutputEvent | null;
}

export interface CLIBuildOptions {
  maxTurns?: number;
  extraFlags?: string[];
  modelTier?: 'fast' | 'standard' | 'advanced';
}

export interface CLIOutputEvent {
  type: 'tool_call' | 'text' | 'result' | 'error';
  tool?: string;
  file?: string;
  message?: string;
}

// ── Verification Checks ─────────────────────────────────────────

export interface PluginVerifyCheck {
  /** Check name (e.g. 'eslint', 'jest') */
  name: string;
  /** Task types this check applies to (empty = all task types) */
  appliesTo?: string[];
  /** Run the verification check — return pass/fail with optional output */
  run: (repoPath: string, taskType?: string) => Promise<{ passed: boolean; output?: string }>;
}

// ── Context Providers ───────────────────────────────────────────

export interface PluginContextProvider {
  /** Provider name (e.g. 'sentry-errors') */
  name: string;
  /** File name to write in .makestudio/context/ (e.g. 'sentry-context.md') */
  fileName: string;
  /** Generate the context content — return markdown string or null to skip */
  generate: (projectId?: string, repoPath?: string) => Promise<string | null>;
}

// ── Lifecycle Hooks ─────────────────────────────────────────────

export interface PluginHooks {
  /** Called before task execution — can modify the task dispatch */
  beforeTaskExec?: (task: TaskDispatch) => Promise<TaskDispatch>;
  /** Called after task execution completes */
  afterTaskExec?: (task: TaskDispatch, result: TaskResult) => Promise<void>;
  /** Called before git push — return false to prevent push */
  beforeGitPush?: (info: { repoPath: string; branch: string; taskId: string }) => Promise<boolean>;
  /** Called when a task fails — return action to take */
  onError?: (task: TaskDispatch, error: Error) => Promise<'retry' | 'skip' | 'fail'>;
}

// ── Plugin Definition ───────────────────────────────────────────

/**
 * Main plugin interface — every plugin must export a default object implementing this.
 *
 * Example plugin:
 * ```typescript
 * import { MakeStudioPlugin, PluginContext } from '@makestudio/agent/plugin-types';
 *
 * const plugin: MakeStudioPlugin = {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   description: 'Does something cool',
 *   async onLoad(ctx) {
 *     ctx.logger.info('Plugin loaded!');
 *   },
 *   verifyChecks: [{ name: 'my-check', run: async (repo) => ({ passed: true }) }],
 * };
 * export default plugin;
 * ```
 */
export interface MakeStudioPlugin {
  /** Plugin name (unique identifier) */
  name: string;
  /** Semantic version */
  version: string;
  /** Optional description */
  description?: string;

  // ── Lifecycle ──
  /** Called when the plugin is loaded — use for async initialization */
  onLoad?: (context: PluginContext) => Promise<void>;
  /** Called when the plugin is unloaded — use for cleanup */
  onUnload?: () => Promise<void>;

  // ── Extension Points (pipeline-side) ──
  /** New CLI commands (e.g. `makestudio deploy`) */
  commands?: PluginCommand[];
  /** New AI CLI strategies (e.g. Cursor, Aider) */
  cliStrategies?: PluginCLIStrategy[];
  /** Additional post-execution verification checks */
  verifyChecks?: PluginVerifyCheck[];
  /** Additional context file providers */
  contextProviders?: PluginContextProvider[];
  /** Lifecycle hooks (pipeline-side — beforeTaskExec, afterTaskExec, etc) */
  hooks?: PluginHooks;

  // ── Extension Points (REPL-side) ──
  /**
   * Bundled skills this plugin contributes. Each is registered via
   * registerBundledSkill when the plugin loads. Invocable via /<name>.
   */
  replSkills?: PluginReplSkill[];
  /**
   * REPL lifecycle hook handlers. Merged into the hooks engine when the
   * plugin is enabled. Same semantics as ~/.makestudio/hooks.json entries
   * but declared in-code for strongly-typed plugins.
   */
  replHooks?: PluginReplHooks;
  /**
   * MCP servers this plugin wants to register. Appended to the MCP config
   * loaded from ~/.makestudio/mcp.json when the plugin is enabled.
   */
  mcpServers?: PluginMcpServer[];
  /**
   * Extra tool definitions exposed to the REPL model. Fully typed tool
   * definitions with their own implementations. Used by plugins that
   * extend the tool catalog beyond what MCP supplies.
   */
  replTools?: PluginReplTool[];
  /**
   * Slash commands registered in the REPL router. Each maps a `/<name>`
   * to an async handler. The handler receives the raw argument string
   * and a thin context. Lets a plugin add `/deploy-staging` without
   * editing router.ts.
   */
  replSlashCommands?: PluginSlashCommand[];
}

// ── REPL extension shapes ──

/**
 * A bundled skill contributed by a plugin. Mirrors the `Skill` shape in
 * repl/skills.ts — kept here duplicated (not imported) to avoid plugin
 * authors having to import from deep internals. The plugin loader
 * translates this to `registerBundledSkill` at boot.
 */
export interface PluginReplSkill {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  args?: string[];
  body?: string;
  /** Async prompt generator — takes precedence over `body`. */
  getPromptForCommand?: (args: string, cwd: string) => Promise<string> | string;
  /** Runtime gate — return false to hide this skill. */
  isEnabled?: () => boolean;
}

/**
 * Per-event hook arrays keyed by lifecycle event name. Values match the
 * Hook union from repl/hooks.ts (command/http/prompt/agent).
 */
export type PluginReplHooks = Partial<Record<
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd'
  | 'PreCompact' | 'PostCompact' | 'Stop'
  | 'PermissionRequest' | 'PermissionDenied'
  | 'SubagentStart' | 'SubagentStop' | 'Setup',
  Array<Record<string, any>>
>>;

/**
 * MCP server descriptor — mirrors the shape accepted by repl/mcp.ts's
 * loader. Only the transport/command fields are required; everything else
 * (env, args) is optional.
 */
export interface PluginMcpServer {
  name: string;
  /** Spawn command (e.g. 'npx') or HTTP URL when transport='http'. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'http';
}

/**
 * Tool definition + implementation paired. Registered into the global
 * advanced-tools catalog when the plugin loads.
 */
export interface PluginReplTool {
  name: string;
  description: string;
  input_schema: any;
  /** Impl receives the raw input object and a minimal ctx (cwd + cwdSafe path).
   *  Return either a string (becomes the tool_result) or an object — objects
   *  are JSON-stringified. */
  execute: (input: any, ctx: { cwd: string }) => Promise<string | object> | string | object;
  /** List of allowed invocation contexts — defaults to ['main', 'subagent']. */
  allowedContexts?: Array<'main' | 'subagent'>;
}

/**
 * Slash command handler. When the user types `/<name> <args>`, the router
 * invokes `handler(args, ctx)`. Return value ignored; side effects via
 * bridge.addMessage or ctx.messages.push as needed.
 */
export interface PluginSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Handler — raw argument string, REPL context. */
  handler: (args: string, ctx: any) => Promise<void> | void;
}

// ── Plugin Manifest ─────────────────────────────────────────────

/**
 * Metadata stored in ~/.makestudio/plugins.json
 */
export interface PluginManifest {
  /** Plugin name */
  name: string;
  /** Installed version */
  version: string;
  /** Optional one-line description. Surfaces in the UI plugin list. */
  description?: string;
  /** Source: 'npm' | 'local' | 'git' | 'builtin' */
  source: 'npm' | 'local' | 'git' | 'builtin';
  /** Install path on disk */
  path: string;
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Installation timestamp */
  installedAt: string;
}

/**
 * Root plugins.json structure
 */
export interface PluginsConfig {
  plugins: PluginManifest[];
}
