import { swallow } from '../utils/log';
/**
 * plugin-jira — Creates/updates JIRA tickets on task completion.
 * Config: plugins.jira.baseUrl, plugins.jira.email, plugins.jira.apiToken, plugins.jira.projectKey
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface JiraConfig { baseUrl: string; email: string; apiToken: string; projectKey: string; }

function getConfig(): JiraConfig | null {
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const jira = config.plugins?.jira;
      if (jira?.baseUrl && jira?.email && jira?.apiToken && jira?.projectKey) return jira;
    }
  } catch (err) { swallow(err); }
  return null;
}

async function jiraRequest(config: JiraConfig, method: string, apiPath: string, body?: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(config.baseUrl);
      const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
      const bodyStr = body ? JSON.stringify(body) : '';

      const req = https.request({
        hostname: parsedUrl.hostname,
        path: `/rest/api/3${apiPath}`,
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
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
  name: 'jira',
  version: '1.0.0',
  description: 'Create/update JIRA tickets on task completion',

  async onLoad(ctx: PluginContext) {
    if (getConfig()) {
      ctx.logger.info('JIRA integration configured');
    } else {
      ctx.logger.warning('JIRA not configured — set plugins.jira in config.json');
    }
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const config = getConfig();
      if (!config) return;

      // Extract JIRA ticket from branch name (e.g., feature/PROJ-123-description)
      const ticketMatch = result.gitInfo?.branch?.match(/([A-Z]+-\d+)/);

      if (ticketMatch) {
        // Add comment to existing ticket
        const ticketId = ticketMatch[1];
        await jiraRequest(config, 'POST', `/issue/${ticketId}/comment`, {
          body: {
            type: 'doc', version: 1,
            content: [{
              type: 'paragraph',
              content: [{
                type: 'text',
                text: `MakeStudio task completed: ${task.taskTitle || task.taskId}\nCost: $${result.costUsd.toFixed(4)}\nBranch: ${result.gitInfo?.branch || 'N/A'}`,
              }],
            }],
          },
        });
      }
    },
  },
};

export default plugin;
