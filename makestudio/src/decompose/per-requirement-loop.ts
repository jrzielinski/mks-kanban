import { swallow } from '../utils/log';
/**
 * per-requirement-loop.ts (Phase B)
 *
 * Replaces the legacy "one big CLI call generates 80 DUMs" flow with a
 * per-requirement loop:
 *
 *   for each requirement R in requirementIds:
 *     - prompt the CLI to decompose JUST R (pinning context to ~5K tokens)
 *     - the CLI may read existing DUMs in .makestudio/dums/ before writing
 *     - the CLI writes one or more dum_NNN.json files
 *     - we validate each new DUM via POST /dums/validate-iso
 *     - if BLOCKER/MAJOR issues, re-prompt the CLI with the issues (max 2 retries)
 *     - save valid DUMs via existing /save-decomposition
 *     - move to next requirement
 *
 * Why this beats one-shot:
 *   - Cognitive load per call is bounded (~5K tokens vs 200K)
 *   - The CLI sees existing DUMs and avoids duplication (Unique gate)
 *   - Failures are caught immediately, not after the whole batch
 *   - Resumable: if the agent crashes at req 30, the next run starts at req 31
 *     because reqs 1-29's DUMs are already persisted
 *
 * The QUALITY_CONTRACT.md (Phase A) is already on disk by the time this
 * runs — the CLI reads it as part of every per-requirement spawn.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { createTelemetryLogger, TelemetryLogger } from './telemetry';
import { runStructurePass, DumStructure } from './structure-pass';
import { runEnrichPass } from './enrich-pass';
import { runFixPass, FixPassIssue } from './fix-pass';
import { fetchExistingDums } from './loop-helpers';
import { processOneRequirementTwoPass, TwoPassCtx } from './process-one-requirement-two-pass';

// Types moved to ./types — re-exported here to preserve the public API.
import type { Requirement, ExistingDumSummary, LoopOptions, ProgressEvent, LoopResult } from './types';
export type { Requirement, ExistingDumSummary, LoopOptions, ProgressEvent, LoopResult };

export async function runPerRequirementLoop(
  requirements: Requirement[],
  options: LoopOptions,
): Promise<LoopResult> {
  const maxRetries = options.maxRetriesPerReq ?? 2;
  // Phase 6 — default 3 concurrent reqs (was 1). Safe now that
  // structure-pass reserves disjoint tempId ranges per req and the
  // backend's UQ_dum_project_number constraint catches any residual
  // race. Override to 1 for gemini (free-tier rate limit) by passing
  // explicit `concurrency: 1` from the caller, or via env.
  const envConcurrency = parseInt(process.env.MAKESTUDIO_PER_REQ_CONCURRENCY || '', 10);
  const defaultConcurrency = options.cli === 'gemini' ? 1 : 3;
  const baseConcurrency = options.concurrency
    ?? (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : defaultConcurrency);
  const concurrency = Math.max(1, Math.min(baseConcurrency, 8));
  // Mutable state bundled into one object so the extracted
  // processOneRequirementTwoPass helper can mutate via reference.
  // Without this, splitting the worker into a top-level function would
  // require ref-passing every scalar — uglier than a single state bag.
  const state = {
    saved: 0,
    existingDums: [] as ExistingDumSummary[],
    failedRequirements: [] as LoopResult['failedRequirements'],
  };
  const loopStartedAt = Date.now();

  // Telemetry — local JSONL log of every phase. Best-effort, never breaks
  // the main flow. Persisted to .makestudio/telemetry/decompose-DATE.jsonl.
  const telemetry: TelemetryLogger = createTelemetryLogger({
    cwd: options.cwd,
    projectId: options.projectId,
    cli: options.cli,
  });

  // Phase C — resume mode: filter out already-decomposed requirements
  // before starting. The backend tracks decomposed_at per requirement.
  let workQueue = [...requirements];
  if (options.resumeMode) {
    try {
      const reqIds = requirements.map((r) => r.id).join(',');
      const res = await options.api.get(
        `/dark-factory/projects/${options.projectId}/requirements/pending-decomposition?ids=${encodeURIComponent(reqIds)}`,
        { timeout: 10_000 },
      );
      const pendingIds = new Set((res.data?.requirements || []).map((r: any) => r.id));
      const before = workQueue.length;
      workQueue = workQueue.filter((r) => pendingIds.has(r.id));
      const skipped = before - workQueue.length;
      if (skipped > 0) {
        // Emit a dedicated 'req-skipped' event so the UI knows about the
        // resume cut without confusing it with the loop's final completion.
        options.onProgress?.({
          type: 'req-skipped',
          total: before,
          skipped,
        });
      }
    } catch {
      // If pending-decomposition fetch fails, fall through and try them all.
    }
  }

  // Snapshot existing DUMs once at start; we update incrementally as we
  // save new ones so the CLI sees a fresh list each iteration.
  state.existingDums = await fetchExistingDums(options.api, options.projectId);

  telemetry.record({ type: 'loop-start', totalReqs: workQueue.length });

  // Phase C — parallel workers. cursor is shared; each worker pulls the
  // next req atomically. With concurrency=1 this degenerates to the old
  // sequential loop. Note: we still use a single shared `existingDums`
  // snapshot per iteration, refreshed AFTER each save — this means
  // workers running in parallel may briefly miss DUMs the OTHER worker
  // just wrote, but the backend's set-level Unique check is the
  // authoritative dedup on save, so worst case is one wasted retry.
  // Two-pass (structure-pass → enrich-pass) is the only flow now. The
  // single-call legacy path stuffed the full QUALITY_CONTRACT + briefing
  // + existing-DUMs context (~30K tokens) in front of the write step,
  // and smaller-context providers wrote shallow stubs by the time they
  // reached the Write call. Two-pass keeps each prompt focused (~1.5KB
  // for structure, ~5KB for enrich) so the write happens with the rules
  // still in recent attention.
  telemetry.record({
    type: 'req-start',
    reqIndex: -1,
    reqId: 'two-pass-mode',
    reqTitle: 'two-pass mode active',
  });

  // Bundle once so workers can pass it down without rebuilding per call.
  const twoPassCtx: TwoPassCtx = {
    options,
    telemetry,
    workQueueLength: workQueue.length,
    maxRetries,
    state,
  };

  let cursor = 0;
  const workerLoop = async (workerId: number): Promise<void> => {
    while (true) {
      // Honor user cancellation between requirements (cleaner than waiting
      // for the inner spawn to notice the AbortSignal).
      if (options.signal?.aborted) return;
      const i = cursor++;
      if (i >= workQueue.length) return;
      try {
        await processOneRequirementTwoPass(i, workerId, workQueue[i], twoPassCtx);
      } catch (err: any) {
        // User cancellation — bail out gracefully, don't try the next req.
        if (err?.aborted) return;
        // ANY other unhandled exception (API timeout, FS error, malformed
        // response from validate-iso, etc.) MUST NOT terminate the worker.
        // Without this catch, `Promise.all(workerPromises)` would reject on
        // the first failure and the entire batch would abort — explaining
        // the "selected reqs X..Y, only X processes, then it aborts" report.
        // Surface the failure on the same channels req-failed normally uses
        // and continue with the next requirement.
        const req = workQueue[i];
        const reason = `unhandled exception: ${err?.message || String(err)}`;
        state.failedRequirements.push({ id: req.id, title: req.title, reason });
        options.onProgress?.({
          type: 'req-failed',
          reqIndex: i,
          reason: reason.slice(0, 200),
        });
        telemetry.record({
          type: 'req-end',
          reqIndex: i,
          reqId: req.id,
          reqTitle: req.title.slice(0, 80),
          success: false,
          retryCount: 0,
          dumsSaved: 0,
          timeToFirstWriteMs: 0,
          timeToValidateMs: 0,
          timeToSaveMs: 0,
          totalDurationMs: 0,
          causeOfRetry: 'unhandled-exception',
        });
        // Loop continues — pull the next requirement from the queue.
      }
    }
  };

  /**
   * Phase 3 — two-pass implementation. Calls structure-pass to get the
   * shape of N DUMs for the requirement, then runs enrich-pass for each
   * (up to 2 in parallel) and validates+saves the produced JSON via the
   * existing validate-iso / save-decomposition endpoints.
   *
   * Falls back to a `req-failed` telemetry record + push to
   * failedRequirements if structure-pass returns 0 DUMs after the
   * configured retries — same contract as the legacy path so the loop
   * caller doesn't have to differentiate.
   */

  // Launch N workers concurrently and wait for all to drain the queue.
  // Promise.allSettled (not Promise.all) so one worker's stray exception
  // can't poison the rest of the batch — even though workerLoop wraps
  // every requirement in try/catch internally, this is belt-and-braces:
  // unhandled rejections from a future code path still wouldn't abort
  // peers. allSettled returns AFTER every worker drains the queue.
  const workerPromises: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workerPromises.push(workerLoop(w));
  }
  const settled = await Promise.allSettled(workerPromises);
  for (const s of settled) {
    if (s.status === 'rejected') {
      telemetry.record({
        type: 'loop-end',
        totalReqs: workQueue.length,
        saved: state.saved,
        failed: state.failedRequirements.length,
        durationMs: Date.now() - loopStartedAt,
        workerError: String((s as any).reason?.message || (s as any).reason || 'unknown'),
      } as any);
    }
  }

  options.onProgress?.({
    type: 'loop-complete',
    total: workQueue.length,
    saved: state.saved,
    failed: state.failedRequirements.length,
    cost: 0, // CLI cost is not exposed here — we'll report it from the agent's heartbeat
  });

  telemetry.record({
    type: 'loop-end',
    totalReqs: workQueue.length,
    saved: state.saved,
    failed: state.failedRequirements.length,
    durationMs: Date.now() - loopStartedAt,
  });
  telemetry.flush();
  // Best-effort: ship buffered events to the backend so cross-tenant
  // dashboards can aggregate. Never blocks completion if backend is down.
  await telemetry.syncToBackend(options.api);

  // Trigger the project-wide quality gate run so any task whose DUM was
  // saved with unresolved issues (held fallback path) gets persisted as
  // qualityStatus='held'. Without this the dashboard shows zero held
  // tasks even when the loop knows fixes are pending — the operator has
  // no entry point for /quality-hold edit/reanalyze.
  //
  // Best-effort: never crash the loop if the gate endpoint is down. The
  // operator can always trigger it manually via the dashboard or
  // POST /quality-gate/run.
  if (state.saved > 0) {
    try {
      await options.api.post(
        `/dark-factory/projects/${options.projectId}/quality-gate/run`,
        {},
        { timeout: 60_000 },
      );
    } catch (err) { swallow(err); }
  }

  return {
    total: workQueue.length,
    saved: state.saved,
    failed: state.failedRequirements.length,
    failedRequirements: state.failedRequirements,
  };
}

