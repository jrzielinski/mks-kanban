import { swallow } from '../../../utils/log';
/**
 * Advanced tool — plan-mode topic. Extracted from advanced-tools.ts.
 */
/**
 * advanced-tools.ts
 *
 * Additional code-agent tools:
 *   - LSP (semantic code nav: definition, references, implementation, hover,
 *     workspaceSymbol, documentSymbol, callHierarchy)
 *   - TodoWrite (in-session task list managed by the LLM)
 *   - AskUserQuestion (LLM-driven multi-choice clarification with "Other")
 *   - BackgroundTask (TaskCreate/Output/Status/Stop/List — non-blocking shell)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { ReplContext } from '../../context';
import { ToolDefinition } from '../tools';
import {
  lspDefinition,
  lspDefinitionAt,
  lspReferences,
  lspReferencesAt,
  lspHover,
  lspDocumentSymbols,
  lspImplementation,
  lspWorkspaceSymbols,
  lspIncomingCalls,
  lspOutgoingCalls,
} from '../../lsp';
import {
  enterWorktreeForDum,
  exitWorktreeAndMerge,
  exitWorktreeAndDiscard,
  canEnterWorktree,
  WorktreeHandle,
} from '../../../core/worktree';

// ── Plan mode tools (ported 1:1 from Claude Code's EnterPlanModeTool + ─────
// ExitPlanModeV2Tool). Architecture notes:
//
// - Enter records the plan file path + a snapshot of its initial content so
//   we can detect "planWasEdited" later (Claude Code uses CCR web-UI edits;
//   we detect disk delta instead).
// - Exit requires EXPLICIT user approval via the TUI bridge (same
//   pendingQuestion pattern as AskUserQuestion). If the user declines,
//   plan mode STAYS active.
// - On approval, the plan content is echoed back in the tool_result so the
//   agent has it in context for implementation. Matches Claude Code's
//   `mapToolResultToToolResultBlockParam` output.
// - `allowedPrompts` are stored on state for the Bash blocker to consult
//   (pre-authorised semantic permissions like "run tests").
// - Claude Code's VerifyPlanExecutionTool is a stub in the open source
//   build — not ported.

import {
  ENTER_PLAN_MODE_PROMPT,
  EXIT_PLAN_MODE_PROMPT,
  ENTER_PLAN_MODE_WORKFLOW_MESSAGE,
} from '../plan-mode-prompts';

// Re-export the AllowedBashPrompt type from context under the original name
// (kept for call-site stability; plan mode code used `AllowedPrompt` before
// the permission-mode refactor).
export type AllowedPrompt = import('../../context').AllowedBashPrompt;

export function isPlanModeActive(ctx: ReplContext): boolean {
  return ctx.permissionMode === 'plan';
}

export function getPlanFilePath(ctx: ReplContext): string | null {
  return ctx.planFilePath;
}

/** Pre-authorised Bash prompts carried over from the last approved plan. */
export function getAllowedBashPrompts(ctx: ReplContext): AllowedPrompt[] {
  return ctx.planAllowedBashPrompts;
}

// Stopwords stripped before matching prompt tokens against commands. Keep
// small — over-filtering loses signal ("run", "tests" both matter).
export const PROMPT_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with',
  'my', 'any', 'all', 'some', 'it', 'this', 'that',
]);

export function tokenize(s: string): string[] {
  return s.toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .map(t => t.endsWith('s') && t.length > 3 ? t.slice(0, -1) : t); // naive singularisation
}

/**
 * Check whether `command` semantically matches one of the pre-authorised
 * `allowedPrompts`. Returns the matching prompt, or null.
 *
 * Algorithm:
 *  1. Tokenise both sides (lowercase, alphanum only, naive singularise —
 *     trailing 's' stripped on tokens >3 chars so "tests"→"test").
 *  2. Drop stopwords from the prompt side.
 *  3. Require at least ceil(promptTokens.length / 2) prompt tokens to
 *     appear as EXACT matches in the command tokens (min 1 hit).
 *
 * Exact-only on purpose. Substring matching catches `pytest`/"run tests"
 * but also false-positives `latest`/"run tests". Safety > convenience —
 * a missed match just asks the user; a wrong match auto-runs a command
 * the user didn't expect. Users can add more specific allowedPrompts
 * (e.g. "pytest") to cover exotic test runners.
 */
