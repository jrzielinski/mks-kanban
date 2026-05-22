/**
 * `makestudio scheduled-run` — one-shot command that runs all due schedules
 * and exits. Designed to be invoked by launchd/systemd/cron every minute.
 *
 * Example launchd plist entry (macOS):
 *   <key>ProgramArguments</key>
 *   <array>
 *     <string>/usr/local/bin/makestudio</string>
 *     <string>scheduled-run</string>
 *   </array>
 *   <key>StartInterval</key>
 *   <integer>60</integer>
 */

import { listDueSchedules, markRan, recordRun, Schedule } from '../repl/schedule';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function scheduledRunCommand(): Promise<void> {
  const logFile = path.join(os.homedir(), '.makestudio', 'scheduled-run.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
  };

  const due = listDueSchedules();
  if (due.length === 0) {
    process.exit(0);
  }

  log(`Found ${due.length} due schedule(s)`);
  for (const s of due) {
    log(`Running: ${s.name} → ${s.command}`);
    const startedAt = Date.now();
    // Slash commands need the REPL runtime; for daemon use, only execute
    // shell-style commands directly. Warn on slash commands.
    if (s.command.startsWith('/')) {
      log(`  WARNING: slash command "${s.command}" — daemon can't run this. Skipping.`);
      recordRun({
        scheduleId: s.id,
        ranAt: new Date(startedAt).toISOString(),
        durationMs: 0,
        exitCode: null,
        outputTail: '',
        error: 'slash commands require the REPL — daemon skipped',
        trigger: 'daemon',
      });
      continue;
    }
    try {
      const out = execSync(s.command, {
        timeout: 30 * 60_000,  // 30 minutes max per scheduled run
        stdio: 'pipe',
        shell: '/bin/sh',
      });
      markRan(s.id);
      recordRun({
        scheduleId: s.id,
        ranAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        outputTail: out?.toString('utf8') ?? '',
        trigger: 'daemon',
      });
      log(`  ok: ${s.name}`);
    } catch (err: any) {
      const exit: number | null =
        typeof err?.status === 'number' ? err.status : null;
      const stdout = err?.stdout?.toString('utf8') ?? '';
      const stderr = err?.stderr?.toString('utf8') ?? '';
      const tail = (stdout + (stdout && stderr ? '\n' : '') + stderr) || '';
      const message = err?.message ?? String(err);
      // Even on failure we mark the schedule as ran — otherwise it would
      // re-fire next minute on the same broken command.
      markRan(s.id);
      recordRun({
        scheduleId: s.id,
        ranAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        exitCode: exit,
        outputTail: tail,
        error: message?.substring(0, 500),
        trigger: 'daemon',
      });
      log(`  FAILED: ${s.name} — ${message?.substring(0, 200)}`);
    }
  }
  process.exit(0);
}
