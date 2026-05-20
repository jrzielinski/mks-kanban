/**
 * File logger for the Electron main process.
 *
 * Tees every byte written to process.stdout / process.stderr into a log file
 * on disk. Because console.* and the forked backend/agent child output all go
 * through those two streams, this captures the whole picture — main process
 * logs, child-process logs, renderer console messages (re-emitted by main) and
 * uncaught errors — even when the app is launched from Finder with no terminal.
 *
 *   initLogger()      — start teeing; safe to call once, returns the log path
 *   getLogFilePath()  — absolute path to the current session's log file
 */
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let stream: fs.WriteStream | null = null;
let logFilePath = '';

const ts = () => new Date().toISOString();

export function getLogFilePath(): string {
  return logFilePath;
}

export function initLogger(): string {
  if (stream) return logFilePath;

  // app.getPath('logs') => ~/Library/Logs/<AppName> (macOS),
  // %APPDATA%\<AppName>\logs (Windows), ~/.config/<AppName>/logs (Linux).
  let logDir: string;
  try {
    logDir = app.getPath('logs');
  } catch {
    logDir = path.join(app.getPath('userData'), 'logs');
  }
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, 'main.log');

  stream = fs.createWriteStream(logFilePath, { flags: 'a' });
  // A logger must never be the thing that crashes the app.
  stream.on('error', () => { stream = null; });

  const write = (chunk: unknown) => {
    try {
      stream?.write(typeof chunk === 'string' ? chunk : (chunk as Buffer));
    } catch {
      /* never let logging crash the app */
    }
  };

  write(`\n===== session start ${ts()} (pid ${process.pid}) =====\n`);

  // Tee stdout + stderr. console.log/error and forked child output all flow
  // through these, so a single intercept point captures everything.
  for (const channel of ['stdout', 'stderr'] as const) {
    const orig = process[channel].write.bind(process[channel]);
    process[channel].write = ((chunk: unknown, ...args: unknown[]) => {
      write(chunk);
      return (orig as (...a: unknown[]) => boolean)(chunk, ...args);
    }) as typeof process.stdout.write;
  }

  // Belt-and-suspenders: stamp fatal errors with a clear marker + timestamp.
  process.on('uncaughtException', (err) => {
    write(`[${ts()}] !!! UNCAUGHT EXCEPTION: ${err?.stack || String(err)}\n`);
  });
  process.on('unhandledRejection', (reason) => {
    write(`[${ts()}] !!! UNHANDLED REJECTION: ${(reason as Error)?.stack || String(reason)}\n`);
  });

  return logFilePath;
}
