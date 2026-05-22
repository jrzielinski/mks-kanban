import { swallow } from '../utils/log';
/**
 * plugin-telegram — Sends Telegram notifications via Bot API.
 * Config: MAKESTUDIO_TELEGRAM_BOT_TOKEN + MAKESTUDIO_TELEGRAM_CHAT_ID
 * Or plugins.telegram.botToken + plugins.telegram.chatId
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface TelegramConfig { botToken: string; chatId: string; }

function getConfig(): TelegramConfig | null {
  const botToken = process.env.MAKESTUDIO_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.MAKESTUDIO_TELEGRAM_CHAT_ID;
  if (botToken && chatId) return { botToken, chatId };

  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const tg = config.plugins?.telegram;
      if (tg?.botToken && tg?.chatId) return tg;
    }
  } catch (err) { swallow(err); }
  return null;
}

async function sendTelegramMessage(text: string): Promise<void> {
  const config = getConfig();
  if (!config) return;

  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'Markdown' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${config.botToken}/sendMessage`,
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
  name: 'telegram',
  version: '1.0.0',
  description: 'Send Telegram notifications on task events',

  async onLoad(ctx: PluginContext) {
    if (getConfig()) {
      ctx.logger.info('Telegram bot configured');
    } else {
      ctx.logger.warning('Telegram not configured — set MAKESTUDIO_TELEGRAM_BOT_TOKEN + MAKESTUDIO_TELEGRAM_CHAT_ID');
    }
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const cost = result.costUsd > 0 ? ` | $${result.costUsd.toFixed(4)}` : '';
      await sendTelegramMessage(
        `✅ *Task Completed*\n*${task.taskTitle || task.taskId}*\nType: \`${task.taskType}\`${cost}`,
      );
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      await sendTelegramMessage(
        `❌ *Task Failed*\n*${task.taskTitle || task.taskId}*\nError: \`${error.message.substring(0, 200)}\``,
      );
      return 'fail';
    },
  },
};

export default plugin;
