import { swallow } from '../utils/log';
/**
 * plugin-kanban-wip-alert — Alerts when WIP (Work In Progress) limits are exceeded.
 * Checks board lists with WIP limits before starting new tasks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch } from '../types';

function getConfig(): { serverUrl: string; token: string } | null {
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

async function apiGet(serverUrl: string, token: string, apiPath: string): Promise<any> {
  return new Promise((resolve) => {
    try {
      const url = new URL(serverUrl);
      const transport = url.protocol === 'https:' ? https : http;

      const req = transport.request({
        hostname: url.hostname,
        port: url.port,
        path: `/api/v1${apiPath}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
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
      req.end();
    } catch { resolve(null); }
  });
}

const plugin: MakeStudioPlugin = {
  name: 'kanban-wip-alert',
  version: '1.0.0',
  description: 'Alert when Kanban WIP (Work In Progress) limits are exceeded',

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      const config = getConfig();
      if (!config) return task;

      try {
        // Check if associated task has a kanban card
        const taskData = await apiGet(config.serverUrl, config.token, `/dark-factory/tasks/${task.taskId}`);
        if (!taskData?.kanbanCardId || !taskData?.project?.kanbanBoardId) return task;

        const boardId = taskData.project.kanbanBoardId;

        // Get board with lists to check WIP limits
        const board = await apiGet(config.serverUrl, config.token, `/kanban/boards/${boardId}`);
        if (!board?.lists) return task;

        // Find "In Progress" list and check WIP limit
        const inProgressList = board.lists.find((l: any) =>
          l.title?.toLowerCase().includes('andamento') || l.title?.toLowerCase().includes('progress'),
        );

        if (inProgressList?.wipLimit && inProgressList.cards) {
          const currentWIP = inProgressList.cards.length;
          if (currentWIP >= inProgressList.wipLimit) {
            const { logWarning } = await import('../ui/terminal');
            logWarning(`[kanban-wip] WIP limit reached! ${currentWIP}/${inProgressList.wipLimit} cards in "${inProgressList.title}". Consider completing existing tasks first.`);
          }
        }
      } catch (err) { swallow(err); }

      return task;
    },
  },
};

export default plugin;
