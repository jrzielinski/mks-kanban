/**
 * plugin-repl-bridge.ts — aggregate plugin contributions into REPL registries.
 *
 * When MakeStudio boots the REPL (tui-index.tsx), this module walks the list
 * of enabled plugins and pushes their declared `replSkills`, `replHooks`,
 * `mcpServers`, `replTools`, and `replSlashCommands` into the right global
 * registries. Idempotent — safe to call multiple times (e.g. via
 * `/reload-plugins`).
 *
 * Keeps plugin-facing types in `core/plugin-types.ts` but does the wiring
 * here so the REPL layer stays isolated from plugin internals.
 */

import type { MakeStudioPlugin, PluginReplSkill, PluginReplTool, PluginSlashCommand } from '../core/plugin-types';

export interface PluginAggregation {
  /** Number of plugins that contributed anything. */
  contributingPlugins: number;
  /** Skill names registered. */
  skills: string[];
  /** Tool names registered. */
  tools: string[];
  /** Slash command names registered. */
  slashCommands: string[];
  /** Number of hook entries merged, keyed by event. */
  hooks: Record<string, number>;
  /** MCP server names registered. */
  mcpServers: string[];
  /** Non-fatal errors per plugin — surfaced by /doctor. */
  errors: Array<{ plugin: string; reason: string }>;
}

/**
 * In-memory state added by THIS boot of the plugin bridge. Lets us roll
 * back on `/reload-plugins` without nuking unrelated state. Tracked via
 * closures — exported only for tests.
 */
let lastAggregation: PluginAggregation | null = null;

/** Aggregate contributions from every enabled plugin. Safe to re-run. */
export function aggregatePluginContributions(
  plugins: MakeStudioPlugin[],
  opts: { cwd?: string } = {},
): PluginAggregation {
  const result: PluginAggregation = {
    contributingPlugins: 0,
    skills: [], tools: [], slashCommands: [],
    hooks: {}, mcpServers: [], errors: [],
  };

  for (const plugin of plugins) {
    let contributed = false;

    // Skills
    if (plugin.replSkills && plugin.replSkills.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { registerBundledSkill } = require('./skills');
        for (const sk of plugin.replSkills) {
          const full = translatePluginSkill(sk);
          try {
            registerBundledSkill(full);
            result.skills.push(sk.name);
            contributed = true;
          } catch (e: any) {
            result.errors.push({ plugin: plugin.name, reason: `skill "${sk.name}" failed: ${e.message}` });
          }
        }
      } catch (e: any) {
        result.errors.push({ plugin: plugin.name, reason: `skills module unavailable: ${e.message}` });
      }
    }

    // Hooks — merge into a singleton in-memory override that hooks.ts
    // consults on top of the disk-loaded hooks.json. Prepended so plugin
    // hooks fire BEFORE user hooks (lets a plugin audit before a user's
    // custom shell command).
    if (plugin.replHooks) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { registerPluginHooks } = require('./hooks');
        for (const [event, entries] of Object.entries(plugin.replHooks)) {
          if (!Array.isArray(entries) || entries.length === 0) continue;
          registerPluginHooks(event, entries);
          result.hooks[event] = (result.hooks[event] || 0) + entries.length;
          contributed = true;
        }
      } catch (e: any) {
        result.errors.push({ plugin: plugin.name, reason: `hooks registration failed: ${e.message}` });
      }
    }

    // Tools — register into the advanced-tools catalog via a registration hook.
    if (plugin.replTools && plugin.replTools.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { registerPluginReplTool } = require('./ai/advanced-tools');
        for (const tool of plugin.replTools) {
          try {
            registerPluginReplTool(tool);
            result.tools.push(tool.name);
            contributed = true;
          } catch (e: any) {
            result.errors.push({ plugin: plugin.name, reason: `tool "${tool.name}" failed: ${e.message}` });
          }
        }
      } catch (e: any) {
        result.errors.push({ plugin: plugin.name, reason: `tool registration unavailable: ${e.message}` });
      }
    }

    // Slash commands — registered in the router's plugin-slash table.
    if (plugin.replSlashCommands && plugin.replSlashCommands.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { registerPluginSlashCommand } = require('./router');
        for (const cmd of plugin.replSlashCommands) {
          try {
            registerPluginSlashCommand(cmd);
            result.slashCommands.push(cmd.name);
            contributed = true;
          } catch (e: any) {
            result.errors.push({ plugin: plugin.name, reason: `slash "/${cmd.name}" failed: ${e.message}` });
          }
        }
      } catch (e: any) {
        result.errors.push({ plugin: plugin.name, reason: `slash registration unavailable: ${e.message}` });
      }
    }

    // MCP servers — appended to runtime MCP config.
    if (plugin.mcpServers && plugin.mcpServers.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { registerPluginMcpServer } = require('./mcp');
        for (const s of plugin.mcpServers) {
          try {
            registerPluginMcpServer(s);
            result.mcpServers.push(s.name);
            contributed = true;
          } catch (e: any) {
            result.errors.push({ plugin: plugin.name, reason: `mcp server "${s.name}" failed: ${e.message}` });
          }
        }
      } catch (e: any) {
        result.errors.push({ plugin: plugin.name, reason: `mcp registration unavailable: ${e.message}` });
      }
    }

    if (contributed) result.contributingPlugins++;
  }

  lastAggregation = result;
  return result;
}

export function getLastAggregation(): PluginAggregation | null {
  return lastAggregation;
}

// ── Phase 12: Per-plugin contributions ────────────────────────────────

export interface PluginContributions {
  pluginName: string;
  skills: string[];
  tools: string[];
  slashCommands: string[];
  hooks: Record<string, number>;
  mcpServers: string[];
}

/**
 * Returns the contributions of a single plugin without re-registering them.
 * Read-only inspection of the plugin object (the registry holds the same
 * MakeStudioPlugin instances that aggregatePluginContributions consumed).
 *
 * Used by the Phase 12 PluginsPage detail modal — shows what the plugin
 * adds to the runtime so the user can decide whether to keep it enabled.
 */
export function getPluginContributions(plugin: MakeStudioPlugin): PluginContributions {
  const hooks: Record<string, number> = {};
  if (plugin.replHooks) {
    for (const [event, entries] of Object.entries(plugin.replHooks)) {
      if (Array.isArray(entries) && entries.length > 0) {
        hooks[event] = entries.length;
      }
    }
  }
  return {
    pluginName: plugin.name,
    skills: (plugin.replSkills ?? []).map((s) => s.name),
    tools: (plugin.replTools ?? []).map((t) => t.name),
    slashCommands: (plugin.replSlashCommands ?? []).map((c) => c.name),
    hooks,
    mcpServers: (plugin.mcpServers ?? []).map((m) => m.name),
  };
}

function translatePluginSkill(s: PluginReplSkill): any {
  return {
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
    argumentHint: s.argumentHint,
    allowedTools: s.allowedTools,
    disableModelInvocation: s.disableModelInvocation,
    userInvocable: s.userInvocable !== false,
    args: s.args || [],
    body: s.body || '',
    getPromptForCommand: s.getPromptForCommand,
    isEnabled: s.isEnabled,
  };
}
