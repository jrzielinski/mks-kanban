import { swallow } from '../utils/log';
/**
 * plugin-webhook — Generic webhook plugin. Sends POST to configurable URLs.
 *
 * Config in plugins.webhook:
 *   {
 *     "url": "https://example.com/hook",
 *     "headers": { "X-Custom": "value" },
 *     "events": ["afterTaskExec", "onError"]
 *   }
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  events?: string[];
}

function getConfig(): WebhookConfig | null {
  const envUrl = process.env.MAKESTUDIO_WEBHOOK_URL;
  if (envUrl) return { url: envUrl };

  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const wh = config.plugins?.webhook;
      if (wh?.url) return wh;
    }
  } catch (err) { swallow(err); }
  return null;
}

function shouldFire(event: string): boolean {
  const config = getConfig();
  if (!config) return false;
  if (!config.events || config.events.length === 0) return true; // Fire all events
  return config.events.includes(event);
}

async function sendWebhook(event: string, payload: Record<string, any>): Promise<void> {
  const config = getConfig();
  if (!config) return;

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(config.url);
      const body = JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload });
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'User-Agent': 'MakeStudio-Agent/1.0',
          ...(config.headers || {}),
        },
        timeout: 10_000,
      }, () => resolve());

      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    } catch { resolve(); }
  });
}

const plugin: MakeStudioPlugin = {
  name: 'webhook',
  version: '1.0.0',
  description: 'Generic webhook — sends POST to configurable URL on task events',

  async onLoad(ctx: PluginContext) {
    const config = getConfig();
    if (config) {
      ctx.logger.info(`Webhook configured: ${config.url}`);
    } else {
      ctx.logger.warning('Webhook not configured — set MAKESTUDIO_WEBHOOK_URL or plugins.webhook.url');
    }
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      if (shouldFire('beforeTaskExec')) {
        await sendWebhook('beforeTaskExec', {
          taskId: task.taskId, taskTitle: task.taskTitle,
          taskType: task.taskType, cli: task.cli,
        });
      }
      return task;
    },

    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      if (shouldFire('afterTaskExec')) {
        await sendWebhook('afterTaskExec', {
          taskId: task.taskId, taskTitle: task.taskTitle,
          taskType: task.taskType, costUsd: result.costUsd,
          branch: result.gitInfo?.branch, pushed: result.gitInfo?.pushed,
        });
      }
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      if (shouldFire('onError')) {
        await sendWebhook('onError', {
          taskId: task.taskId, taskTitle: task.taskTitle,
          error: error.message.substring(0, 500),
        });
      }
      return 'fail';
    },

    async beforeGitPush(info: { repoPath: string; branch: string; taskId: string }): Promise<boolean> {
      if (shouldFire('beforeGitPush')) {
        await sendWebhook('beforeGitPush', info);
      }
      return true;
    },
  },
};

export default plugin;
