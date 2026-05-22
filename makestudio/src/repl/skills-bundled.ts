/**
 * skills-bundled.ts — skills defined in TypeScript that ship with MakeStudio.
 *
 * Port of Claude Code's `src/skills/bundled/*.ts`. Each skill registers via
 * `registerBundledSkill()` at module load. Bundled skills:
 *   - can run arbitrary TS in `getPromptForCommand` (tail a log, probe git)
 *   - can gate via `isEnabled` (only surface in git repos, only when a
 *     provider is configured, etc.)
 *   - fall under bundled < user < project precedence in loadAllSkills
 *
 * To add a skill:
 *   1. registerBundledSkill({ name, description, ..., body | getPromptForCommand })
 *   2. (optional) update skills-bundled-test.cjs to cover it
 *   3. (nothing else) — router picks it up via /<name> and SkillTool + system
 *      prompt injection handle the rest.
 */

import * as fs from 'fs';
import * as path from 'path';
import { registerBundledSkill } from './skills-registry';

// ── /simplify — review + fix recently-edited code ──────────────────────────

const SIMPLIFY_BODY = `# Simplify: Code Review and Cleanup

Review recently-changed files on three axes (reuse, quality, efficiency),
then fix every issue found unless the user constrained scope.

## Phase 1 — Identify

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see
what changed. If there are no git changes, review the most recently modified
files the user mentioned or that you edited in this conversation.

## Phase 2 — Three-axis review

Walk the diff three times, each with a different lens.

**Reuse**: search for existing utilities that could replace newly-written
code. Flag new functions that duplicate existing functionality. Flag inline
logic that a helper would handle better.

**Quality**: redundant state (duplicating existing state, caching derivable
values); parameter sprawl; copy-paste with slight variation; leaky
abstractions; stringly-typed where enums exist; unnecessary JSX nesting;
comments that explain WHAT instead of WHY.

**Efficiency**: redundant computation; repeated file reads; sequential
operations that could be Promise.all; hot-path bloat; no-op updates inside
polling loops; TOCTOU pre-checks; unbounded data structures; overly broad
reads (whole file when a slice would do).

## Phase 3 — Fix

Apply every fix directly via Edit/MultiEdit. False positives: note and skip.
When done, output a one-paragraph summary: files touched, issues fixed,
issues skipped (with reason). No bullet lists longer than five items.
$ARGUMENTS`;

registerBundledSkill({
  name: 'simplify',
  description: 'Review recently-changed code for reuse, quality, and efficiency, then fix issues found.',
  whenToUse: 'Right after a substantial implementation — before reporting done — to catch redundancy, unnecessary abstractions, and missed reuse.',
  argumentHint: '[additional focus]',
  args: [],
  body: SIMPLIFY_BODY,
  userInvocable: true,
});

// ── /session-health — diagnose REPL issues via events.jsonl tail ───────────

registerBundledSkill({
  name: 'session-health',
  description: 'Diagnose MakeStudio REPL issues by reading the events log and recent errors.',
  whenToUse: 'When the user reports a bug, slowness, or unexpected behaviour in the REPL itself (not in their own code).',
  argumentHint: '[issue description]',
  args: [],
  body: '',
  userInvocable: true,
  disableModelInvocation: true, // user-only — don't let the model auto-fire this
  async getPromptForCommand(args, _cwd) {
    // Tail events.jsonl — bounded read so we never OOM on a 100MB file.
    const os = require('os');
    const file = path.join(os.homedir(), '.makestudio', 'events.jsonl');
    let tail = '';
    try {
      const stat = fs.statSync(file);
      const TAIL_BYTES = 64 * 1024;
      const start = Math.max(0, stat.size - TAIL_BYTES);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        tail = buf.toString('utf8').split('\n').slice(-30).join('\n');
      } finally { fs.closeSync(fd); }
    } catch { tail = '(no events.jsonl — logging may be disabled)'; }

    return `# Debug Session

The user is reporting a MakeStudio REPL issue.

## Issue

${args || '(no specific description — look for anomalies in the tail below)'}

## Recent events (last 30 lines of ~/.makestudio/events.jsonl)

\`\`\`
${tail}
\`\`\`

## Your task

1. Scan the tail for \`api_retry\`, \`api_retry_exhausted\`, \`max_tokens_hit\`,
   \`compact_failure\`, \`blocking_limit_hit\`, \`permission_denied\`, and
   tool_call entries with \`ok: false\`. Flag anything suspicious.
2. Cross-reference with the user's description.
3. Explain what you found in plain language (not raw JSON).
4. End with exactly one line: \`Suggested next step: <concrete action>\`.
`;
  },
});

