import { swallow } from '../utils/log';
/**
 * plugin-github-issues — Auto-comments/closes GitHub issues when tasks complete.
 * Extracts issue number from branch name (e.g., fix/123-bug-description).
 * Config: MAKESTUDIO_GITHUB_TOKEN or plugins.github.token
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface GitHubConfig { token: string; owner: string; repo: string; }

function getConfig(repoPath?: string): GitHubConfig | null {
  const token = process.env.MAKESTUDIO_GITHUB_TOKEN;
  if (!token) {
    try {
      const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.plugins?.github?.token) return null;
      }
    } catch { return null; }
  }

  // Extract owner/repo from git remote
  let owner = '', repo = '';
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', {
      cwd: repoPath || process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      owner = match[1];
      repo = match[2];
    }
  } catch (err) { swallow(err); }

  if (!owner || !repo) return null;

  return { token: token || '', owner, repo };
}

async function githubRequest(config: GitHubConfig, method: string, apiPath: string, body?: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const bodyStr = body ? JSON.stringify(body) : '';
      const req = https.request({
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          'User-Agent': 'MakeStudio-Agent/1.0',
          Accept: 'application/vnd.github+json',
          ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
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
  name: 'github-issues',
  version: '1.0.0',
  description: 'Auto-comment on GitHub issues when related tasks complete',

  async onLoad(ctx: PluginContext) {
    if (process.env.MAKESTUDIO_GITHUB_TOKEN) {
      ctx.logger.info('GitHub issues integration configured');
    } else {
      ctx.logger.warning('GitHub not configured — set MAKESTUDIO_GITHUB_TOKEN');
    }
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const config = getConfig();
      if (!config) return;

      // Extract issue number from branch name
      const branch = result.gitInfo?.branch || '';
      const issueMatch = branch.match(/(?:fix|close|resolve|issue)[/-](\d+)/i)
        || branch.match(/[/-]#?(\d+)(?:[/-]|$)/);

      if (!issueMatch) return;

      const issueNumber = issueMatch[1];
      const comment = [
        `### Task Completed`,
        '',
        `**${task.taskTitle || task.taskId}**`,
        `- Type: \`${task.taskType || 'unknown'}\``,
        `- Branch: \`${branch}\``,
        `- Cost: $${result.costUsd.toFixed(4)}`,
        result.gitInfo?.pushed ? '- Status: Pushed to remote' : '',
      ].filter(Boolean).join('\n');

      // Add comment to issue
      await githubRequest(
        config,
        'POST',
        `/repos/${config.owner}/${config.repo}/issues/${issueNumber}/comments`,
        { body: comment },
      );
    },
  },
};

export default plugin;