// severityRank, fetchExistingDums, listDumFiles moved to ./loop-helpers.

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compatibility shim — older agents that point at backends without the
 * merged QUALITY_CONTRACT.md still expect a DECOMPOSITION_RULES.md file
 * on disk. New projects see only a thin marker that forwards readers to
 * QUALITY_CONTRACT.md (the single source of truth post-Phase 5).
 */
const RULES_VERSION = 'v4-2026-04-29-merged-into-contract';

async function ensureDecompositionRules(cwd: string): Promise<void> {
  const filePath = path.join(cwd, '.makestudio', 'DECOMPOSITION_RULES.md');
  try {
    if (fs.existsSync(filePath)) {
      const head = fs.readFileSync(filePath, 'utf8').slice(0, 200);
      if (head.includes(`<!-- VERSION: ${RULES_VERSION} -->`)) return;
    }
  } catch (err) { swallow(err); }

  const content = `<!-- VERSION: ${RULES_VERSION} -->
# Decomposition Rules — moved into QUALITY_CONTRACT.md

This file is kept only for compatibility with older agents that expect it on disk. The actual workflow, sizing, tempId conventions, and self-audit checklist now live in:

  \`.makestudio/QUALITY_CONTRACT.md\`

Read that file. It is the single source of truth.

If you are an LLM CLI invoked here, follow QUALITY_CONTRACT.md exactly. Use Read/Write/Edit/Glob/Grep — there are no custom RPC tools.
`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) { swallow(err); }
}

