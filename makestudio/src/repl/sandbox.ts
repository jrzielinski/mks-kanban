import { swallow } from '../utils/log';
/**
 * Real bash sandbox — platform-specific process isolation.
 *
 * macOS: sandbox-exec with custom seatbelt profiles (deprecated but works)
 * Linux: bwrap (bubblewrap) with namespace-based isolation
 * Windows / no-sandbox: returns unchanged command (sandbox = none)
 *
 * Levels:
 *   - "none": no sandbox (fallback)
 *   - "readonly": read-only filesystem except /tmp
 *   - "project": read-only EXCEPT the project directory (default for shell_run)
 *   - "full": full write access (explicit opt-in, still blocks destructive)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawnSync } from 'child_process';

export type SandboxLevel = 'none' | 'readonly' | 'project' | 'full';

export interface SandboxOptions {
  level: SandboxLevel;
  cwd: string;
  projectRoot?: string;      // writable when level === 'project'
  allowNetwork?: boolean;    // allow outgoing network
  extraWritablePaths?: string[];  // additional paths to make writable
}

export interface SandboxExec {
  command: string;
  args: string[];
  available: boolean;
  level: SandboxLevel;
  backend: 'sandbox-exec' | 'bwrap' | 'none';
}

/**
 * Detect which sandbox backend is available on this platform.
 */
export function detectSandboxBackend(): 'sandbox-exec' | 'bwrap' | 'none' {
  if (process.platform === 'darwin') {
    try {
      execSync('which sandbox-exec', { stdio: 'pipe' });
      return 'sandbox-exec';
    } catch { return 'none'; }
  }
  if (process.platform === 'linux') {
    try {
      execSync('which bwrap', { stdio: 'pipe' });
      return 'bwrap';
    } catch { return 'none'; }
  }
  return 'none';
}

/**
 * Generate a seatbelt profile for macOS sandbox-exec.
 * Profile language is TinyScheme-based S-expressions.
 */
function buildSeatbeltProfile(opts: SandboxOptions): string {
  const writableRoots: string[] = ['/tmp', '/private/tmp', '/var/tmp', '/dev/null', '/dev/stderr', '/dev/stdout'];
  if (opts.level === 'project' && opts.projectRoot) {
    writableRoots.push(opts.projectRoot);
  }
  if (opts.level === 'full') {
    writableRoots.push('/');
  }
  if (opts.extraWritablePaths) {
    writableRoots.push(...opts.extraWritablePaths);
  }

  const homeDir = os.homedir();

  // Base: deny-all default, allow specific operations
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(debug deny)',

    // Allow process operations (exec, signal own process group, etc.)
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target self))',
    '(allow mach-lookup)',
    '(allow sysctl-read)',
    '(allow iokit-open)',
    '(allow ipc-posix-shm)',

    // Allow reading system libraries, binaries, configs
    '(allow file-read*)',  // global read: simpler and still safe
    '(allow file-read-metadata)',

    // Allow writing only to specific roots
  ];

  // Writable paths
  for (const p of writableRoots) {
    lines.push(`(allow file-write* (subpath "${p}"))`);
    lines.push(`(allow file-ioctl (subpath "${p}"))`);
  }

  // Allow reading/writing tty and stdio
  lines.push('(allow file* (literal "/dev/tty"))');
  lines.push('(allow file* (regex #"^/dev/ttys[0-9]+$"))');

  // Network
  if (opts.allowNetwork !== false) {
    lines.push('(allow network*)');
  } else {
    lines.push('(allow network-outbound (literal "/private/var/run/syslog"))');  // logging only
  }

  // Allow access to home for config reads (like .netrc, ssh keys) — already covered by file-read*

  // Allow signals to child processes
  lines.push('(allow signal)');

  return lines.join('\n');
}

/**
 * Build a bwrap command-line for Linux.
 */
