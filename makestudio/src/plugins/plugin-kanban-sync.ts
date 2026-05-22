import { swallow } from '../utils/log';
/**
 * plugin-kanban-sync — Syncs MakeStudio task execution with Kanban cards.
 * When a task starts, moves the card to "Em andamento".
 * When it completes, moves to "Em revisão".
 * When it fails, moves to "Falhou".
 *
 * Uses the backend API: /api/v1/kanban/cards/:cardId/move
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface KanbanSyncConfig {
  serverUrl: string;
  token: string;
}

function getConfig(): KanbanSyncConfig | null {
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.serverUrl && config.token) {
        return { serverUrl: config.serverUrl, token: config.token };
      }
    }
  } catch (err) { swallow(err); }
  return null;
}

async function apiRequest(config: KanbanSyncConfig, method: string, apiPath: string, body?: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const url = new URL(config.serverUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const bodyStr = body ? JSON.stringify(body) : '';

      const req = transport.request({
        hostname: url.hostname,
        port: url.port,
        path: `/api/v1${apiPath}`,
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
        },
        timeout: 15_000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    } catch { resolve(null); }
  });
}

// Map of taskId → kanbanCardId (populated from task dispatch metadata)
const taskCardMap: Map<string, string> = new Map();

const plugin: MakeStudioPlugin = {
  name: 'kanban-sync',
  version: '1.0.0',
  description: 'Auto-sync task execution status with Kanban cards',

  async onLoad(ctx: PluginContext) {
    if (getConfig()) {
      ctx.logger.info('Kanban sync configured');
    } else {
      ctx.logger.warning('Kanban sync needs server URL and token in config');
    }
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      const config = getConfig();
      if (!config) return task;

      // Try to find associated kanban card from task metadata
      // The backend Dark Factory sync creates cards with taskId reference
      try {
        const response = await apiRequest(config, 'GET', `/dark-factory/tasks/${task.taskId}`);
        if (response?.kanbanCardId) {
          taskCardMap.set(task.taskId, response.kanbanCardId);

          // Add card comment: "Agent started execution"
          await apiRequest(config, 'POST', `/kanban/cards/${response.kanbanCardId}/activities`, {
            type: 'comment',
            text: `Agent started executing task: ${task.taskTitle || task.taskId}\nCLI: ${task.cli} | Tier: ${task.modelTier || 'standard'}`,
          });
        }
      } catch (err) { swallow(err); }

      // Enforce memory limit
      if (taskCardMap.size > 100) {
        const oldest = taskCardMap.keys().next().value;
        if (oldest) taskCardMap.delete(oldest);
      }

      return task;
    },

    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const config = getConfig();
      if (!config) return;

      const cardId = taskCardMap.get(task.taskId);
      if (!cardId) return;
      taskCardMap.delete(task.taskId);

      // Add completion comment
      await apiRequest(config, 'POST', `/kanban/cards/${cardId}/activities`, {
        type: 'comment',
        text: `Task completed successfully.\nCost: ${result.costUsd.toFixed(4)}\nBranch: ${result.gitInfo?.branch || 'N/A'}\nPushed: ${result.gitInfo?.pushed ? 'Yes' : 'No'}`,
      });
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      const config = getConfig();
      if (!config) return 'fail';

      const cardId = taskCardMap.get(task.taskId);
      if (!cardId) return 'fail';
      taskCardMap.delete(task.taskId);

      // Add failure comment
      await apiRequest(config, 'POST', `/kanban/cards/${cardId}/activities`, {
        type: 'comment',
        text: `Task failed.\nError: ${error.message.substring(0, 300)}`,
      });

      return 'fail';
    },
  },
};

export default plugin;
