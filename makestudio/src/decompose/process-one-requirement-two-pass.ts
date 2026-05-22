import { swallow } from '../utils/log';
/**
 * Two-pass requirement decomposition: structure-pass → enrich-pass +
 * validate + save. Extracted from runPerRequirementLoop so the loop
 * orchestration stays small (worker pool, telemetry bookkeeping, exit
 * conditions) and this big body is testable in isolation.
 *
 * Mutable state (saved counter, existingDums snapshot,
 * failedRequirements list) lives on `ctx.state` so mutations are
 * visible to the caller without ref-passing each scalar.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Requirement, LoopOptions, LoopResult, ExistingDumSummary } from './types';
import type { TelemetryLogger } from './telemetry';
import type { DumStructure } from './structure-pass';
import type { FixPassIssue } from './fix-pass';
import { runStructurePass } from './structure-pass';
import { runEnrichPass } from './enrich-pass';
import { runFixPass } from './fix-pass';
import { fetchExistingDums, listDumFiles, severityRank } from './loop-helpers';

export interface TwoPassCtx {
  options: LoopOptions;
  telemetry: TelemetryLogger;
  workQueueLength: number;
  maxRetries: number;
  state: {
    saved: number;
    existingDums: ExistingDumSummary[];
    failedRequirements: LoopResult['failedRequirements'];
  };
}

export async function processOneRequirementTwoPass(
i: number,
workerId: number,
req: Requirement,
ctx: TwoPassCtx,
): Promise<void> {
const { options, telemetry, workQueueLength, maxRetries, state } = ctx;
  if (options.signal?.aborted) {
    throw Object.assign(new Error('Decomposition cancelled by user'), { aborted: true });
  }
  void workerId;

  options.onProgress?.({
    type: 'req-start',
    reqIndex: i,
    reqTotal: workQueueLength,
    reqTitle: req.title,
  });
  const reqStartedAt = Date.now();
  telemetry.record({
    type: 'req-start',
    reqIndex: i,
    reqId: req.id,
    reqTitle: req.title.slice(0, 80),
  });

  let firstWriteAt = 0;
  let totalValidateMs = 0;
  let totalSaveMs = 0;
  let dumsSaved = 0;
  let lastCauseOfRetry: string | undefined;
  let succeeded = false;
  let attemptsUsed = 0;

  // Reserve tempIds for this req — same logic as the legacy path.
  let maxBackendNumber = 1;
  for (const d of state.existingDums) {
    const m = String(d.dumNumber || d.tempId || '').match(/(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > maxBackendNumber) maxBackendNumber = n;
    }
  }
  let maxDiskNumber = 1;
  try {
    for (const p of await listDumFiles(options.cwd)) {
      const m = path.basename(p).match(/^dum_(\d+)\.json$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n) && n > maxDiskNumber) maxDiskNumber = n;
      }
    }
  } catch (err) { swallow(err); }
  const nextDumNumber = Math.max(maxBackendNumber, maxDiskNumber) + 1;
  const reservedTempIds = Array.from({ length: 5 }, (_, k) =>
    `dum_${String(nextDumNumber + k).padStart(3, '0')}`,
  );

  // ── Pass 1: structure ─────────────────────────────────────────
  let structures: DumStructure[] = [];
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    attemptsUsed = attempt;
    try {
      telemetry.record({
        type: 'cli-spawned',
        reqIndex: i,
        reqId: req.id,
        attempt,
        promptBytes: 1500, // structure prompt is fixed-tiny
      });
      const res = await runStructurePass(
        {
          id: req.id,
          title: req.title,
          description: req.description,
          type: req.type,
          priority: req.priority,
          acceptanceCriteria: req.acceptanceCriteria,
        },
        state.existingDums.map((d) => ({
          tempId: d.tempId,
          dumNumber: d.dumNumber,
          title: d.title,
          type: d.type,
        })),
        reservedTempIds,
        {
          cwd: options.cwd,
          cliCommand: options.cliCommand,
          cliArgs: options.cliArgs,
          signal: options.signal,
        },
      );
      structures = res.dums;
      if (firstWriteAt === 0) {
        firstWriteAt = Date.now();
        telemetry.record({
          type: 'first-write',
          reqIndex: i,
          reqId: req.id,
          attempt,
          sinceSpawnMs: res.cliDurationMs,
          tempId: structures[0]?.tempId,
        });
      }
      if (structures.length > 0) break;
    } catch (err: any) {
      lastCauseOfRetry = `structure-pass-failed:${(err.message || 'unknown').slice(0, 40)}`;
    }
    if (attempt > maxRetries) {
      state.failedRequirements.push({
        id: req.id,
        title: req.title,
        reason: lastCauseOfRetry || 'structure pass produced 0 DUMs',
      });
      options.onProgress?.({
        type: 'req-failed',
        reqIndex: i,
        reason: lastCauseOfRetry || 'structure pass produced 0 DUMs',
      });
    } else {
      telemetry.record({
        type: 'req-retry',
        reqIndex: i,
        reqId: req.id,
        attempt,
        cause: lastCauseOfRetry || 'structure-pass-empty',
        failingTempIds: [],
      });
    }
  }

  if (structures.length > 0) {
    // ── Pass 2: enrich ─────────────────────────────────────────
    //
    // Concurrency: 2 by default (Anthropic/OpenAI handle that fine).
    // Drop to 1 for `makestudio` (self-hosted) and `gemini` (free-tier
    // rate cap) — paralelism on those providers ends in one of the two
    // calls timing out at 5min while the other succeeds. Override with
    // MAKESTUDIO_ENRICH_PARALLEL=N if a tenant's quota allows more.
    const envParallel = parseInt(process.env.MAKESTUDIO_ENRICH_PARALLEL || '', 10);
    const defaultParallel = options.cli === 'makestudio' || options.cli === 'gemini' ? 1 : 2;
    const PARALLEL = Number.isFinite(envParallel) && envParallel > 0
      ? Math.min(envParallel, 8)
      : defaultParallel;
    const enrichErrors: string[] = [];
    for (let waveStart = 0; waveStart < structures.length; waveStart += PARALLEL) {
      const wave = structures.slice(waveStart, waveStart + PARALLEL);
      const results = await Promise.allSettled(
        wave.map((s) =>
          runEnrichPass(s, {
            cwd: options.cwd,
            cliCommand: options.cliCommand,
            cliArgs: options.cliArgs,
            signal: options.signal,
            briefing: options.briefing,
            outputLanguage: options.outputLanguage,
            existingDums: state.existingDums.map((d) => ({
              tempId: d.tempId || d.dumNumber || '',
              title: d.title,
              type: d.type,
            })),
            // Pass the api client so enrich-pass can fetch the
            // backend's REQUIRED_SECTIONS_BY_TYPE and inject the exact
            // section names the gate expects for this DUM's type. No
            // client-side hardcoding of the map.
            api: options.api,
          }),
        ),
      );
      for (let idx = 0; idx < results.length; idx++) {
        const s = wave[idx];
        const r = results[idx];
        if (r.status === 'rejected' || !r.value.written || !r.value.dumPath) {
          enrichErrors.push(`${s.tempId}: ${r.status === 'rejected' ? r.reason : 'no file written'}`);
          continue;
        }
        // Validate + save the freshly enriched DUM via the existing flow.
        try {
          const raw = fs.readFileSync(r.value.dumPath, 'utf8');
          const dum = JSON.parse(raw);
          const validateStartedAt = Date.now();
          telemetry.record({
            type: 'validate-start',
            reqIndex: i,
            reqId: req.id,
            tempId: dum.tempId || s.tempId,
            setLevel: false,
          });
          const validation = await options.api.post(
            `/dark-factory/projects/${options.projectId}/dums/validate-iso?setLevel=false`,
            { dum },
            { timeout: 20_000 },
          );
          const validateDurationMs = Date.now() - validateStartedAt;
          totalValidateMs += validateDurationMs;
          const result = validation.data;
          const passed = result.verdict === 'passed';
          const issuesCount = result.perTask?.reduce(
            (acc: number, pt: any) => acc + (pt.issues?.length || 0),
            0,
          ) || 0;
          const topCriterion = ((result.perTask || [])
            .flatMap((pt: any) => pt.issues || [])
            .sort((a: any, b: any) => severityRank(b.severity) - severityRank(a.severity))[0] || {})
            .criterion;
          telemetry.record({
            type: 'validate-end',
            reqIndex: i,
            reqId: req.id,
            tempId: dum.tempId || s.tempId,
            passed,
            issuesCount,
            durationMs: validateDurationMs,
            topCriterion,
          });
          if (passed) {
            const saveStartedAt = Date.now();
            await options.api.post(
              `/dark-factory/projects/${options.projectId}/save-decomposition`,
              { dums: [dum], requirementIds: [req.id] },
              { timeout: 30_000 },
            );
            const saveDurationMs = Date.now() - saveStartedAt;
            totalSaveMs += saveDurationMs;
            telemetry.record({
              type: 'save-end',
              reqIndex: i,
              reqId: req.id,
              tempId: dum.tempId || s.tempId,
              durationMs: saveDurationMs,
              success: true,
            });
            state.saved++;
            dumsSaved++;
            options.onProgress?.({
              type: 'req-saved',
              reqIndex: i,
              tempId: dum.tempId || s.tempId,
            });
          } else {
            // Phase 4 — try a focused fix pass before giving up.
            // The fix-pass uses ONLY the Edit tool with a tiny prompt
            // (no QUALITY_CONTRACT, no briefing) — much faster and
            // more effective than rerunning the full enrich.
            //
            // Default 3 attempts (was 2). Each attempt re-pulls the
            // current issues from validate-iso so the prompt always
            // reflects what's broken NOW, not what was broken when we
            // entered the loop. A fix that resolves issue 1 but
            // creates issue 5 stays accurate for the next iteration.
            const maxFixAttempts = Math.max(
              1,
              Math.min(parseInt(process.env.MAKESTUDIO_FIX_PASS_ATTEMPTS || '3', 10) || 3, 10),
            );
            const collectIssues = (perTask: any[]): FixPassIssue[] => (perTask || [])
              .flatMap((pt: any) =>
                (pt.issues || []).map((iss: any) => ({
                  criterion: iss.criterion,
                  severity: iss.severity,
                  code: iss.code,
                  message: iss.message,
                  fixHint: iss.fixHint,
                  taskTitle: pt.taskTitle,
                })),
              );
            let issuesForFix: FixPassIssue[] = collectIssues(result.perTask || []);
            let lastIssuesCount = issuesCount;
            let lastTopCriterion = topCriterion;
            let fixSucceeded = false;
            for (let fixAttempt = 1; fixAttempt <= maxFixAttempts && !fixSucceeded; fixAttempt++) {
              const fixRes = await runFixPass(r.value.dumPath, issuesForFix, {
                cwd: options.cwd,
                cliCommand: options.cliCommand,
                cliArgs: options.cliArgs,
                signal: options.signal,
              });
              if (!fixRes.modified) break; // CLI didn't touch the file — no point retrying
              // Re-validate after fix
              const reRaw = fs.readFileSync(r.value.dumPath, 'utf8');
              const reDum = JSON.parse(reRaw);
              const reValStarted = Date.now();
              const reVal = await options.api.post(
                `/dark-factory/projects/${options.projectId}/dums/validate-iso?setLevel=false`,
                { dum: reDum },
                { timeout: 20_000 },
              );
              totalValidateMs += Date.now() - reValStarted;
              if (reVal.data?.verdict === 'passed') {
                await options.api.post(
                  `/dark-factory/projects/${options.projectId}/save-decomposition`,
                  { dums: [reDum], requirementIds: [req.id] },
                  { timeout: 30_000 },
                );
                state.saved++;
                dumsSaved++;
                fixSucceeded = true;
                options.onProgress?.({
                  type: 'req-saved',
                  reqIndex: i,
                  tempId: reDum.tempId || s.tempId,
                });
                telemetry.record({
                  type: 'save-end',
                  reqIndex: i,
                  reqId: req.id,
                  tempId: reDum.tempId || s.tempId,
                  durationMs: 0,
                  success: true,
                });
              } else {
                // Refresh issue list for the next iteration so the
                // fix-pass prompt always reflects what's actually
                // broken NOW (an Edit can resolve some and create
                // others). Without this the prompt stayed stale and
                // the LLM kept "fixing" already-resolved issues.
                issuesForFix = collectIssues(reVal.data?.perTask || []);
                lastIssuesCount = issuesForFix.length;
                lastTopCriterion = (issuesForFix
                  .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0] || {})
                  .criterion;
                if (issuesForFix.length === 0) {
                  // Edge case: gate now passes with no issues but
                  // verdict wasn't 'passed' (set-level off). Save
                  // anyway since per-task is clean.
                  fixSucceeded = true;
                  await options.api.post(
                    `/dark-factory/projects/${options.projectId}/save-decomposition`,
                    { dums: [reDum], requirementIds: [req.id] },
                    { timeout: 30_000 },
                  );
                  state.saved++;
                  dumsSaved++;
                  options.onProgress?.({
                    type: 'req-saved',
                    reqIndex: i,
                    tempId: reDum.tempId || s.tempId,
                  });
                }
              }
            }
            if (!fixSucceeded) {
              // Persist the DUM with its current (failing) content so
              // the backend's quality gate marks the offending tasks
              // as `held`. The user can then trigger reanalyze (Opus
              // + extended thinking) or manual edit from the
              // dashboard's Quality Hold tab. Without this the DUM
              // would only exist on the agent's disk — invisible to
              // the dashboard, no recovery path for the operator.
              try {
                const finalRaw = fs.readFileSync(r.value.dumPath, 'utf8');
                const finalDum = JSON.parse(finalRaw);
                await options.api.post(
                  `/dark-factory/projects/${options.projectId}/save-decomposition`,
                  { dums: [finalDum], requirementIds: [req.id] },
                  { timeout: 30_000 },
                );
                // Count as "saved with hold" — different from clean
                // save but still a real artifact in the backend.
                state.saved++;
                dumsSaved++;
                options.onProgress?.({
                  type: 'req-saved',
                  reqIndex: i,
                  tempId: finalDum.tempId || s.tempId,
                });
                telemetry.record({
                  type: 'save-end',
                  reqIndex: i,
                  reqId: req.id,
                  tempId: finalDum.tempId || s.tempId,
                  durationMs: 0,
                  success: true,
                });
                enrichErrors.push(`${s.tempId}: held with ${lastIssuesCount} issue(s) (${lastTopCriterion || 'unknown'}) — visible in /quality-hold`);
              } catch (saveErr: any) {
                enrichErrors.push(`${s.tempId}: ${lastIssuesCount} issues (${lastTopCriterion || 'unknown'}); save-with-hold failed: ${saveErr?.message || 'unknown'}`);
              }
              lastCauseOfRetry = `enrich:${lastTopCriterion || 'unknown'}`;
            }
          }
        } catch (err: any) {
          enrichErrors.push(`${s.tempId}: ${err.message || 'save/validate failed'}`);
        }
      }
    }
    succeeded = enrichErrors.length === 0;
    if (!succeeded) {
      // Phase-4 will introduce a dedicated fix-pass; for now, surface
      // the failure via the existing channel.
      state.failedRequirements.push({
        id: req.id,
        title: req.title,
        reason: `two-pass enrich incomplete: ${enrichErrors.slice(0, 3).join('; ')}`,
      });
      options.onProgress?.({
        type: 'req-failed',
        reqIndex: i,
        reason: enrichErrors.join('; ').slice(0, 200),
      });
    }
    // Refresh existing DUMs once per req (same as legacy path).
    state.existingDums = await fetchExistingDums(options.api, options.projectId);
  }

  const reqEndedAt = Date.now();
  telemetry.record({
    type: 'req-end',
    reqIndex: i,
    reqId: req.id,
    reqTitle: req.title.slice(0, 80),
    success: succeeded,
    retryCount: Math.max(0, attemptsUsed - 1),
    dumsSaved,
    timeToFirstWriteMs: firstWriteAt > 0 ? firstWriteAt - reqStartedAt : 0,
    timeToValidateMs: totalValidateMs,
    timeToSaveMs: totalSaveMs,
    totalDurationMs: reqEndedAt - reqStartedAt,
    causeOfRetry: lastCauseOfRetry,
  });
}