export function matchAllowedBashPrompt(command: string, prompts: AllowedPrompt[]): AllowedPrompt | null {
  if (!command || !prompts || prompts.length === 0) return null;
  const cmdSet = new Set(tokenize(command));
  if (cmdSet.size === 0) return null;
  for (const p of prompts) {
    if (p.tool !== 'Bash') continue;
    const rawTokens = tokenize(p.prompt).filter(t => !PROMPT_STOPWORDS.has(t));
    if (rawTokens.length === 0) continue;
    const needed = Math.max(1, Math.ceil(rawTokens.length / 2));
    let hits = 0;
    for (const t of rawTokens) {
      if (cmdSet.has(t)) hits++;
    }
    if (hits >= needed) return p;
  }
  return null;
}

export const planModeToolDefinitions: ToolDefinition[] = [
  {
    name: 'EnterPlanMode',
    // The full description (with the "use for refactors / multi-file
    // changes" rules-of-thumb and worked examples) lives in
    // ENTER_PLAN_MODE_PROMPT. Wiring the short tagline that used to be
    // here gave the LLM no concrete trigger criteria, so plan mode never
    // got entered for refactors that should have used it.
    description: ENTER_PLAN_MODE_PROMPT,
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ExitPlanMode',
    description: EXIT_PLAN_MODE_PROMPT,
    input_schema: {
      type: 'object',
      properties: {
        allowedPrompts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: ['Bash'], description: "The tool this prompt applies to. Only 'Bash' is supported." },
              prompt: { type: 'string', description: 'Semantic description of the action, e.g. "run tests", "install dependencies".' },
            },
            required: ['tool', 'prompt'],
          },
          description: 'Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.',
        },
      },
      required: [],
    },
  },
  // MakeStudio-exclusive: quick status probe so the agent (or the user via
  // manual inspection) can ask "am I still in plan mode and where's the
  // plan file?" without attempting to exit. Claude Code doesn't have this
  // because their architecture surfaces the state via system attachments.
  {
    name: 'PlanModeStatus',
    description: 'Report whether plan mode is active and where the plan file is. Read-only — does not exit plan mode.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

export function enterPlanModeImpl(_input: any, ctx: ReplContext): string {
  if (ctx.permissionMode === 'plan') {
    throw new Error('Already in plan mode.');
  }
  const root = ctx.activeProject?.localPath || ctx.cwd;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const planDir = path.join(root, '.makestudio', 'plans');
  fs.mkdirSync(planDir, { recursive: true });
  const planFilePath = path.join(planDir, `session-${stamp}.md`);
  // Do NOT pre-create the file — the Write tool guards against overwriting
  // an existing file without a prior Read, and pre-creating an empty plan
  // file would trip that guard on the agent's first Write attempt.
  // State machine transition: save previous mode, enter 'plan'.
  ctx.prePlanMode = ctx.permissionMode;
  ctx.permissionMode = 'plan';
  ctx.planFilePath = planFilePath;
  ctx.planEnteredAt = Date.now();
  // Match Claude Code's mapToolResultToToolResultBlockParam: canned workflow
  // message so the model knows the exploration/plan-file rules.
  return `${ENTER_PLAN_MODE_WORKFLOW_MESSAGE}\n\nPlan file path: ${planFilePath}`;
}

type PlanApprovalDecision = 'approve' | 'reject' | 'edit';

export async function requestPlanApproval(
  planContent: string,
  filePath: string,
  sharedRl?: any,
): Promise<PlanApprovalDecision> {
  const { getTuiBridge, setPendingQuestion } = require('../../tui/bridge');
  const bridge = getTuiBridge?.();
  // Render the plan through our markdown pipeline so headings/tables/code
  // blocks aren't shown as raw `##` / `|` / backticks. Bridge's info role
  // treats the text as plain, so we pre-render to ANSI here.
  let preview: string;
  if (planContent.trim()) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { applyMarkdown } = require('../../markdown');
      preview = '\n' + applyMarkdown(planContent).trimEnd() + '\n';
    } catch {
      preview = '\n' + planContent.trimEnd() + '\n';
    }
  } else {
    preview = '\n(plan file is empty)\n';
  }
  const questionBody = `The assistant has finished planning and requests approval to exit plan mode and begin implementation.\n\nPlan file: ${filePath}\n${preview}\nExit plan mode and start coding?`;
  const promptLabel = 'Approve? [y=yes · e=edit · N=no]';

  let raw: string;
  if (bridge) {
    bridge.addMessage({ role: 'info', text: questionBody });
    bridge.addMessage({ role: 'info', text: `→ ${promptLabel}` });
    raw = await new Promise<string>((resolve) => {
      setPendingQuestion({ resolve, placeholder: promptLabel });
    });
  } else {
    // Non-TUI fallback — caller must share one readline across the loop
    // iterations so edit→approve/reject doesn't drop stdin between
    // questions.
    raw = await new Promise<string>((resolve) => {
      sharedRl.question(`${questionBody}\n${promptLabel}: `, (a: string) => resolve(a));
    });
  }

  const a = (raw || '').trim().toLowerCase();
  if (a === 'y' || a === 'yes' || a === 's' || a === 'sim') return 'approve';
  if (a === 'e' || a === 'edit') return 'edit';
  return 'reject';
}

