import { swallow } from '../utils/log';
/**
 * plugin-gitlab — GitLab integration for issues and merge requests.
 * Auto-comments on GitLab issues when tasks complete.
 *
 * Config: MAKESTUDIO_GITLAB_TOKEN + MAKESTUDIO_GITLAB_URL (default: https://gitlab.com)
 * Or plugins.gitlab.{token, url}
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface GitLabConfig { token: string; url: string; projectId?: string; }

function getConfig(): GitLabConfig | null {
  const token = process.env.MAKESTUDIO_GITLAB_TOKEN;
  const url = process.env.MAKESTUDIO_GITLAB_URL || 'https://gitlab.com';

  if (token) return { token, url };

  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const gl = config.plugins?.gitlab;
      if (gl?.token) return { token: gl.token, url: gl.url || 'https://gitlab.com', projectId: gl.projectId };
    }
  } catch (err) { swallow(err); }
  return null;
}

function getProjectPath(): string | null {
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', {
      encoding: 'utf8', stdio: 'pipe',
    }).trim();

    // gitlab.com:user/repo.git or https://gitlab.com/user/repo.git
    const match = remote.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
    if (match) return encodeURIComponent(match[1]);
  } catch (err) { swallow(err); }
  return null;
}

async function gitlabApi(config: GitLabConfig, method: string, apiPath: string, body?: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(config.url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const bodyStr = body ? JSON.stringify(body) : '';

      const req = transport.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: `/api/v4${apiPath}`,
        method,
        headers: {
          'PRIVATE-TOKEN': config.token,
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
  name: 'gitlab',
  version: '1.0.0',
  description: 'GitLab integration — auto-comment on issues and create merge requests',

  async onLoad(ctx: PluginContext) {
    if (getConfig()) {
      ctx.logger.info('GitLab integration configured');
    } else {
      ctx.logger.warning('GitLab not configured — set MAKESTUDIO_GITLAB_TOKEN');
    }
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const config = getConfig();
      if (!config) return;

      const projectPath = config.projectId || getProjectPath();
      if (!projectPath) return;

      // Extract issue number from branch (e.g., fix/123-description or feature/issue-42)
      const branch = result.gitInfo?.branch || '';
      const issueMatch = branch.match(/(?:fix|close|resolve|issue)[/-](\d+)/i)
        || branch.match(/[/-]#?(\d+)(?:[/-]|$)/);

      if (issueMatch) {
        const issueId = issueMatch[1];
        const comment = [
          `### Task Completed`,
          '',
          `**${task.taskTitle || task.taskId}**`,
          `- Type: \`${task.taskType || 'unknown'}\``,
          `- Branch: \`${branch}\``,
          `- Cost: $${result.costUsd.toFixed(4)}`,
          result.gitInfo?.pushed ? '- Status: Pushed to remote' : '',
        ].filter(Boolean).join('\n');

        await gitlabApi(config, 'POST', `/projects/${projectPath}/issues/${issueId}/notes`, { body: comment });
      }

      // Create MR if pushed
      if (result.gitInfo?.pushed && result.gitInfo?.branch) {
        // Check if MR already exists
        const mrs = await gitlabApi(config, 'GET',
          `/projects/${projectPath}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`);

        if (!mrs?.length) {
          // Create MR
          await gitlabApi(config, 'POST', `/projects/${projectPath}/merge_requests`, {
            source_branch: branch,
            target_branch: 'develop',
            title: `${task.taskTitle || task.taskId}`,
            description: `Auto-created by MakeStudio Agent\n\n- Task: ${task.taskType || 'feature'}\n- Cost: $${result.costUsd.toFixed(4)}`,
            remove_source_branch: true,
          });
        }
      }
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      const config = getConfig();
      if (!config) return 'fail';

      const projectPath = config.projectId || getProjectPath();
      if (!projectPath) return 'fail';

      const branch = task.taskBranch || '';
      const issueMatch = branch.match(/(?:fix|close|resolve|issue)[/-](\d+)/i);
      if (issueMatch) {
        await gitlabApi(config, 'POST', `/projects/${projectPath}/issues/${issueMatch[1]}/notes`, {
          body: `Task failed: ${error.message.substring(0, 300)}`,
        });
      }

      return 'fail';
    },
  },
};

export default plugin;
