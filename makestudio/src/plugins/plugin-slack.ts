import { swallow } from '../utils/log';
/**
 * plugin-slack — Sends Slack notifications on task completion/failure.
 *
 * Configuration: Set MAKESTUDIO_SLACK_WEBHOOK_URL environment variable
 * or add to ~/.makestudio/config.json:
 *   { "plugins": { "slack": { "webhookUrl": "https://hooks.slack.com/..." } } }
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

let webhookUrl: string | null = null;

function getWebhookUrl(): string | null {
  if (webhookUrl) return webhookUrl;

  // Try env var first
  const envUrl = process.env.MAKESTUDIO_SLACK_WEBHOOK_URL;
  if (envUrl) {
    webhookUrl = envUrl;
    return webhookUrl;
  }

  // Try config.json
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      webhookUrl = config.plugins?.slack?.webhookUrl || null;
    }
  } catch (err) { swallow(err); }

  return webhookUrl;
}

async function sendSlackMessage(payload: Record<string, any>): Promise<void> {
  const url = getWebhookUrl();
  if (!url) return;

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const body = JSON.stringify(payload);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 10_000,
        },
        () => resolve(),
      );

      req.on('error', () => resolve()); // Non-fatal
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    } catch {
      resolve();
    }
  });
}

const plugin: MakeStudioPlugin = {
  name: 'slack',
  version: '1.0.0',
  description: 'Send Slack notifications on task completion or failure',

  async onLoad(ctx: PluginContext) {
    const url = getWebhookUrl();
    if (url) {
      ctx.logger.info(`Slack webhook configured`);
    } else {
      ctx.logger.warning('Slack webhook not configured — set MAKESTUDIO_SLACK_WEBHOOK_URL or plugins.slack.webhookUrl in config');
    }
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const costStr = result.costUsd > 0 ? ` | Cost: $${result.costUsd.toFixed(4)}` : '';
      const branchStr = result.gitInfo?.branch ? ` | Branch: \`${result.gitInfo.branch}\`` : '';
      const pushStr = result.gitInfo?.pushed ? ' | Pushed ✓' : '';

      await sendSlackMessage({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Task Completed* :white_check_mark:\n*${task.taskTitle || task.taskId}*\nType: \`${task.taskType || 'unknown'}\`${costStr}${branchStr}${pushStr}`,
            },
          },
        ],
      });
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      await sendSlackMessage({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Task Failed* :x:\n*${task.taskTitle || task.taskId}*\nType: \`${task.taskType || 'unknown'}\`\nError: \`${error.message.substring(0, 200)}\``,
            },
          },
        ],
      });

      return 'fail'; // Don't override default behavior
    },
  },
};

export default plugin;
