import { swallow } from '../utils/log';
/**
 * fix-pass.ts (Phase 4)
 *
 * Dedicated CLI invocation for FIX MODE — a DUM that already exists on
 * disk and was rejected by the quality gate. Instead of rerunning the
 * full single-call flow (which loads QUALITY_CONTRACT + briefing + every
 * sibling DUM and burns 60-120s to fix two ACs), this prompt is enxuto:
 * "open this file, apply these N issues via Edit, exit."
 *
 * Why a separate file from enrich-pass:
 *   - enrich generates a NEW DUM. fix MODIFIES an existing one. Telling
 *     the CLI both at once is the original confusion that produced the
 *     "delete and regenerate" behavior.
 *   - fix never reads QUALITY_CONTRACT or briefing — they're not needed
 *     to fix specific issues. Tiny prompt → fast call.
 *   - fix only allows the Edit tool. Write is explicitly forbidden in
 *     the prompt; the spawn-detector also marks Write-overwrites as a
 *     `modified` event, so a stray Write doesn't go silent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface FixPassIssue {
  /** Quality criterion that failed (singular, complete, verifiable, etc). */
  criterion: string;
  /** Severity tag from the gate (BLOCKER/MAJOR/MINOR). */
  severity: string;
  /** Stable code for the rule the offending text matched. */
  code: string;
  /** Human-readable explanation of the violation. */
  message: string;
  /** Concrete pointer for the LLM on what to change. */
  fixHint: string;
  /** Task title where the issue lives — drives the Edit's locator. */
  taskTitle?: string;
}

export interface FixPassOptions {
  cwd: string;
  cliCommand: string;
  cliArgs: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FixPassResult {
  /** True when the file was modified during the spawn. */
  modified: boolean;
  /** Path of the DUM file (always present, even on failure). */
  dumPath: string;
  cliDurationMs: number;
}

/**
 * Run a fix pass for one previously-rejected DUM. The dump file MUST
 * already exist on disk; we never create it here.
 */
export async function runFixPass(
  dumPath: string,
  issues: FixPassIssue[],
  options: FixPassOptions,
): Promise<FixPassResult> {
  if (!fs.existsSync(dumPath)) {
    throw new Error(`Fix pass: DUM file not found: ${dumPath}`);
  }
  const before = mtimeAndHash(dumPath);
  const prompt = buildFixPrompt(dumPath, issues);
  const startedAt = Date.now();
  await spawnCli(options, prompt);
  const cliDurationMs = Date.now() - startedAt;
  const after = mtimeAndHash(dumPath);
  const modified = after.mtime > before.mtime && after.hash !== before.hash;
  return { modified, dumPath, cliDurationMs };
}

function mtimeAndHash(filePath: string): { mtime: number; hash: string } {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto');
      return {
        mtime: stat.mtimeMs,
        hash: crypto.createHash('sha256').update(buf.slice(0, read)).digest('hex'),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { mtime: 0, hash: '' };
  }
}

function buildFixPrompt(dumPath: string, issues: FixPassIssue[]): string {
  const issuesList = issues
    .slice(0, 30)
    .map(
      (i, idx) =>
        `${idx + 1}. **[${i.severity}]** ${i.criterion}/${i.code}${i.taskTitle ? ` (task: "${i.taskTitle}")` : ''}\n   Problem: ${i.message}\n   Fix: ${i.fixHint}`,
    )
    .join('\n\n');

  return `You're fixing ONE DUM that was rejected by the quality gate.

## TARGET FILE

\`${dumPath}\`

## ISSUES TO FIX (${issues.length} total)

${issuesList}

## RULES (BINDING — non-negotiable)

- Use ONLY the Edit tool. **Never use Write.** Write would replace the entire file → counts as regeneration → auto-rejected.
- For each issue, locate the offending text inside the description / acceptance criteria / task body and Edit it in place. One Edit call per fix is fine; \`replace_all: true\` is fine when the same offender appears multiple times.
- DO NOT change \`tempId\`, \`requirementIds\`, or \`dependsOn\` unless an issue specifically asks for that.
- DO NOT read any other file. The issues above are self-sufficient — they include both the problem and the fix hint.
- DO NOT reason about siblings, DO NOT consult QUALITY_CONTRACT.md, DO NOT explore the project. Just apply the fixes.

## EXIT

After applying every fix, print exactly: \`DONE: fixed ${issues.length} issues in ${path.basename(dumPath)}\` and exit.

If ANY issue can't be applied (text not found, ambiguous match), print \`PARTIAL: applied <N> of ${issues.length}\` and exit anyway — the agent will re-validate and retry next round.`;
}

async function spawnCli(opts: FixPassOptions, prompt: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanEnv: NodeJS.ProcessEnv = {};
    const blocked = new Set([
      'CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_AGENT_SDK', 'CLAUDE_CODE_SUBAGENT',
    ]);
    for (const [k, v] of Object.entries(process.env)) {
      if (!blocked.has(k)) cleanEnv[k] = v;
    }
    const cmdBase = path.basename(opts.cliCommand);
    const isMakestudio = cmdBase === 'makestudio' || cmdBase === 'ms' || /makestudio/.test(opts.cliCommand);
    const finalArgs = isMakestudio ? [...opts.cliArgs, prompt] : opts.cliArgs;

    const proc = spawn(opts.cliCommand, finalArgs, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch (err) { swallow(err); } };
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (err) { swallow(err); }
    }, opts.timeoutMs ?? 2 * 60 * 1000); // fix is supposed to be fast — 2min cap

    if (!isMakestudio) {
      proc.stdin?.write(prompt);
    }
    proc.stdin?.end();

    proc.stderr?.on('data', () => { /* discard */ });
    proc.stdout?.on('data', () => { /* discard */ });

    proc.on('close', () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}