// ── /remember — audit auto-memory and propose promotions ──────────────────

const REMEMBER_BODY = `# Remember — Memory review

Review every memory layer for the active project and report proposed changes.
Do NOT modify files; present proposals for the user to approve.

## Memory layers

| Layer                   | Where                                                                                              |
|-------------------------|----------------------------------------------------------------------------------------------------|
| Auto-memory             | \`~/.claude/projects/<cwd-slug>/memory/MEMORY.md\` + topic files                                  |
| Project CLAUDE.md       | \`<project>/CLAUDE.md\`                                                                            |
| User CLAUDE.md          | \`<project>/CLAUDE.local.md\`                                                                      |
| SessionMemory           | \`~/.makestudio/sessions/<sessionId>/session-memory.md\`                                           |

## Steps

1. Read every layer that exists. Quote only what you need.
2. For each auto-memory topic, decide its ideal destination:
   CLAUDE.md (team conventions) / CLAUDE.local.md (personal) /
   stay in auto-memory (working notes) / delete (duplicate or outdated).
3. Flag duplicates, contradictions, and stale facts.
4. Output four sections: Promotions / Cleanup / Ambiguous / No-action.

## Rules
- Present ALL proposals before touching anything.
- Never create a new CLAUDE.md without the user's explicit OK.
- Ask about ambiguous entries — don't guess.

$ARGUMENTS`;

registerBundledSkill({
  name: 'remember',
  description: 'Review auto-memory entries and propose promotions to CLAUDE.md / CLAUDE.local.md / deletion.',
  whenToUse: 'When memory has grown large or the user wants to clean up / promote observations into documented conventions.',
  argumentHint: '[additional focus]',
  args: [],
  body: REMEMBER_BODY,
  userInvocable: true,
});

// ── /loop — recurring prompts via CronCreate ───────────────────────────────

registerBundledSkill({
  name: 'loop',
  description: 'Schedule a prompt to run on a recurring interval (via CronCreate).',
  whenToUse: 'When the user wants a recurring task (e.g. "check the deploy every 10m", "run /babysit-prs every hour").',
  argumentHint: '[interval] <prompt>',
  args: [],
  body: '',
  userInvocable: true,
  async getPromptForCommand(args, _cwd) {
    const input = args.trim();
    if (!input) {
      return `# /loop — Schedule a recurring prompt

Usage: \`/loop [interval] <prompt>\`

Intervals: \`5m\`, \`30m\`, \`1h\`, \`2h\`, \`1d\`. Defaults to \`10m\` if no interval given.

Examples:
  /loop 5m /babysit-prs
  /loop 30m check the deploy
  /loop run tests every 20m
  /loop check the deploy          (10m default)

Reply with "Please provide an interval and a prompt." and stop.`;
    }
    return `# /loop — Schedule the prompt below

Parse the input below into \`[interval] <prompt…>\` and call \`CronCreate\`
with the resulting cron expression + prompt. Then confirm the schedule ID,
cron expression, human-readable cadence, and that the user can cancel via
\`CronDelete\`.

## Parsing rules (in priority order)

1. **Leading token** — if the first whitespace-delimited token matches
   \`^\\d+[smhd]$\` (e.g. \`5m\`, \`2h\`), that's the interval; the rest is
   the prompt.
2. **Trailing "every" clause** — if input ends with \`every <N><unit>\`
   (e.g. \`every 20m\`, \`every 2 hours\`), extract that as the interval
   and strip it. Only match when what follows "every" is a time expression.
3. **Default** — otherwise interval is \`10m\` and the whole input is the prompt.

## Interval to cron

- \`Nm\` where N ≤ 59 → \`*/N * * * *\`
- \`Nh\` where N ≤ 23 → \`0 */N * * *\`
- \`Nd\` → \`0 0 */N * *\`

If N doesn't divide cleanly, pick the nearest and tell the user what you rounded to.

## Input

${input}`;
  },
});

// ── /skillify — turn the current conversation into a reusable skill ────────

