/**
 * plugin-registry.ts
 *
 * Typed registry for loaded plugins. Groups plugin contributions
 * by hook point so consumers (executor, verify-runner, etc.) can
 * query what's available without coupling to the plugin manager.
 */

import {
  MakeStudioPlugin,
  PluginCommand,
  PluginCLIStrategy,
  PluginVerifyCheck,
  PluginContextProvider,
  PluginHooks,
} from './plugin-types';
import { TaskDispatch, TaskResult } from '../types';
import { logInfo, logWarning, logError } from '../ui/terminal';

interface RegisteredPlugin {
  plugin: MakeStudioPlugin;
  enabled: boolean;
}

export class PluginRegistry {
  private plugins: Map<string, RegisteredPlugin> = new Map();

  // ── Registration ──────────────────────────────────────────────

  register(plugin: MakeStudioPlugin): void {
    if (this.plugins.has(plugin.name)) {
      logWarning(`[plugins] Plugin "${plugin.name}" already registered — skipping duplicate`);
      return;
    }
    this.plugins.set(plugin.name, { plugin, enabled: true });
  }

  unregister(name: string): void {
    this.plugins.delete(name);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  getAll(): MakeStudioPlugin[] {
    return Array.from(this.plugins.values())
      .filter(r => r.enabled)
      .map(r => r.plugin);
  }

  count(): number {
    return this.plugins.size;
  }

  clear(): void {
    this.plugins.clear();
  }

  // ── Query by hook point ───────────────────────────────────────

  getCommands(): PluginCommand[] {
    const commands: PluginCommand[] = [];
    for (const { plugin, enabled } of this.plugins.values()) {
      if (enabled && plugin.commands) {
        commands.push(...plugin.commands);
      }
    }
    return commands;
  }

  getCLIStrategies(): PluginCLIStrategy[] {
    const strategies: PluginCLIStrategy[] = [];
    for (const { plugin, enabled } of this.plugins.values()) {
      if (enabled && plugin.cliStrategies) {
        strategies.push(...plugin.cliStrategies);
      }
    }
    return strategies;
  }

  getVerifyChecks(): PluginVerifyCheck[] {
    const checks: PluginVerifyCheck[] = [];
    for (const { plugin, enabled } of this.plugins.values()) {
      if (enabled && plugin.verifyChecks) {
        checks.push(...plugin.verifyChecks);
      }
    }
    return checks;
  }

  getContextProviders(): PluginContextProvider[] {
    const providers: PluginContextProvider[] = [];
    for (const { plugin, enabled } of this.plugins.values()) {
      if (enabled && plugin.contextProviders) {
        providers.push(...plugin.contextProviders);
      }
    }
    return providers;
  }

  // ── Hook Execution (aggregated across all plugins) ────────────

  /**
   * Run all beforeTaskExec hooks sequentially.
   * Each hook can modify the task — changes are chained.
   */
  async runBeforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
    let current = task;
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.hooks?.beforeTaskExec) continue;
      try {
        current = await plugin.hooks.beforeTaskExec(current);
      } catch (err: any) {
        logError(`[plugins] ${plugin.name}.beforeTaskExec failed: ${err.message}`);
        // Continue with unmodified task on hook failure
      }
    }
    return current;
  }

  /**
   * Run all afterTaskExec hooks in parallel.
   * Errors are logged but don't affect the task result.
   */
  async runAfterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.hooks?.afterTaskExec) continue;
      promises.push(
        plugin.hooks.afterTaskExec(task, result).catch((err: any) => {
          logError(`[plugins] ${plugin.name}.afterTaskExec failed: ${err.message}`);
        }),
      );
    }
    await Promise.allSettled(promises);
  }

  /**
   * Run all beforeGitPush hooks. If ANY returns false, push is vetoed.
   */
  async runBeforeGitPush(info: { repoPath: string; branch: string; taskId: string }): Promise<boolean> {
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.hooks?.beforeGitPush) continue;
      try {
        const allowed = await plugin.hooks.beforeGitPush(info);
        if (!allowed) {
          logWarning(`[plugins] ${plugin.name} vetoed git push to ${info.branch}`);
          return false;
        }
      } catch (err: any) {
        logError(`[plugins] ${plugin.name}.beforeGitPush failed: ${err.message}`);
        // On error, allow push (fail-open)
      }
    }
    return true;
  }

  /**
   * Run onError hooks to determine action. First definitive answer wins.
   * Default: 'fail' if no plugin handles it.
   */
  async runOnError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.hooks?.onError) continue;
      try {
        const action = await plugin.hooks.onError(task, error);
        if (action) return action;
      } catch (err: any) {
        logError(`[plugins] ${plugin.name}.onError failed: ${err.message}`);
      }
    }
    return 'fail';
  }
}

// Singleton instance
export const pluginRegistry = new PluginRegistry();