/**
 * Write the per-requirement context files to .makestudio/decompose-task/.
 * This keeps the spawned-CLI prompt TINY — the prompt just points to these
 * files, the CLI reads them as authoritative input.
 *
 * Files written (overwritten each call):
 *   - REQUIREMENT.md  — the requirement to decompose (id, title, desc, AC)
 *   - EXISTING_DUMS.md — list of DUMs already in the project (avoid duplicating)
 *   - TEMPIDS.md       — pre-allocated tempIds in order
 *   - FIX_MODE.md      — instructions to fix specific failing files (retry only)
 */
function writePerRequirementContext(
  cwd: string,
  req: Requirement,
  existingDums: ExistingDumSummary[],
  previousIssues: any[] | null,
  reservedTempIds: string[],
): void {
  const taskDir = path.join(cwd, '.makestudio', 'decompose-task');
  try { fs.mkdirSync(taskDir, { recursive: true }); } catch (err) { swallow(err); }

  const acsArray = Array.isArray(req.acceptanceCriteria)
    ? req.acceptanceCriteria
    : typeof req.acceptanceCriteria === 'string'
    ? [req.acceptanceCriteria]
    : [];

  // 1. REQUIREMENT.md
  const reqMd = `# Requirement to Decompose

**ID**: \`${req.id}\`
**Title**: ${req.title}
**Type**: ${req.type || 'functional'}
${req.priority ? `**Priority**: ${req.priority}\n` : ''}
## Description

${req.description || '_(no description)_'}

${acsArray.length > 0 ? `## Acceptance criteria\n\n${acsArray.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n` : ''}`;
  fs.writeFileSync(path.join(taskDir, 'REQUIREMENT.md'), reqMd, 'utf8');

  // 2. EXISTING_DUMS.md
  const existingMd = `# Existing DUMs (avoid duplicating)

${existingDums.length === 0
  ? '_(No existing DUMs yet — this is the first requirement.)_'
  : existingDums
      .map((d) => `- \`${d.tempId || d.dumNumber}\` (${d.type}) — ${d.title}`)
      .join('\n')}

