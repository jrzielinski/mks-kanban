import { swallow } from '../utils/log';
/**
 * plugin-ci-status — Checks CI status of base branch before allowing push.
 * Supports GitHub Actions via GitHub API.
 */

import * as https from 'https';
import { execSync } from 'child_process';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

function getGitHubToken(): string | null {
  return process.env.MAKESTUDIO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || null;
}

function getRepoInfo(): { owner: string; repo: string } | null {
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', {
      encoding: 'utf8', stdio: 'pipe',
    }).trim();

    const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) return { owner: match[1], repo: match[2] };
  } catch (err) { swallow(err); }
  return null;
}

async function checkCIStatus(token: string, owner: string, repo: string, branch: string): Promise<{ state: string; checks: number }> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/commits/${branch}/status`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'MakeStudio-Agent/1.0',
        Accept: 'application/vnd.github+json',
      },
      timeout: 15_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            state: parsed.state || 'unknown',
            checks: parsed.total_count || 0,
          });
        } catch { resolve({ state: 'unknown', checks: 0 }); }
      });
    });

    req.on('error', () => resolve({ state: 'unknown', checks: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ state: 'unknown', checks: 0 }); });
    req.end();
  });
}

const plugin: MakeStudioPlugin = {
  name: 'ci-status',
  version: '1.0.0',
  description: 'Check CI status of base branch before push',

  hooks: {
    async beforeGitPush(info: { repoPath: string; branch: string; taskId: string }): Promise<boolean> {
      const token = getGitHubToken();
      if (!token) return true; // No token — allow push

      const repoInfo = getRepoInfo();
      if (!repoInfo) return true;

      // Check CI status of develop branch
      const baseBranch = 'develop';
      const status = await checkCIStatus(token, repoInfo.owner, repoInfo.repo, baseBranch);

      if (status.state === 'failure') {
        const { logWarning } = await import('../ui/terminal');
        logWarning(`[ci-status] Base branch "${baseBranch}" CI is FAILING (${status.checks} check(s)). Push allowed but beware.`);
        // Warn but don't block
        return true;
      }

      if (status.state === 'pending') {
        const { logInfo } = await import('../ui/terminal');
        logInfo(`[ci-status] Base branch "${baseBranch}" CI is pending (${status.checks} check(s))`);
      }

      return true;
    },
  },
};

export default plugin;
