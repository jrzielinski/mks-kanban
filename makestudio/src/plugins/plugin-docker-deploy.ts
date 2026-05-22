import { swallow } from '../utils/log';
/**
 * plugin-docker-deploy — Adds `makestudio deploy` command for Docker-based deployments.
 *
 * Supports:
 *   makestudio deploy --env dev --fast      (fast deploy without rebuild)
 *   makestudio deploy --env dev --migrate   (with database migrations)
 *   makestudio deploy --env production      (production deploy)
 *
 * Configuration in .makestudio/deploy.json in the repo:
 *   {
 *     "dev": { "script": "./deploy-scripts/deploy-backend-dev.sh" },
 *     "production": { "script": "./deploy-scripts/deploy-backend-production.sh" }
 *   }
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

interface DeployConfig {
  [env: string]: {
    script: string;
    defaultArgs?: string[];
  };
}

function loadDeployConfig(repoPath?: string): DeployConfig | null {
  const searchPaths = [
    repoPath ? path.join(repoPath, '.makestudio', 'deploy.json') : null,
    path.join(process.cwd(), '.makestudio', 'deploy.json'),
  ].filter(Boolean) as string[];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (err) { swallow(err); }
    }
  }

  return null;
}

const plugin: MakeStudioPlugin = {
  name: 'docker-deploy',
  version: '1.0.0',
  description: 'Docker-based deployment command for MakeStudio projects',

  commands: [
    {
      name: 'deploy',
      description: 'Deploy project using configured deploy scripts',
      options: [
        { flags: '-e, --env <environment>', description: 'Target environment (dev, staging, production)' },
        { flags: '--fast', description: 'Fast deploy — code only, no container rebuild' },
        { flags: '--migrate', description: 'Run database migrations during deploy' },
        { flags: '--dry-run', description: 'Show what would be executed without running' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const env = options.env || 'dev';
        const fast = options.fast || false;
        const migrate = options.migrate || false;
        const dryRun = options.dryRun || false;

        const config = loadDeployConfig();
        if (!config) {
          console.log(chalk.red('No deploy configuration found.'));
          console.log(chalk.dim('Create .makestudio/deploy.json with your deploy scripts.'));
          console.log(chalk.dim('Example:'));
          console.log(chalk.cyan(JSON.stringify({
            dev: { script: './deploy-scripts/deploy-backend-dev.sh' },
            production: { script: './deploy-scripts/deploy-backend-production.sh' },
          }, null, 2)));
          return;
        }

        const envConfig = config[env];
        if (!envConfig) {
          console.log(chalk.red(`No deploy configuration for environment: ${env}`));
          console.log(chalk.dim(`Available environments: ${Object.keys(config).join(', ')}`));
          return;
        }

        // Build command
        const args: string[] = [...(envConfig.defaultArgs || [])];
        if (fast) args.push('fast');
        if (migrate) args.push('migrate');

        const command = `${envConfig.script} ${args.join(' ')}`.trim();

        if (dryRun) {
          console.log(chalk.cyan('Dry run — would execute:'));
          console.log(chalk.bold(`  ${command}`));
          console.log(chalk.dim(`  Environment: ${env}`));
          console.log(chalk.dim(`  Fast: ${fast}`));
          console.log(chalk.dim(`  Migrate: ${migrate}`));
          return;
        }

        console.log(chalk.cyan(`Deploying to ${env}...`));
        console.log(chalk.dim(`  Command: ${command}`));
        console.log();

        try {
          execSync(command, {
            stdio: 'inherit',
            cwd: process.cwd(),
            timeout: 600_000, // 10 minutes
          });
          console.log();
          console.log(chalk.green(`✓ Deploy to ${env} completed successfully`));
        } catch (err: any) {
          console.log();
          console.log(chalk.red(`✗ Deploy to ${env} failed`));
          console.log(chalk.dim(err.message?.substring(0, 200) || 'Unknown error'));
          process.exitCode = 1;
        }
      },
    },
  ],
};

export default plugin;
