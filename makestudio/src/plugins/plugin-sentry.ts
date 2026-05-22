import { swallow } from '../utils/log';
/**
 * plugin-sentry — Injects recent Sentry errors as context for the AI CLI.
 *
 * Configuration:
 *   MAKESTUDIO_SENTRY_DSN — Sentry API auth token
 *   MAKESTUDIO_SENTRY_ORG — Organization slug
 *   MAKESTUDIO_SENTRY_PROJECT — Project slug
 *
 * Or in ~/.makestudio/config.json:
 *   { "plugins": { "sentry": { "authToken": "...", "org": "...", "project": "..." } } }
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

interface SentryConfig {
  authToken: string;
  org: string;
  project: string;
}

function getSentryConfig(): SentryConfig | null {
  // Env vars
  const authToken = process.env.MAKESTUDIO_SENTRY_TOKEN;
  const org = process.env.MAKESTUDIO_SENTRY_ORG;
  const project = process.env.MAKESTUDIO_SENTRY_PROJECT;

  if (authToken && org && project) {
    return { authToken, org, project };
  }

  // Config file
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const sentry = config.plugins?.sentry;
      if (sentry?.authToken && sentry?.org && sentry?.project) {
        return sentry;
      }
    }
  } catch (err) { swallow(err); }

  return null;
}

async function fetchSentryIssues(config: SentryConfig, limit: number = 15): Promise<any[]> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'sentry.io',
      path: `/api/0/projects/${config.org}/${config.project}/issues/?query=is:unresolved&sort=date&limit=${limit}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.authToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

const plugin: MakeStudioPlugin = {
  name: 'sentry',
  version: '1.0.0',
  description: 'Inject recent Sentry errors as context for AI analysis',

  async onLoad(ctx: PluginContext) {
    const config = getSentryConfig();
    if (config) {
      ctx.logger.info(`Sentry configured for ${config.org}/${config.project}`);
    } else {
      ctx.logger.warning('Sentry not configured — set MAKESTUDIO_SENTRY_TOKEN, MAKESTUDIO_SENTRY_ORG, MAKESTUDIO_SENTRY_PROJECT');
    }
  },

  contextProviders: [
    {
      name: 'sentry-errors',
      fileName: 'sentry-errors.md',

      async generate(): Promise<string | null> {
        const config = getSentryConfig();
        if (!config) return null;

        const issues = await fetchSentryIssues(config);
        if (!issues.length) return null;

        const lines: string[] = [
          '# Recent Sentry Errors (Unresolved)',
          '',
          `> Last ${issues.length} unresolved issues from ${config.org}/${config.project}`,
          '',
        ];

        for (const issue of issues) {
          lines.push(`## [${issue.shortId || issue.id}] ${issue.title}`);
          lines.push(`- **Level:** ${issue.level || 'error'}`);
          lines.push(`- **Events:** ${issue.count || 0}`);
          lines.push(`- **Users Affected:** ${issue.userCount || 0}`);
          lines.push(`- **First Seen:** ${issue.firstSeen || 'unknown'}`);
          lines.push(`- **Last Seen:** ${issue.lastSeen || 'unknown'}`);
          if (issue.culprit) {
            lines.push(`- **Culprit:** \`${issue.culprit}\``);
          }
          if (issue.metadata?.value) {
            lines.push(`- **Message:** ${issue.metadata.value}`);
          }
          lines.push('');
        }

        lines.push('---');
        lines.push('*Consider fixing these errors if they relate to the current task.*');

        return lines.join('\n');
      },
    },
  ],
};

export default plugin;
