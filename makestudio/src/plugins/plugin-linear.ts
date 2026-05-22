import { swallow } from '../utils/log';
/**
 * plugin-linear — Updates Linear issues on task completion.
 * Config: MAKESTUDIO_LINEAR_API_KEY or plugins.linear.apiKey
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

function getApiKey(): string | null {
  const envKey = process.env.MAKESTUDIO_LINEAR_API_KEY;
  if (envKey) return envKey;

  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.plugins?.linear?.apiKey || null;
    }
  } catch (err) { swallow(err); }
  return null;
}

async function linearGraphQL(query: string, variables: Record<string, any>): Promise<any> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({ query, variables });
      const req = https.request({
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
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
      req.write(body);
      req.end();
    } catch { resolve(null); }
  });
}

const plugin: MakeStudioPlugin = {
  name: 'linear',
  version: '1.0.0',
  description: 'Update Linear issues on task completion',

  async onLoad(ctx: PluginContext) {
    if (getApiKey()) {
      ctx.logger.info('Linear API configured');
    } else {
      ctx.logger.warning('Linear not configured — set MAKESTUDIO_LINEAR_API_KEY');
    }
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      if (!getApiKey()) return;

      // Extract Linear issue ID from branch (e.g., feat/ENG-123-description)
      const issueMatch = result.gitInfo?.branch?.match(/([A-Z]+-\d+)/);
      if (!issueMatch) return;

      const issueId = issueMatch[1];
      const comment = `Task completed: ${task.taskTitle || task.taskId}\nCost: $${result.costUsd.toFixed(4)}\nBranch: \`${result.gitInfo?.branch}\``;

      // Add comment to the Linear issue
      await linearGraphQL(
        `mutation($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }`,
        { issueId, body: comment },
      );
    },
  },
};

export default plugin;