const SKILLIFY_BODY = `# /skillify — capture this workflow as a reusable skill

Look at the recent conversation (last ~20 messages) and extract a repeatable
workflow the user just performed. Propose a new Skill file:

1. Suggest a short \`name\` (kebab-case, verb-first when possible).
2. Write a one-line \`description\` and optional \`whenToUse\`.
3. Draft the skill \`body\` — the generalised instructions, parameterised
   via \`{{arg}}\` placeholders where the user entered specific values.
4. Propose to save it at \`<project>/.makestudio/skills/<name>.md\` (project
   scope) OR \`~/.makestudio/skills/<name>.md\` (user scope) — ask which.

Format the proposal as YAML frontmatter + body so the user can paste verbatim.
Do NOT write the file until the user confirms.

$ARGUMENTS`;

registerBundledSkill({
  name: 'skillify',
  description: 'Convert the current conversation workflow into a reusable skill file.',
  whenToUse: 'Right after a useful multi-step workflow that the user is likely to repeat with different inputs.',
  argumentHint: '[extra context]',
  args: [],
  body: SKILLIFY_BODY,
  userInvocable: true,
});


// ── /stuck — diagnose a slow/frozen MakeStudio process ────────────────────

const STUCK_BODY = `# /stuck — diagnose frozen or slow MakeStudio sessions

The user thinks another MakeStudio session on this machine is frozen, stuck,
or very slow. Investigate and report.

## What to look for

Scan for MakeStudio processes other than the current one (our PID is in
\`process.pid\`). Process names are typically \`makestudio\` or \`node\`
(invoked from the bundled dist/index.js).

Signs of a stuck session:
- **High CPU (>= 90%) sustained** — likely an infinite loop. Sample twice
  1-2s apart to confirm it's not a transient spike.
- **Process state 'D' (uninterruptible sleep)** — I/O hang. First char of
  the \`state\` column in \`ps\` output; ignore modifiers like \`+\`, \`s\`, \`<\`.
- **Process state 'T' (stopped)** — user probably hit Ctrl+Z accidentally.
- **Process state 'Z' (zombie)** — parent isn't reaping.
- **Very high RSS (>= 4GB)** — possible memory leak.
- **Stuck child process** — \`pgrep -lP <pid>\` surfaces children. A hung
  \`git\`, \`node\`, or \`typescript-language-server\` subprocess can freeze
  the parent.

## Investigation steps

1. List MakeStudio processes (macOS/Linux):
   \`\`\`
   ps -axo pid=,pcpu=,rss=,etime=,state=,comm=,command= | grep -E '(makestudio|dist/index.js)' | grep -v grep
   \`\`\`
2. For anything suspicious:
   - Children: \`pgrep -lP <pid>\`
   - Sustained CPU? Sample again in 1-2s.
   - If a child looks hung (git, node), grab its full command with
     \`ps -p <child_pid> -o command=\`.
   - Check \`~/.makestudio/events.jsonl\` tail for the suspected session;
     the last dozen events often show what it was doing before hanging.

## Report

Only recommend remediation if you actually found something stuck. If every
session looks healthy, tell the user that directly.

When you find something stuck, include:
- PID, CPU%, RSS, state, uptime, command line, child processes
- Your diagnosis of what's likely wrong
- Relevant events.jsonl tail

## Rules
- Do NOT kill or signal any processes — diagnostic only.
- If the user gave an argument (specific PID or symptom), focus there first.

$ARGUMENTS`;

registerBundledSkill({
  name: 'stuck',
  description: 'Diagnose frozen/slow MakeStudio sessions on this machine (process health + events.jsonl tail).',
  whenToUse: 'When the user reports one of their other terminals seems frozen or spinning at 100% CPU.',
  argumentHint: '[PID or symptom]',
  args: [],
  body: STUCK_BODY,
  userInvocable: true,
  allowedTools: ['Bash', 'Read', 'Grep'],
});


// ── /batch — large-scale refactor orchestration (lite version) ────────────

