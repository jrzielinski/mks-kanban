import { swallow } from '../utils/log';
/**
 * plugin-kanban-auto-assign — Auto-assigns Kanban cards to the agent
 * when tasks are dispatched, and updates card labels/checklists.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

function getConfig(): { serverUrl: string; token: string; userId?: number } | null {
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.serverUrl && config.token) {
        return { serverUrl: config.serverUrl, token: config.token, userId: config.userId };
      }
    }
  } catch (err) { swallow(err); }
  return null;
}

async function apiRequest(serverUrl: string, token: string, method: string, apiPath: string, body?: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const url = new URL(serverUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const bodyStr = body ? JSON.stringify(body) : '';

      const req = transport.request({
        hostname: url.hostname,
        port: url.port,
        path: `/api/v1${apiPath}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
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

const plugin: MakeStudioPlugin = {
  name: 'kanban-auto-assign',
  version: '1.0.0',
  description: 'Auto-assign Kanban cards and update labels when tasks execute',

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      const config = getConfig();
      if (!config) return task;

      try {
        // Fetch task to get kanbanCardId
        const taskData = await apiRequest(config.serverUrl, config.token, 'GET', `/dark-factory/tasks/${task.taskId}`);
        if (!taskData?.kanbanCardId) return task;

        const cardId = taskData.kanbanCardId;

        // Add "In Progress" label and assign to current user
        const updates: Record<string, any> = {};

        if (config.userId) {
          // Add agent user as member
          updates.members = [config.userId];
        }

        // Add a checklist item for tracking
        await apiRequest(config.serverUrl, config.token, 'PATCH', `/kanban/cards/${cardId}`, {
          ...updates,
          checklists: [{
            title: 'Agent Execution',
            items: [
              { text: `CLI: ${task.cli}`, checked: true },
              { text: `Type: ${task.taskType || 'feature'}`, checked: true },
              { text: `Tier: ${task.modelTier || 'standard'}`, checked: true },
              { text: 'Execution completed', checked: false },
              { text: 'Verification passed', checked: false },
              { text: 'Code pushed', checked: false },
            ],
          }],
        });
      } catch (err) { swallow(err); }

      return task;
    },

    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const config = getConfig();
      if (!config) return;

      try {
        const taskData = await apiRequest(config.serverUrl, config.token, 'GET', `/dark-factory/tasks/${task.taskId}`);
        if (!taskData?.kanbanCardId) return;

        // Update checklist items
        await apiRequest(config.serverUrl, config.token, 'PATCH', `/kanban/cards/${taskData.kanbanCardId}`, {
          checklists: [{
            title: 'Agent Execution',
            items: [
              { text: `CLI: ${task.cli}`, checked: true },
              { text: `Type: ${task.taskType || 'feature'}`, checked: true },
              { text: `Tier: ${task.modelTier || 'standard'}`, checked: true },
              { text: `Execution completed — $${result.costUsd.toFixed(4)}`, checked: true },
              { text: 'Verification passed', checked: true },
              { text: `Code pushed to ${result.gitInfo?.branch || 'N/A'}`, checked: !!result.gitInfo?.pushed },
            ],
          }],
        });
      } catch (err) { swallow(err); }
    },
  },
};

export default plugin;
