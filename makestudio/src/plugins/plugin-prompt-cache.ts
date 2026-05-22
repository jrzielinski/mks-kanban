import { swallow } from '../utils/log';
/**
 * plugin-prompt-cache — Caches task results to avoid redundant executions.
 * If the same prompt + repo state (git hash) was executed before, returns cached result.
 *
 * Cache stored in ~/.makestudio/cache/
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

const CACHE_DIR = path.join(os.homedir(), '.makestudio', 'cache');
const MAX_CACHE_SIZE = 100; // Max cached results
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(prompt: string, repoHash: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(prompt);
  hash.update(repoHash);
  return hash.digest('hex').substring(0, 16);
}

function getRepoHash(): string {
  try {
    return execSync('git rev-parse HEAD 2>/dev/null', {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5_000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function cleanExpiredCache(): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    const entries = fs.readdirSync(CACHE_DIR)
      .map(f => ({
        name: f,
        path: path.join(CACHE_DIR, f),
        mtime: fs.statSync(path.join(CACHE_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);

    const now = Date.now();
    for (const entry of entries) {
      if (now - entry.mtime > CACHE_TTL_MS || entries.indexOf(entry) >= MAX_CACHE_SIZE) {
        fs.unlinkSync(entry.path);
      }
    }
  } catch (err) { swallow(err); }
}

const plugin: MakeStudioPlugin = {
  name: 'prompt-cache',
  version: '1.0.0',
  description: 'Cache task results to avoid redundant AI executions',

  async onLoad(ctx: PluginContext) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    cleanExpiredCache();

    try {
      const cacheCount = fs.readdirSync(CACHE_DIR).length;
      ctx.logger.info(`Prompt cache: ${cacheCount} cached result(s)`);
    } catch (err) { swallow(err); }
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      // Only cache oneshot tasks (no git side effects)
      if (!task.oneshot) return task;

      const repoHash = getRepoHash();
      const cacheKey = getCacheKey(task.prompt, repoHash);
      const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);

      if (fs.existsSync(cachePath)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          const age = Date.now() - cached.timestamp;

          if (age < CACHE_TTL_MS) {
            const { logInfo } = await import('../ui/terminal');
            logInfo(`[prompt-cache] Cache hit for task ${task.taskId} (age: ${Math.round(age / 60000)}min)`);
            // Mark task to skip execution — inject cached result as hookContext
            task.hookContext = (task.hookContext || '') + `\n\n## CACHED RESULT (${Math.round(age / 60000)}min ago):\n${cached.content}`;
          }
        } catch (err) { swallow(err); }
      }

      return task;
    },

    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      // Only cache oneshot task results
      if (!task.oneshot) return;

      const repoHash = getRepoHash();
      const cacheKey = getCacheKey(task.prompt, repoHash);
      const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);

      try {
        fs.writeFileSync(cachePath, JSON.stringify({
          timestamp: Date.now(),
          taskId: task.taskId,
          content: (result.content || '').substring(0, 50_000), // Cap cache size
          costUsd: result.costUsd,
        }, null, 2), 'utf8');
      } catch (err) { swallow(err); }
    },
  },
};

export default plugin;
