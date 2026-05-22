import { swallow } from '../utils/log';
/**
 * plugin-cron — Schedule recurring tasks (audit, dependency update, etc.).
 * Adds `makestudio cron` command for managing scheduled jobs.
 *
 * Stores schedule in ~/.makestudio/cron.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

interface CronJob {
  id: string;
  name: string;
  command: string;     // MakeStudio command to run (e.g., "analyze --audit")
  schedule: string;    // Cron expression (simple: 'daily', 'weekly', 'monthly', or 'Xh' for every X hours)
  lastRun?: string;
  enabled: boolean;
}

interface CronData { jobs: CronJob[]; }

const cronPath = path.join(os.homedir(), '.makestudio', 'cron.json');

function loadCron(): CronData {
  try {
    if (fs.existsSync(cronPath)) return JSON.parse(fs.readFileSync(cronPath, 'utf8'));
  } catch (err) { swallow(err); }
  return { jobs: [] };
}

function saveCron(data: CronData): void {
  try {
    fs.mkdirSync(path.dirname(cronPath), { recursive: true });
    fs.writeFileSync(cronPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

function getIntervalMs(schedule: string): number {
  if (schedule === 'daily') return 24 * 60 * 60 * 1000;
  if (schedule === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  if (schedule === 'monthly') return 30 * 24 * 60 * 60 * 1000;
  const hourMatch = schedule.match(/^(\d+)h$/);
  if (hourMatch) return parseInt(hourMatch[1]) * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000; // Default: daily
}

function isDue(job: CronJob): boolean {
  if (!job.enabled) return false;
  if (!job.lastRun) return true;

  const lastRun = new Date(job.lastRun).getTime();
  const interval = getIntervalMs(job.schedule);
  return Date.now() - lastRun >= interval;
}

const plugin: MakeStudioPlugin = {
  name: 'cron',
  version: '1.0.0',
  description: 'Schedule recurring MakeStudio tasks',

  commands: [
    {
      name: 'cron',
      description: 'Manage scheduled recurring tasks',
      options: [
        { flags: '-a, --add <name>', description: 'Add a new cron job' },
        { flags: '-c, --command <cmd>', description: 'Command to run (e.g., "analyze --audit")' },
        { flags: '-s, --schedule <expr>', description: 'Schedule: daily, weekly, monthly, or Xh (e.g., 6h)' },
        { flags: '-r, --remove <id>', description: 'Remove a cron job by ID' },
        { flags: '--run', description: 'Run all due cron jobs now' },
        { flags: '--list', description: 'List all cron jobs' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const { execSync } = await import('child_process');
        const data = loadCron();

        if (options.add && options.command && options.schedule) {
          const id = `cron_${Date.now().toString(36)}`;
          data.jobs.push({
            id,
            name: options.add,
            command: options.command,
            schedule: options.schedule,
            enabled: true,
          });
          saveCron(data);
          console.log(chalk.green(`✓ Cron job added: ${options.add} (${options.schedule})`));
          console.log(chalk.dim(`  ID: ${id}`));
          console.log(chalk.dim(`  Command: makestudio ${options.command}`));
          return;
        }

        if (options.remove) {
          data.jobs = data.jobs.filter(j => j.id !== options.remove);
          saveCron(data);
          console.log(chalk.green(`✓ Cron job removed: ${options.remove}`));
          return;
        }

        if (options.run) {
          const dueJobs = data.jobs.filter(isDue);
          if (dueJobs.length === 0) {
            console.log(chalk.dim('No cron jobs due'));
            return;
          }

          for (const job of dueJobs) {
            console.log(chalk.cyan(`Running: ${job.name} → makestudio ${job.command}`));
            try {
              execSync(`makestudio ${job.command}`, { stdio: 'inherit', timeout: 600_000 });
              job.lastRun = new Date().toISOString();
              console.log(chalk.green(`✓ ${job.name} completed`));
            } catch (err: any) {
              console.log(chalk.red(`✗ ${job.name} failed: ${err.message?.substring(0, 100)}`));
              job.lastRun = new Date().toISOString(); // Still mark as run to prevent retry loops
            }
          }
          saveCron(data);
          return;
        }

        // Default: list
        if (data.jobs.length === 0) {
          console.log(chalk.dim('No cron jobs configured'));
          console.log(chalk.dim('Add one: makestudio cron --add "Weekly Audit" --command "analyze --audit" --schedule weekly'));
          return;
        }

        console.log(chalk.bold(`Cron Jobs (${data.jobs.length}):`));
        for (const job of data.jobs) {
          const status = job.enabled ? chalk.green('●') : chalk.hex('#64748B')('○');
          const due = isDue(job) ? chalk.yellow(' [DUE]') : '';
          console.log(`  ${status} ${chalk.bold(job.name)}${due}`);
          console.log(`    ${chalk.dim(`ID: ${job.id} | Schedule: ${job.schedule} | Command: makestudio ${job.command}`)}`);
          console.log(`    ${chalk.dim(`Last run: ${job.lastRun || 'never'}`)}`);
        }
      },
    },
  ],
};

export default plugin;