function buildBwrapArgs(opts: SandboxOptions): string[] {
  const args: string[] = [
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ];

  // Read-only bindings for system directories
  const readOnlyRoots = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc', '/opt'];
  for (const ro of readOnlyRoots) {
    if (fs.existsSync(ro)) {
      args.push('--ro-bind', ro, ro);
    }
  }

  // Home directory — read-only by default, specific writable paths
  const home = os.homedir();
  args.push('--ro-bind', home, home);

  // Writable paths based on level
  const writablePaths: string[] = [];
  if (opts.level === 'project' && opts.projectRoot) writablePaths.push(opts.projectRoot);
  if (opts.level === 'full') writablePaths.push(home);
  if (opts.extraWritablePaths) writablePaths.push(...opts.extraWritablePaths);

  for (const p of writablePaths) {
    args.push('--bind', p, p);
  }

  // Network
  if (opts.allowNetwork === false) {
    args.push('--unshare-net');
  } else {
    // Share network namespace with host
    if (fs.existsSync('/etc/resolv.conf')) args.push('--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf');
  }

  // Change to cwd
  args.push('--chdir', opts.cwd);

  // Environment passthrough
  for (const key of ['HOME', 'PATH', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL']) {
    const val = process.env[key];
    if (val) args.push('--setenv', key, val);
  }

  return args;
}

/**
 * Wrap a shell command to run inside the sandbox. Returns the wrapped
 * command ready to spawn. If sandbox not available, returns unwrapped.
 */
export function wrapCommand(shellCommand: string, opts: SandboxOptions): SandboxExec {
  const backend = opts.level === 'none' ? 'none' : detectSandboxBackend();

  if (backend === 'none') {
    return {
      command: '/bin/sh',
      args: ['-c', shellCommand],
      available: false,
      level: 'none',
      backend: 'none',
    };
  }

  if (backend === 'sandbox-exec') {
    const profile = buildSeatbeltProfile(opts);
    // Write profile to temp file (sandbox-exec -f takes a file)
    const profilePath = path.join(os.tmpdir(), `makestudio-sandbox-${process.pid}-${Date.now()}.sb`);
    fs.writeFileSync(profilePath, profile, 'utf8');

    return {
      command: 'sandbox-exec',
      args: ['-f', profilePath, '/bin/sh', '-c', shellCommand],
      available: true,
      level: opts.level,
      backend: 'sandbox-exec',
    };
  }

  if (backend === 'bwrap') {
    const bwrapArgs = buildBwrapArgs(opts);
    return {
      command: 'bwrap',
      args: [...bwrapArgs, '/bin/sh', '-c', shellCommand],
      available: true,
      level: opts.level,
      backend: 'bwrap',
    };
  }

  return {
    command: '/bin/sh',
    args: ['-c', shellCommand],
    available: false,
    level: 'none',
    backend: 'none',
  };
}

/**
 * Execute a shell command through the sandbox. Returns stdout/stderr/exitCode.
 */
export function execSandboxed(shellCommand: string, opts: SandboxOptions & { timeout?: number }): {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;
  backend: string;
} {
  const wrapped = wrapCommand(shellCommand, opts);
  const result = spawnSync(wrapped.command, wrapped.args, {
    cwd: opts.cwd,
    timeout: opts.timeout || 60_000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  // Cleanup temp profile file
  if (wrapped.backend === 'sandbox-exec' && wrapped.args[1]) {
    try { fs.unlinkSync(wrapped.args[1]); } catch (err) { swallow(err); }
  }

  return {
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
    exitCode: typeof result.status === 'number' ? result.status : 1,
    sandboxed: wrapped.available,
    backend: wrapped.backend,
  };
}

/**
 * Determine sandbox level based on command risk classification.
 */
export function levelForRisk(risk: 'safe' | 'warn' | 'dangerous'): SandboxLevel {
  if (risk === 'safe') return 'readonly';     // read-only even for "safe" cmds
  if (risk === 'warn') return 'project';      // write access only to project
  return 'project';                            // dangerous still sandboxed to project
}
