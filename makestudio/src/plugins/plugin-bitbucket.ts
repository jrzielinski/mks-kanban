import { swallow } from '../utils/log';
/**
 * plugin-bitbucket — Bitbucket integration for issues and pull requests.
 * Auto-comments on Bitbucket issues and creates PRs when tasks complete.
 *
 * Config: MAKESTUDIO_BITBUCKET_USER + MAKESTUDIO_BITBUCKET_APP_PASSWORD
 * Or plugins.bitbucket.{username, appPassword, workspace, repo}
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface BitbucketConfig {
  username: string;
  appPassword: string;
  workspace?: string;
  repo?: string;
}

function getConfig(): BitbucketConfig | null {
  const username = process.env.MAKESTUDIO_BITBUCKET_USER;
  const appPassword = process.env.MAKESTUDIO_BITBUCKET_APP_PASSWORD;
  if (username && appPassword) return { username, appPassword };

  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const bb = config.plugins?.bitbucket;
      if (bb?.username && bb?.appPassword) return bb;
    }
  } catch (err) { swallow(err); }
  return null;
}

function getRepoInfo(): { workspace: string; repo: string } | null {
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', {
      encoding: 'utf8', stdio: 'pipe',
    }).trim();

    // bitbucket.org:workspace/repo.git or https://bitbucket.org/workspace/repo.git
    const match = remote.match(/bitbucket\.org[:/]([^/]+)\/([^/.]+)/);
    if (match) return { workspace: match[1], repo: match[2] };
  } catch (err) { swallow(err); }
  return null;
}

async function bitbucketApi(config: BitbucketConfig, method: string, apiPath: string, body?: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const auth = Buffer.from(`${config.username}:${config.appPassword}`).toString('base64');
      const bodyStr = body ? JSON.stringify(body) : '';

      const req = https.request({
        hostname: 'api.bitbucket.org',
        path: `/2.0${apiPath}`,
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
  name: 'bitbucket',
  version: '1.0.0',
  description: 'Bitbucket integration — auto-comment on issues and create pull requests',

  async onLoad(ctx: PluginContext) {
    if (getConfig()) {
      ctx.logger.info('Bitbucket integration configured');
    } else {
      ctx.logger.warning('Bitbucket not configured — set MAKESTUDIO_BITBUCKET_USER + MAKESTUDIO_BITBUCKET_APP_PASSWORD');
    }
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const config = getConfig();
      if (!config) return;

      const repoInfo = config.workspace && config.repo
        ? { workspace: config.workspace, repo: config.repo }
        : getRepoInfo();

      if (!repoInfo) return;
      const { workspace, repo } = repoInfo;

      // Extract issue number from branch
      const branch = result.gitInfo?.branch || '';
      const issueMatch = branch.match(/(?:fix|close|resolve|issue)[/-](\d+)/i)
        || branch.match(/[/-]#?(\d+)(?:[/-]|$)/);

      if (issueMatch) {
        const issueId = issueMatch[1];
        const comment = [
          `**Task Completed**`,
          '',
          `${task.taskTitle || task.taskId}`,
          `- Type: \`${task.taskType || 'unknown'}\``,
          `- Branch: \`${branch}\``,
          `- Cost: $${result.costUsd.toFixed(4)}`,
        ].join('\n');

        await bitbucketApi(config, 'POST',
          `/repositories/${workspace}/${repo}/issues/${issueId}/comments`,
          { content: { raw: comment } },
        );
      }

      // Create PR if pushed
      if (result.gitInfo?.pushed && branch) {
        // Check if PR already exists
        const prs = await bitbucketApi(config, 'GET',
          `/repositories/${workspace}/${repo}/pullrequests?q=source.branch.name="${encodeURIComponent(branch)}"&state=OPEN`);

        if (!prs?.values?.length) {
          await bitbucketApi(config, 'POST', `/repositories/${workspace}/${repo}/pullrequests`, {
            title: task.taskTitle || task.taskId,
            description: `Auto-created by MakeStudio Agent\n\n- Task: ${task.taskType || 'feature'}\n- Cost: $${result.costUsd.toFixed(4)}`,
            source: { branch: { name: branch } },
            destination: { branch: { name: 'develop' } },
            close_source_branch: true,
          });
        }
      }
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      const config = getConfig();
      if (!config) return 'fail';

      const repoInfo = config.workspace && config.repo
        ? { workspace: config.workspace, repo: config.repo }
        : getRepoInfo();

      if (!repoInfo) return 'fail';

      const branch = task.taskBranch || '';
      const issueMatch = branch.match(/(?:fix|close|resolve|issue)[/-](\d+)/i);
      if (issueMatch) {
        await bitbucketApi(config, 'POST',
          `/repositories/${repoInfo.workspace}/${repoInfo.repo}/issues/${issueMatch[1]}/comments`,
          { content: { raw: `Task failed: ${error.message.substring(0, 300)}` } },
        );
      }

      return 'fail';
    },
  },
};

export default plugin;
