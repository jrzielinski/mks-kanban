import { swallow } from '../utils/log';
/**
 * plugin-backup — Creates automatic backups of modified files before task execution.
 * Stores backups in ~/.makestudio/backups/{taskId}/ with timestamps.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch } from '../types';

const BACKUPS_DIR = path.join(os.homedir(), '.makestudio', 'backups');
const MAX_BACKUPS = 50; // Keep last 50 task backups

function cleanOldBackups(): void {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return;

    const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({
        name: e.name,
        path: path.join(BACKUPS_DIR, e.name),
        mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);

    // Remove oldest backups beyond limit
    for (const entry of entries.slice(MAX_BACKUPS)) {
      fs.rmSync(entry.path, { recursive: true, force: true });
    }
  } catch (err) { swallow(err); }
}

const plugin: MakeStudioPlugin = {
  name: 'backup',
  version: '1.0.0',
  description: 'Create automatic file backups before task execution',

  async onLoad(ctx: PluginContext) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    cleanOldBackups();

    try {
      const backupCount = fs.readdirSync(BACKUPS_DIR).length;
      ctx.logger.info(`Backup dir: ${BACKUPS_DIR} (${backupCount} existing)`);
    } catch (err) { swallow(err); }
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      if (task.oneshot) return task; // Skip for oneshot tasks

      try {
        const repoPath = process.cwd(); // Will be resolved by executor later
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(BACKUPS_DIR, `${task.taskId}_${timestamp}`);

        // Get list of tracked files that would be affected
        let trackedFiles: string[] = [];
        try {
          const status = execSync('git status --porcelain', {
            cwd: repoPath,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 10_000,
          }).trim();

          if (status) {
            trackedFiles = status.split('\n')
              .filter(Boolean)
              .map(line => line.substring(3).trim())
              .filter(f => !f.includes('node_modules/') && !f.includes('.makestudio/'))
              .slice(0, 100); // Max 100 files
          }
        } catch (err) { swallow(err); }

        if (trackedFiles.length === 0) return task;

        // Create backup directory and copy files
        fs.mkdirSync(backupDir, { recursive: true });

        let backedUp = 0;
        for (const file of trackedFiles) {
          const srcPath = path.join(repoPath, file);
          if (!fs.existsSync(srcPath)) continue;

          const destPath = path.join(backupDir, file);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });

          try {
            const stat = fs.statSync(srcPath);
            if (stat.size < 1024 * 1024) { // Max 1MB per file
              fs.copyFileSync(srcPath, destPath);
              backedUp++;
            }
          } catch (err) { swallow(err); }
        }

        if (backedUp > 0) {
          // Write metadata
          fs.writeFileSync(
            path.join(backupDir, '.backup-meta.json'),
            JSON.stringify({
              taskId: task.taskId,
              taskTitle: task.taskTitle,
              taskType: task.taskType,
              timestamp,
              filesBackedUp: backedUp,
              repoPath,
            }, null, 2),
            'utf8',
          );
        } else {
          // No files backed up — remove empty dir
          fs.rmSync(backupDir, { recursive: true, force: true });
        }
      } catch {
        // Backup failure is non-fatal
      }

      return task; // Always pass through unmodified
    },
  },
};

export default plugin;
