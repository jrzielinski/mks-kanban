/**
 * Shared types for the per-requirement decomposition loop. Extracted
 * here so the loop's worker (process-one-requirement-two-pass.ts) and
 * helpers (loop-helpers.ts) can import without depending on the
 * top-level orchestrator file.
 */

export interface Requirement {
  id: string;
  title: string;
  description?: string;
  type?: string;
  priority?: string;
  acceptanceCriteria?: string[] | string;
}

export interface ExistingDumSummary {
  id: string;
  tempId: string | null;
  dumNumber: string;
  title: string;
  type: string;
  descriptionPreview: string;
}

export interface LoopOptions {
  api: any;
  projectId: string;
  cli: string;
  cwd: string;
  cliArgs: string[];
  cliCommand: string;
  signal?: AbortSignal;
  /** Max LLM retries per requirement when validation fails. */
  maxRetriesPerReq?: number;
  /**
   * Phase C — number of concurrent requirements processed in parallel.
   * Defaults to 1 (sequential, safe). Higher values speed up large projects
   * but multiply LLM usage and risk write contention on `_NEXT_DUM_ID`.
   * Recommended: 1 for now; raise via env MAKESTUDIO_PER_REQ_CONCURRENCY=N.
   */
  concurrency?: number;
  /**
   * Phase C — when true, the loop skips requirements that are already
   * marked decomposed in the backend. This makes the loop resumable: if
   * the agent crashes at req 30 of 80, the next run starts at 31.
   */
  resumeMode?: boolean;
  /**
   * Phase 3 — when true, each requirement goes through TWO CLI calls:
   *   1. structure-pass: produces a JSON list of DUM stubs (tempId,
   *      title, type, summary, dependsOn) — fast, ~1.5KB prompt
   *   2. enrich-pass: per stub, fills the description+tasks with the
   *      8 self-audit rules inlined at the BOTTOM of the prompt (in
   *      the recent-attention window)
   * The single-call legacy path is preserved for fallback. Toggle via
   * env MAKESTUDIO_TWO_PASS=1 (sets this option from runDecompose).
   */
  twoPass?: boolean;
  /**
   * Optional briefing snippet to include in enrich prompts so each DUM
   * is grounded in the project context.
   */
  briefing?: string;
  /** Output language for generated description+ACs (pt-BR/en/es/etc). */
  outputLanguage?: string;
  /** Stream progress callback. */
  onProgress?: (info: ProgressEvent) => void;
}

export type ProgressEvent =
  | { type: 'req-start'; reqIndex: number; reqTotal: number; reqTitle: string }
  | { type: 'req-attempt'; reqIndex: number; attempt: number; cliDurationMs: number }
  | { type: 'req-validation'; reqIndex: number; passed: boolean; issues: number; tempId: string }
  | { type: 'req-saved'; reqIndex: number; tempId: string }
  | { type: 'req-failed'; reqIndex: number; reason: string }
  | { type: 'req-skipped'; total: number; skipped: number }
  | { type: 'loop-complete'; total: number; saved: number; failed: number; cost: number };

export interface LoopResult {
  total: number;
  saved: number;
  failed: number;
  failedRequirements: Array<{ id: string; title: string; reason: string }>;
}