To inspect any existing DUM in detail, read \`.makestudio/dums/<tempId>.json\`.
`;
  fs.writeFileSync(path.join(taskDir, 'EXISTING_DUMS.md'), existingMd, 'utf8');

  // 3. TEMPIDS.md
  const tempIdsMd = `# Pre-allocated tempIds — USE STRICTLY IN ORDER

You MUST write DUMs in the exact order listed below. The first tempId is for the FOUNDATION (DB/entity/schema), the second for SERVICE/API, the third for UI/frontend. Never start with the UI; never skip a tempId.

${reservedTempIds.map((id, idx) => {
  const role = idx === 0
    ? '**foundation** (DB schema, entity, migration, types) — no \`dependsOn\` other than \`dum_001\`'
    : idx === 1
    ? `**service/API** (controllers, services, business logic) — \`dependsOn: ["${reservedTempIds[0]}"]\``
    : idx === 2
    ? `**UI/frontend** (pages, components, hooks, wizard) — \`dependsOn: ["${reservedTempIds[1]}"]\``
    : `additional layer — \`dependsOn: ["${reservedTempIds[idx - 1]}"]\``;
  return `${idx + 1}. \`${id}\` → write to \`.makestudio/dums/${id}.json\` — ${role}`;
}).join('\n')}

## Sizing

