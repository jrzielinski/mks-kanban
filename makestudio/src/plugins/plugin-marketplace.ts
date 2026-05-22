/**
 * plugin-marketplace — Search and discover MakeStudio plugins on npm.
 * Adds `makestudio plugin search <query>` command.
 */

import * as https from 'https';
import { MakeStudioPlugin } from '../core/plugin-types';

async function searchNpm(query: string): Promise<any[]> {
  return new Promise((resolve) => {
    const searchQuery = encodeURIComponent(`makestudio-plugin ${query}`);
    const req = https.request({
      hostname: 'registry.npmjs.org',
      path: `/-/v1/search?text=${searchQuery}&size=20`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: 15_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.objects || []);
        } catch { resolve([]); }
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

const plugin: MakeStudioPlugin = {
  name: 'marketplace',
  version: '1.0.0',
  description: 'Search and discover MakeStudio plugins on npm',

  commands: [
    {
      name: 'search',
      description: 'Search for MakeStudio plugins on npm registry',
      options: [
        { flags: '-q, --query <text>', description: 'Search query' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const query = options.query || '';

        if (!query) {
          console.log(chalk.dim('Usage: makestudio search --query <text>'));
          console.log(chalk.dim('Example: makestudio search --query "eslint"'));
          return;
        }

        console.log(chalk.cyan(`Searching npm for "${query}"...\n`));
        const results = await searchNpm(query);

        if (results.length === 0) {
          console.log(chalk.dim('No plugins found'));
          return;
        }

        for (const result of results) {
          const pkg = result.package;
          const score = result.score?.final ? `(score: ${(result.score.final * 100).toFixed(0)}%)` : '';

          console.log(`  ${chalk.bold(pkg.name)} ${chalk.dim(`v${pkg.version}`)} ${chalk.dim(score)}`);
          if (pkg.description) {
            console.log(`  ${chalk.dim(pkg.description)}`);
          }
          console.log(`  ${chalk.cyan(`makestudio plugin install ${pkg.name}`)}`);
          console.log();
        }
      },
    },
  ],
};

export default plugin;
