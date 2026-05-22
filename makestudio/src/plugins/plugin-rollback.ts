/**
 * plugin-rollback — Quick rollback of the last task's changes.
 * Adds `makestudio rollback` command that reverts the last commit/push.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin } from '../core/plugin-types';

const MAKESTUDIO_HOME = path.join(os.homedir(), '.makestudio');

const plugin: MakeStudioPlugin = {
  name: 'rollback',
  version: '1.0.0',
  description: 'Quick rollback of the last task changes',

  commands: [
    {
      name: 'rollback',
      description: 'Revert the last task commit and optionally restore from backup',
      options: [
        { flags: '--hard', description: 'Hard reset (discard changes entirely)' },
        { flags: '--backup', description: 'Restore from backup plugin files' },
        { flags: '-r, --repo <path>', description: 'Repository path (default: current dir)' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const repoPath = options.repo || process.cwd();
        const isHard = !!options.hard;
        const useBackup = !!options.backup;

        try {
          // Show what will be reverted
          const lastCommit = execSync('git log --oneline -1', {
            cwd: repoPath, encoding: 'utf8', stdio: 'pipe',
          }).trim();

          console.log(chalk.yellow(`Last commit: ${lastCommit}`));

          if (isHard) {
            console.log(chalk.red('Hard reset — discarding commit...'));
            execSync('git reset --hard HEAD~1', { cwd: repoPath, stdio: 'inherit' });
            console.log(chalk.green('✓ Hard reset completed'));
          } else {
            console.log(chalk.cyan('Soft revert — creating revert commit...'));
            execSync('git revert HEAD --no-edit', { cwd: repoPath, stdio: 'inherit' });
            console.log(chalk.green('✓ Revert commit created'));
          }

          if (useBackup) {
            // Find latest backup
            const backupsDir = path.join(MAKESTUDIO_HOME, 'backups');
            if (fs.existsSync(backupsDir)) {
              const backups = fs.readdirSync(backupsDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => ({
                  name: e.name,
                  path: path.join(backupsDir, e.name),
                  mtime: fs.statSync(path.join(backupsDir, e.name)).mtime.getTime(),
                }))
                .sort((a, b) => b.mtime - a.mtime);

              if (backups.length > 0) {
                const latest = backups[0];
                console.log(chalk.cyan(`\nRestoring from backup: ${latest.name}`));

                const metaPath = path.join(latest.path, '.backup-meta.json');
                if (fs.existsSync(metaPath)) {
                  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                  console.log(chalk.dim(`  Task: ${meta.taskTitle || meta.taskId}`));
                  console.log(chalk.dim(`  Files: ${meta.filesBackedUp}`));
                }

                // Copy backup files back
                const copyBack = (src: string, dest: string) => {
                  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                    if (entry.name === '.backup-meta.json') continue;
                    const srcPath = path.join(src, entry.name);
                    const destPath = path.join(dest, entry.name);
                    if (entry.isDirectory()) {
                      fs.mkdirSync(destPath, { recursive: true });
                      copyBack(srcPath, destPath);
                    } else {
                      fs.copyFileSync(srcPath, destPath);
                    }
                  }
                };

                copyBack(latest.path, repoPath);
                console.log(chalk.green('✓ Backup files restored'));
              } else {
                console.log(chalk.dim('No backups available'));
              }
            }
          }
        } catch (err: any) {
          console.log(chalk.red(`Rollback failed: ${err.message?.substring(0, 200)}`));
          process.exitCode = 1;
        }
      },
    },
  ],
};

export default plugin;
