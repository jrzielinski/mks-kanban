import { swallow } from '../utils/log';
/**
 * plugin-discord — Sends Discord notifications via webhook.
 * Config: MAKESTUDIO_DISCORD_WEBHOOK_URL or plugins.discord.webhookUrl
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

let webhookUrl: string | null = null;

function getWebhookUrl(): string | null {
  if (webhookUrl) return webhookUrl;
  webhookUrl = process.env.MAKESTUDIO_DISCORD_WEBHOOK_URL || null;
  if (webhookUrl) return webhookUrl;

  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      webhookUrl = config.plugins?.discord?.webhookUrl || null;
    }
  } catch (err) { swallow(err); }
  return webhookUrl;
}

async function sendDiscordMessage(content: string, color: number): Promise<void> {
  const url = getWebhookUrl();
  if (!url) return;

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const body = JSON.stringify({
        embeds: [{ description: content, color }],
      });

      const req = https.request({
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
  name: 'discord',
  version: '1.0.0',
  description: 'Send Discord notifications on task events',

  async onLoad(ctx: PluginContext) {
    if (getWebhookUrl()) {
      ctx.logger.info('Discord webhook configured');
    } else {
      ctx.logger.warning('Discord webhook not configured — set MAKESTUDIO_DISCORD_WEBHOOK_URL');
    }
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const cost = result.costUsd > 0 ? ` | $${result.costUsd.toFixed(4)}` : '';
      const branch = result.gitInfo?.branch ? ` | \`${result.gitInfo.branch}\`` : '';
      await sendDiscordMessage(
        `✅ **Task Completed**: ${task.taskTitle || task.taskId}\nType: \`${task.taskType || 'unknown'}\`${cost}${branch}`,
        0x22c55e, // green
      );
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      await sendDiscordMessage(
        `❌ **Task Failed**: ${task.taskTitle || task.taskId}\nError: \`${error.message.substring(0, 200)}\``,
        0xef4444, // red
      );
      return 'fail';
    },
  },
};

export default plugin;