/**
 * Launch the user's $EDITOR on the plan file. In TUI mode Ink is unmounted
 * around the editor so it gets a real inherited stdio; re-mounted after.
 * Returns the new plan content read from disk.
 */
export function editPlanInEditor(filePath: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lifecycle = require('../../lifecycle');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bridgeMod = require('../../tui/bridge');
  const tuiActive = !!bridgeMod.getTuiBridge?.();
  if (tuiActive) lifecycle.destroyRepl();
  try {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    // execSync with stdio:inherit gives the editor a real TTY
    spawnSync(editor, [filePath], { stdio: 'inherit' });
  } catch (err) { swallow(err); }
  if (tuiActive) lifecycle.recreateRepl();
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

export async function exitPlanModeImpl(input: any, ctx: ReplContext): Promise<string> {
  if (ctx.permissionMode !== 'plan' || !ctx.planFilePath) {
    // Mirror Claude Code's validateInput error: returning a descriptive
    // error rather than throwing lets the model recover.
    return JSON.stringify({
      error: 'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.',
    });
  }
  const planFilePath = ctx.planFilePath;

  const allowedPrompts: AllowedPrompt[] = Array.isArray(input?.allowedPrompts)
    ? input.allowedPrompts.filter((p: any) => p && p.tool === 'Bash' && typeof p.prompt === 'string').slice(0, 20)
    : [];

  let planContent = '';
  try { planContent = fs.readFileSync(planFilePath, 'utf8'); } catch (err) { swallow(err); }

  // Reject empty plans — the model MUST write the plan file before asking
  // for approval. Otherwise the user gets an approval dialog for an empty
  // document, which is useless and confusing. This also forces weaker
  // models (gpt-oss-20b was caught shipping empty plans) to actually do
  // the planning work.
  const MIN_PLAN_CHARS = 80; // arbitrary floor — a plan in fewer chars isn't a plan
  const trimmed = planContent.trim();
  if (trimmed.length < MIN_PLAN_CHARS) {
    return JSON.stringify({
      error: `Plan file is empty or too short (${trimmed.length} chars; need ≥ ${MIN_PLAN_CHARS}). ` +
        `You MUST write the plan to ${planFilePath} BEFORE calling ExitPlanMode. ` +
        `Use the Write tool with file_path="${planFilePath}" and content="<full plan in markdown>" ` +
        `(overview, files to touch, approach per step, risks, acceptance criteria). ` +
        `Then call ExitPlanMode again.`,
    });
  }

  // Approval loop: user picks y/n/e. "e" opens $EDITOR on the plan file,
  // then we re-read the content and re-prompt. Sets wasEdited=true so the
  // final tool_result labels the plan as "edited by user" — this is our
  // local-filesystem analog of Claude Code's CCR web-UI edit signal.
  let wasEdited = false;
  // TUI uses bridge.pendingQuestion per iteration (stateless); non-TUI needs
  // a single readline so stdin survives across the loop's iterations.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bridgeActive = !!require('../../tui/bridge').getTuiBridge?.();
  const sharedRl = bridgeActive ? undefined : (() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const readline = require('readline');
    return readline.createInterface({ input: process.stdin, output: process.stdout });
  })();
  try {
    for (;;) {
      const decision = await requestPlanApproval(planContent, planFilePath, sharedRl);
      if (decision === 'approve') break;
      if (decision === 'reject') {
        // Stay in plan mode.
        return JSON.stringify({
          error: 'User rejected plan approval. You are still in plan mode. Revise the plan file and call ExitPlanMode again, or use AskUserQuestion to clarify what they want changed.',
        });
      }
      // decision === 'edit'
      planContent = editPlanInEditor(planFilePath);
      wasEdited = true;
    }
  } finally {
    sharedRl?.close();
  }

  // Approved: commit state transition. Restore prePlanMode (Claude Code
  // analog: `toolPermissionContext.mode = prePlanMode ?? 'default'`).
  ctx.permissionMode = ctx.prePlanMode ?? 'default';
  ctx.prePlanMode = null;
  ctx.planFilePath = null;
  ctx.planEnteredAt = 0;
  ctx.planAllowedBashPrompts = allowedPrompts;

  // Echo the plan back in the tool_result (matches Claude Code's
  // mapToolResultToToolResultBlockParam output so the agent has the plan
  // in its context for the next turn). Label reflects whether the user
  // touched the plan via $EDITOR during approval — matches Claude Code's
  // "edited by user" variant, just sourced from our local edit loop
  // instead of their CCR web UI.
  // The user was told about these Bash actions in the plan — surface them
  // back and inform the model that the MakeStudio Bash gate will
  // auto-approve commands that semantically match one of these prompts
  // (token-overlap matcher in advanced-tools.matchAllowedBashPrompt).
  const bashHint = allowedPrompts.length > 0
    ? `\n\nPre-authorised Bash actions (commands whose tokens overlap with these prompts will skip the per-command approval dialog):\n${allowedPrompts.map(p => `  - ${p.prompt}`).join('\n')}`
    : '';

  if (!planContent || planContent.trim() === '') {
    return `User has approved exiting plan mode. You can now proceed.${bashHint}`;
  }

  const planLabel = wasEdited ? 'Approved Plan (edited by user)' : 'Approved Plan';
  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${planFilePath}
You can refer back to it if needed during implementation.${bashHint}

## ${planLabel}:
${planContent}`;
}

export function planModeStatusImpl(_input: any, ctx: ReplContext): string {
  if (ctx.permissionMode !== 'plan' || !ctx.planFilePath) {
    return JSON.stringify({
      active: false,
      permission_mode: ctx.permissionMode,
      previously_approved_bash_prompts: ctx.planAllowedBashPrompts.length > 0 ? ctx.planAllowedBashPrompts : undefined,
    }, null, 2);
  }
  let planSize = 0;
  let planExists = false;
  try {
    const stat = fs.statSync(ctx.planFilePath);
    planSize = stat.size;
    planExists = true;
  } catch (err) { swallow(err); }
  return JSON.stringify({
    active: true,
    permission_mode: ctx.permissionMode,
    pre_plan_mode: ctx.prePlanMode,
    plan_file_path: ctx.planFilePath,
    plan_file_exists: planExists,
    plan_bytes: planSize,
    duration_ms: Date.now() - ctx.planEnteredAt,
    hint: 'Write your plan to plan_file_path (Write tool works for this one file). Call ExitPlanMode when done — it will ask the user for approval.',
  }, null, 2);
}