- 1 DUM only when the requirement is genuinely tiny (e.g., a single endpoint with no UI). Use \`${reservedTempIds[0]}\`.
- 2 DUMs = backend + frontend. Use \`${reservedTempIds[0]}\` then \`${reservedTempIds[1]}\`.
- 3 DUMs = DB + service + UI. Use \`${reservedTempIds[0]}\`, \`${reservedTempIds[1]}\`, \`${reservedTempIds[2]}\`.
- Never go over 3 unless the requirement truly spans 4+ independent layers.

## Strict ordering rule

- Write \`${reservedTempIds[0]}\` FIRST. Self-audit, Write, then move on.
- Then \`${reservedTempIds[1]}\` (if needed). Its \`dependsOn\` MUST reference \`${reservedTempIds[0]}\`.
- Then \`${reservedTempIds[2]}\` (if needed). Its \`dependsOn\` MUST reference \`${reservedTempIds[1]}\`.
- **DO NOT** write a DUM whose \`dependsOn\` points to a tempId you have NOT yet written. The previous attempt violated this and the result was rejected.
`;
  fs.writeFileSync(path.join(taskDir, 'TEMPIDS.md'), tempIdsMd, 'utf8');

  // 4. FIX_MODE.md — only when retrying with feedback
  const fixModePath = path.join(taskDir, 'FIX_MODE.md');
  const isFixMode = !!(previousIssues && previousIssues.length > 0 && previousIssues[0]?.dumFile);
  if (isFixMode) {
    const byFile = new Map<string, any[]>();
    for (const issue of previousIssues!) {
      const key = (issue as any).dumFile || 'unknown';
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(issue);
    }
    const sections: string[] = [];
    for (const [file, fileIssues] of byFile.entries()) {
      const issuesList = fileIssues
        .slice(0, 15)
        .map(
          (i, idx) =>
            `${idx + 1}. **[${i.severity}]** ${i.criterion}/${i.code} (task: "${i.taskTitle}")\n   Problem: ${i.message}\n   Fix: ${i.fixHint}`,
        )
        .join('\n\n');
      sections.push(`### \`.makestudio/dums/${file}\`\n\n${issuesList}`);
    }
    const fixMd = `# ⚠ FIX MODE — edit existing DUM files in place

The quality gate REJECTED the DUMs below. The files ALREADY EXIST on disk.

**Use ONLY the Edit tool — NEVER use Write here.**
Write would replace the whole file (= regeneration, auto-rejected). Edit lets you change ONLY the offending lines, which is what a real fix looks like.

Steps for EACH file listed below:
1. Read the file with the Read tool.
2. For each issue, locate the offending text in the description / acceptance criteria / task body.
3. Use Edit (one call per fix, or replace_all for repetitive fixes) to change ONLY those lines.
4. Do not touch tempId, requirementIds, or dependsOn unless an issue specifically asks for that.

After fixing all files, print \`DONE: fixed ${byFile.size} DUMs\` and exit.

${sections.join('\n\n')}
`;
    fs.writeFileSync(fixModePath, fixMd, 'utf8');
  } else if (previousIssues && previousIssues.length > 0) {
    // Generic retry feedback (no specific files to edit)
    const issuesText = previousIssues
      .slice(0, 20)
      .map(
        (i, idx) =>
          `${idx + 1}. **[${i.severity}]** ${i.criterion}/${i.code} (task: "${i.taskTitle}")\n   Problem: ${i.message}\n   Fix: ${i.fixHint}`,
      )
      .join('\n\n');
    fs.writeFileSync(
      fixModePath,
      `# Issues from previous attempt — FIX THESE\n\nThe quality gate rejected your last attempt. Address every issue below before submitting again.\n\n${issuesText}\n`,
      'utf8',
    );
  } else {
    // No feedback — remove any stale fix-mode file from a prior call
    try { fs.unlinkSync(fixModePath); } catch (err) { swallow(err); }
  }
}

function buildPerRequirementPrompt(
  req: Requirement,
  existingDums: ExistingDumSummary[],
  previousIssues: any[] | null,
  cwd: string,
  reservedTempIds: string[],
): string {
  // All context goes to disk via writePerRequirementContext. The prompt is
  // intentionally TINY — just orientation. Heavy context as files keeps the
  // initial token cost low and lets the CLI stream-read at its own pace.
  void existingDums;
  void previousIssues;
  void reservedTempIds;
  void req;

  return `Read these files in order — they are LAW:

1. \`.makestudio/QUALITY_CONTRACT.md\` — quality rules (binding)
2. \`.makestudio/DECOMPOSITION_RULES.md\` — workflow + self-audit rules (binding)
3. \`.makestudio/decompose-task/REQUIREMENT.md\` — the requirement to decompose
4. \`.makestudio/decompose-task/EXISTING_DUMS.md\` — DUMs already in the project (avoid duplicating)
5. \`.makestudio/decompose-task/TEMPIDS.md\` — pre-allocated tempIds for new DUMs
6. \`.makestudio/decompose-task/FIX_MODE.md\` — ONLY IF PRESENT: previous-attempt issues to fix

Then read context files as needed:
- \`.makestudio/context/briefing.md\`
- \`.makestudio/context/stack.md\`
- \`.makestudio/context/boilerplate.md\` (only if needed for stack details)

Follow DECOMPOSITION_RULES.md exactly. Self-audit each DUM before writing. Write DUM files to \`.makestudio/dums/<tempId>.json\` per TEMPIDS.md.

When done, print \`DONE: <N> DUMs created\` (or \`DONE: fixed <N> DUMs\` in fix mode) and exit.

Working directory: \`${cwd}\`.`;
}