const BATCH_BODY = `# /batch — plan-then-parallel refactor

Orchestrate a sweeping mechanical change across the codebase by decomposing
into independent units, then dispatching read-only + write worktree agents
in waves.

IMPORTANT: This lite port does NOT spawn background worktree agents
automatically — MakeStudio's current agent fan-out is read-only and
sequential for writes. What this skill does:

1. Research (you, main agent)
2. Decompose into a plan with N work units
3. For each unit, execute sequentially with full test+commit cycle before
   moving on

## Phase 1 — Research and Plan

Call \`EnterPlanMode\` now, then:

1. **Scope** — use Grep/Glob (or dispatch_agents_parallel with explore agents)
   to understand what this touches: which files, which patterns, which call
   sites. Read representative samples to understand existing conventions.
2. **Decompose** — break the work into 3-8 self-contained units. Each unit:
   - Independently testable (small PR worth of work)
   - Follows the same conventions discovered in research
   - Roughly uniform size
3. **Verification recipe** — how do you VERIFY a unit works end-to-end
   after changes? (build passes, tests pass, curl an endpoint, visit a page)
4. **Write the plan** — numbered list of units, each with files + change + verify.
5. Call \`ExitPlanMode\` for approval.

## Phase 2 — Execute (sequential)

For each approved unit:
- Implement the change via Edit/MultiEdit
- Run the verification recipe
- If passing: commit with a conventional message; move to next
- If failing: diagnose, fix, re-verify

## Phase 3 — Summary

Render a final table: Unit / Status / Verified / Commit hash.

## User instruction

$ARGUMENTS`;

registerBundledSkill({
  name: 'batch',
  description: 'Plan a large-scale change then execute it in sequential units with test+commit between each.',
  whenToUse: 'For sweeping mechanical changes (migrations, renames, dependency swaps) that decompose into 3-8 independent units.',
  argumentHint: '<instruction>',
  args: [],
  body: BATCH_BODY,
  userInvocable: true,
  async getPromptForCommand(args, _cwd) {
    if (!args.trim()) {
      return `# /batch — Missing instruction

Provide an instruction describing the batch change you want to make.

Examples:
  /batch migrate from react 17 to react 18
  /batch replace all uses of lodash with native equivalents
  /batch add type annotations to all untyped function parameters

Reply with "Please provide an instruction describing the change." and stop.`;
    }
    return BATCH_BODY.replace('$ARGUMENTS', args);
  },
});


// ── /claude-api — quick-reference guide to the Anthropic API ──────────────

const CLAUDE_API_GUIDE = `# Anthropic Claude API — quick reference

Authoritative: https://docs.anthropic.com/claude/reference

## Endpoint

POST https://api.anthropic.com/v1/messages
Headers:
  x-api-key: sk-ant-...
  anthropic-version: 2023-06-01
  content-type: application/json

## Minimal request body

{
  "model": "claude-opus-4-7",
  "max_tokens": 4096,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}

## System prompt

{ "system": "You are helpful.", "messages": [...] }
Or an array for prompt caching:
{ "system": [
    { "type": "text", "text": "long stable prefix", "cache_control": { "type": "ephemeral" } },
    { "type": "text", "text": "per-turn dynamic bit" }
  ], "messages": [...] }

## Tool use (function calling)

Request:
  "tools": [{
    "name": "get_weather",
    "description": "Lookup current weather for a city.",
    "input_schema": { "type": "object", "properties": { ... }, "required": [...] }
  }]

Response contains \`content: [{ type: "tool_use", id, name, input }]\`.
Reply with:
  { "role": "user", "content": [{
    "type": "tool_result",
    "tool_use_id": "<same id>",
    "content": "result text OR array of content blocks"
  }] }

## Streaming

Add \`"stream": true\`. Response is SSE:
  event: message_start       → metadata about the response
  event: content_block_start → a new content block opens
  event: content_block_delta → incremental text/tool_use data
  event: content_block_stop  → block closes
  event: message_delta       → stop_reason, final usage
  event: message_stop        → end of message

## Rate-limit headers (read on 429)

anthropic-ratelimit-input-tokens-remaining
anthropic-ratelimit-output-tokens-remaining
anthropic-ratelimit-requests-remaining
retry-after

## Model ids (marketing → api)

Opus 4.7      → claude-opus-4-7
Sonnet 4.6    → claude-sonnet-4-6
Haiku 4.5     → claude-haiku-4-5-20251001

## User's question

$ARGUMENTS`;

registerBundledSkill({
  name: 'claude-api',
  description: 'Anthropic Claude API quick reference — endpoints, request/response shapes, tool use, streaming, rate limits.',
  whenToUse: 'When the user asks about the Claude HTTP API, tool use protocol, streaming events, or model IDs.',
  argumentHint: '[specific question]',
  args: [],
  body: CLAUDE_API_GUIDE,
  userInvocable: true,
});