interface SpawnArgs {
  cliCommand: string;
  cliArgs: string[];
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  /** Optional: write CLI stdout/stderr to this file for post-mortem. */
  debugLogPath?: string;
}

/**
 * Type returned by `spawnCliAndCapture` — `kind: 'new'` means the file
 * didn't exist before the CLI ran; `kind: 'modified'` means it already
 * existed but the content changed (Edit applied, or Write overwrite).
 *
 * Pre-Phase-2 the function returned just `string[]`, which silently lost
 * Edit-style fixes: when Claude opened an existing dum_005.json and used
 * Edit to fix a single line, the filename was already in the snapshot,
 * so the diff was empty and the loop counted "0 DUMs written" → retry.
 */
export type WrittenFile = { path: string; kind: 'new' | 'modified' };

/**
 * Cheap content fingerprint — first 4KB of the file hashed. We don't need
 * cryptographic strength; we need "does this content differ from before"
 * with a tiny sample so reading 200 small JSONs is fast. 4KB covers the
 * tempId/title/early description fields that always change when the LLM
 * regenerated content vs. when it only fixed a single AC line.
 */
function snapshotHash(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      return crypto.createHash('sha256').update(buf.slice(0, read)).digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Spawn the CLI with the given prompt on stdin, wait for it to finish, and
 * return the list of dum_NNN.json files that were either newly created OR
 * modified during the call.
 *
 * Pre-Phase-2: only NEW files counted. That meant Claude using Edit on an
 * existing dum_005.json — exactly what FIX MODE asks for — was invisible
 * to the loop and triggered an unnecessary retry. The snapshot now records
 * mtime + content hash, so a real change is detected even when the
 * filename was already present.
 */
export async function spawnCliAndCapture(args: SpawnArgs): Promise<WrittenFile[]> {
  const dumsDir = path.join(args.cwd, '.makestudio', 'dums');
  const before = new Map<string, { mtime: number; hash: string }>();
  try {
    if (fs.existsSync(dumsDir)) {
      for (const f of fs.readdirSync(dumsDir)) {
        if (!/^dum_\d+\.json$/.test(f)) continue;
        const full = path.join(dumsDir, f);
        try {
          const stat = fs.statSync(full);
          before.set(f, { mtime: stat.mtimeMs, hash: snapshotHash(full) });
        } catch (err) { swallow(err); }
      }
    } else {
      fs.mkdirSync(dumsDir, { recursive: true });
    }
  } catch (err) { swallow(err); }

  return new Promise<WrittenFile[]>((resolve, reject) => {
    // Open debug log if requested.
    let debugStream: fs.WriteStream | null = null;
    if (args.debugLogPath) {
      try {
        fs.mkdirSync(path.dirname(args.debugLogPath), { recursive: true });
        debugStream = fs.createWriteStream(args.debugLogPath, { flags: 'w' });
        debugStream.write(`# CLI invocation\nCommand: ${args.cliCommand} ${args.cliArgs.join(' ')}\nCWD: ${args.cwd}\nPrompt length: ${args.prompt.length}\n# === Prompt ===\n${args.prompt}\n# === stdout/stderr below ===\n`);
      } catch (err) { swallow(err); }
    }

    // Strip claude-code env vars that may make a spawned claude CLI go into
    // "I'm a child of claude-code, stay quiet" mode. Symptom: spawned claude
    // reads context files then emits ZERO further events (no writes, no
    // result), exits cleanly after ~3 min. Filtering CLAUDECODE / AI_AGENT
    // / CLAUDE_CODE_ENTRYPOINT / CLAUDE_CODE_EXECPATH restores normal
    // streaming output.
    const cleanEnv: NodeJS.ProcessEnv = {};
    const blocked = new Set([
      'CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_AGENT_SDK', 'CLAUDE_CODE_SUBAGENT',
    ]);
    for (const [k, v] of Object.entries(process.env)) {
      if (!blocked.has(k)) cleanEnv[k] = v;
    }

    // makestudio's headless mode (-p) reads the prompt from argv positional
    // tokens, NOT stdin. Detect by command name (matches both `makestudio` in
    // PATH and absolute path resolved via process.argv[1]) and append the
    // prompt as the last positional arg. claude/codex/gemini all read stdin,
    // so we keep the existing pipe-write path for them.
    const cmdBase = require('path').basename(args.cliCommand);
    const isMakestudio = cmdBase === 'makestudio' || cmdBase === 'ms' || /makestudio/.test(args.cliCommand);
    const finalArgs = isMakestudio ? [...args.cliArgs, args.prompt] : args.cliArgs;

    const proc: ChildProcess = spawn(args.cliCommand, finalArgs, {
      cwd: args.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });

    const onAbort = () => {
      try { proc.kill('SIGKILL'); } catch (err) { swallow(err); }
    };
    args.signal?.addEventListener('abort', onAbort);

    if (!isMakestudio) {
      proc.stdin?.write(args.prompt);
    }
    proc.stdin?.end();

    let stderr = '';
    // When invoking makestudio with --json, parse JSONL events on the fly
    // and forward each formatted line to the parent's stdout. This is what
    // turns the previously silent subprocess into a live transcript of
    // tool calls + assistant text.
    const useJsonl = isMakestudio && args.cliArgs.includes('--json');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JsonlStreamReader, dimC } = require('./jsonl-stream-formatter');
    const stdoutReader = useJsonl ? new JsonlStreamReader(`  ${dimC('│')}    `) : null;
    const stderrReader = useJsonl ? new JsonlStreamReader(`  ${dimC('│')}    `) : null;

    proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      debugStream?.write(`[stderr] ${s}`);
      if (stderrReader) {
        for (const f of stderrReader.push(d)) process.stdout.write(f.display + '\n');
      }
    });
    // Mirror stdout to debug log (if enabled) — useful to understand what the
    // CLI actually did when it didn't produce expected files.
    proc.stdout?.on('data', (d: Buffer) => {
      debugStream?.write(d);
      if (stdoutReader) {
        for (const f of stdoutReader.push(d)) process.stdout.write(f.display + '\n');
      }
    });

    proc.on('close', () => {
      args.signal?.removeEventListener('abort', onAbort);
      if (stdoutReader) for (const f of stdoutReader.flush()) process.stdout.write(f.display + '\n');
      if (stderrReader) for (const f of stderrReader.flush()) process.stdout.write(f.display + '\n');
      try { debugStream?.end(); } catch (err) { swallow(err); }
      // Compare each dum_*.json against its pre-spawn snapshot. New files
      // → kind='new'; existing files whose mtime AND content-hash both
      // changed → kind='modified'. We require BOTH because some editors
      // touch mtime without writing (and our `before` snapshot of the
      // hash for a missing file is empty, never matching).
      try {
        if (!fs.existsSync(dumsDir)) return resolve([]);
        const written: WrittenFile[] = [];
        for (const f of fs.readdirSync(dumsDir)) {
          if (!/^dum_\d+\.json$/.test(f)) continue;
          const full = path.join(dumsDir, f);
          const prev = before.get(f);
          if (!prev) {
            written.push({ path: full, kind: 'new' });
            continue;
          }
          let stat: fs.Stats;
          try { stat = fs.statSync(full); } catch { continue; }
          if (stat.mtimeMs <= prev.mtime) continue; // no touch
          const newHash = snapshotHash(full);
          if (!newHash || newHash === prev.hash) continue; // touched but identical
          written.push({ path: full, kind: 'modified' });
        }
        resolve(written);
      } catch (err: any) {
        reject(new Error(`Failed to diff dums dir after CLI: ${err.message}\nstderr: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (err: Error) => {
      args.signal?.removeEventListener('abort', onAbort);
      try { debugStream?.end(); } catch (err) { swallow(err); }
      reject(err);
    });
  });
}
