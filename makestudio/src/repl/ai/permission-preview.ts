import { swallow } from '../../utils/log';
/**
 * permission-preview.ts — formatting helpers for the PermissionPrompt UI
 * and rule persistence when the user chooses "allow + save rule" (Fase 3.1).
 *
 * `buildPermissionPreview` returns a compact summary + optional diff the
 * UI renders inside the prompt card. `persistAllowRule` writes a string
 * in `Tool(matcher)` syntax to the project's permissions.json allow list.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface PermissionPreview {
  summary: string;
  diff?: string;
  /** Non-blocking advisory — shown prominently so the user notices risk BEFORE approving.
   *  Port of Claude Code's getDestructiveCommandWarning (BashTool/destructiveCommandWarning.ts). */
  warning?: string;
}

/**
 * Detect informational risk hints for Bash commands. Non-blocking — these
 * are advisory strings shown in the permission prompt so the user sees
 * "may discard uncommitted changes" next to a `git reset --hard`. This is
 * ADDITIVE to safety-classifier (which hard-blocks) — the classifier stops
 * truly catastrophic commands; this layer nudges on merely risky ones.
 */
const DESTRUCTIVE_PATTERNS: Array<{ rx: RegExp; warning: string }> = [
  { rx: /\bgit\s+reset\s+--hard\b/,                                                    warning: 'may discard uncommitted changes' },
  { rx: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,               warning: 'may overwrite remote history' },
  { rx: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,   warning: 'may permanently delete untracked files' },
  { rx: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,                              warning: 'may discard all working-tree changes' },
  { rx: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,                               warning: 'may discard all working-tree changes' },
  { rx: /\bgit\s+stash[ \t]+(drop|clear)\b/,                                           warning: 'may permanently remove stashed changes' },
  { rx: /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,          warning: 'may force-delete a branch' },
  { rx: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,                         warning: 'may skip safety hooks' },
  { rx: /\bgit\s+commit\b[^;&|\n]*--amend\b/,                                          warning: 'may rewrite the last commit' },
  { rx: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, warning: 'may recursively force-remove files' },
  { rx: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,                                           warning: 'may recursively remove files' },
  { rx: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/,                                              warning: 'may force-remove files' },
  { rx: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,                              warning: 'may drop/truncate database objects' },
  { rx: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,                                    warning: 'may delete all rows from a table' },
  { rx: /\bkubectl\s+delete\b/,                                                        warning: 'may delete Kubernetes resources' },
  { rx: /\bterraform\s+destroy\b/,                                                     warning: 'may destroy Terraform infrastructure' },
  { rx: /\bdocker\s+rm\s+-[a-zA-Z]*f/,                                                 warning: 'may force-remove containers (data loss)' },
  { rx: /\bdocker\s+volume\s+rm\b/,                                                    warning: 'may destroy a Docker volume (data loss)' },
  { rx: /\bnpm\s+publish\b/,                                                           warning: 'publishes to the npm registry — public and irreversible' },
];

export function getDestructiveCommandWarning(command: string): string | null {
  const cmd = String(command || '');
  for (const { rx, warning } of DESTRUCTIVE_PATTERNS) {
    if (rx.test(cmd)) return warning;
  }
  return null;
}

const HEAVY_COMMAND_PATTERNS: Array<{ rx: RegExp; warning: string }> = [
  { rx: /npm\s+run\s+check[:\-]types?\b/,             warning: 'heavy — runs full TypeScript type check, may take minutes' },
  { rx: /\bnpx\s+tsc\b/,                              warning: 'heavy — full TypeScript compilation, may hang on large codebases' },
  { rx: /npm\s+run\s+build\b/,                        warning: 'heavy — full project build, may take a while' },
  { rx: /\bnest\s+build\b/,                           warning: 'heavy — NestJS full build' },
  { rx: /npm\s+run\s+(test|e2e)\b/,                   warning: 'may take a long time depending on test suite size' },
];

function getHeavyCommandWarning(cmd: string): string | null {
  for (const { rx, warning } of HEAVY_COMMAND_PATTERNS) {
    if (rx.test(cmd)) return warning;
  }
  return null;
}

// ── Diff simulation helpers ────────────────────────────────────────
//
// Render a real unified diff in the permission prompt instead of just
// listing the old/new blocks. Lets the user spot off-by-one mistakes,
// indentation drift, or unintended replacement before approving.
//
// All helpers are best-effort. They never throw — on any failure
// (file not readable, applyEdit mismatch, diff renderer missing) they
// return null and let the caller fall back to a simpler view.

const PREVIEW_DIFF_MAX_LINES = 60;
const PREVIEW_DIFF_CONTEXT = 2;

function loadDiffRenderer(): null | ((before: string, after: string, opts: any) => string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../diff-render').renderDiff;
  } catch { return null; }
}

/**
 * Wrap the diff with a syntax-highlight pass so keywords/strings/
 * numbers inside the +/- lines are coloured. Best-effort: if the
 * highlighter or language detection fails, the diff is returned as-is.
 */
function highlightDiff(diff: string, filePath: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { lightHighlight, detectLang } = require('../tui/light-highlight');
    const ext = (filePath.match(/\.(\w+)$/)?.[1] || '').toLowerCase();
    const langByExt: Record<string, any> = {
      ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
      py: 'py', sh: 'bash', bash: 'bash', zsh: 'bash',
      json: 'json', css: 'css', scss: 'css',
    };
    const lang = langByExt[ext] || detectLang(diff);
    return lightHighlight(diff, { lang });
  } catch { return diff; }
}

function loadApplyEdit(): null | ((content: string, oldStr: string, newStr: string, replaceAll: boolean, label: string) => string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./file-tools/edit').applyEdit;
  } catch { return null; }
}

function safeReadFile(filePath: string): string | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch { return null; }
}

function simulateEditDiff(filePath: string, oldStr: any, newStr: any, replaceAll: boolean): string | null {
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
  const before = safeReadFile(filePath);
  if (before == null) return null;
  const applyEdit = loadApplyEdit();
  const renderDiff = loadDiffRenderer();
  if (!applyEdit || !renderDiff) return null;
  let after: string;
  try { after = applyEdit(before, oldStr, newStr, replaceAll, 'Edit'); }
  catch (err: any) {
    // Surface the apply error directly — the user gets a clear "this
    // edit won't apply" preview line instead of an opaque approval.
    return `[edit will fail: ${String(err?.message || err).slice(0, 200)}]`;
  }
  try {
    const rendered = renderDiff(before, after, { filePath, context: PREVIEW_DIFF_CONTEXT, maxLines: PREVIEW_DIFF_MAX_LINES });
    return highlightDiff(rendered, filePath);
  } catch { return null; }
}

function simulateMultiEditDiff(filePath: string, edits: any[]): string | null {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const before = safeReadFile(filePath);
  if (before == null) return null;
  const applyEdit = loadApplyEdit();
  const renderDiff = loadDiffRenderer();
  if (!applyEdit || !renderDiff) return null;
  let buf = before;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') {
      return `[edit ${i + 1}/${edits.length} has invalid old_string/new_string]`;
    }
    try {
      buf = applyEdit(buf, e.old_string, e.new_string, !!e.replace_all, `MultiEdit[${i + 1}/${edits.length}]`);
    } catch (err: any) {
      return `[edit ${i + 1}/${edits.length} will fail: ${String(err?.message || err).slice(0, 180)}]`;
    }
  }
  try {
    const rendered = renderDiff(before, buf, { filePath, context: PREVIEW_DIFF_CONTEXT, maxLines: PREVIEW_DIFF_MAX_LINES });
    return highlightDiff(rendered, filePath);
  } catch { return null; }
}

function simulateWriteDiff(filePath: string, content: string): string | null {
  const before = safeReadFile(filePath) ?? '';
  const renderDiff = loadDiffRenderer();
  if (!renderDiff) return null;
  try {
    const rendered = renderDiff(before, content, { filePath, context: PREVIEW_DIFF_CONTEXT, maxLines: PREVIEW_DIFF_MAX_LINES });
    return highlightDiff(rendered, filePath);
  } catch { return null; }
}

function rawBlockDiff(oldStr: any, newStr: any): string {
  const oldS = String(oldStr || '').split('\n').slice(0, 4);
  const newS = String(newStr || '').split('\n').slice(0, 4);
  return [
    ...oldS.map((l) => '- ' + l),
    ...newS.map((l) => '+ ' + l),
  ].join('\n');
}

export function buildPermissionPreview(toolName: string, toolInput: any): PermissionPreview {
  // Bash — show the command, highlight the verb
  if (toolName === 'Bash' || toolName === 'shell_run') {
    const cmd = String(toolInput?.command || '').trim();
    const firstLine = cmd.split('\n')[0];
    const desc = toolInput?.description ? ` — ${toolInput.description}` : '';
    const warning = getDestructiveCommandWarning(cmd) || getHeavyCommandWarning(cmd) || undefined;
    return {
      summary: `$ ${firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine}${desc}`,
      warning,
    };
  }

  // Edit — show the file + a true unified diff of the proposed change.
  // We try to produce a real before→after diff by simulating the edit
  // against the on-disk content (via applyEdit). If the file isn't
  // readable or the simulation fails, we fall back to the raw old/new
  // block view so the user still sees SOMETHING.
  if (toolName === 'Edit') {
    const fp = toolInput?.file_path || '(no path)';
    const diff = simulateEditDiff(fp, toolInput?.old_string, toolInput?.new_string, !!toolInput?.replace_all)
      || rawBlockDiff(toolInput?.old_string, toolInput?.new_string);
    return { summary: fp, diff };
  }

  // MultiEdit — apply ALL the edits in sequence to a buffer copy of
  // the file, then unified-diff the result. If any single edit fails
  // (old_string mismatch), we surface that here BEFORE the user
  // approves, so they can ask the model to fix the edit set instead
  // of approving + rolling back.
  if (toolName === 'MultiEdit') {
    const fp = toolInput?.file_path || '(no path)';
    const edits = Array.isArray(toolInput?.edits) ? toolInput.edits : [];
    const n = edits.length;
    const diff = simulateMultiEditDiff(fp, edits) || `${n} edit${n === 1 ? '' : 's'} planned (preview unavailable)`;
    return { summary: `${fp}  (${n} edit${n === 1 ? '' : 's'})`, diff };
  }

  // Write — path + byte count + diff vs current file (when it exists).
  if (toolName === 'Write') {
    const fp = toolInput?.file_path || '(no path)';
    const body = String(toolInput?.content ?? '');
    const lines = body.split('\n').length;
    const diff = simulateWriteDiff(fp, body)
      || body.split('\n').slice(0, 6).map((l) => '+ ' + l).join('\n');
    return { summary: `${fp}  (${body.length} chars, ${lines} line${lines === 1 ? '' : 's'})`, diff };
  }

  // WebFetch — URL + domain
  if (toolName === 'WebFetch' || toolName === 'web_fetch') {
    const url = String(toolInput?.url || '');
    try {
      const u = new URL(url);
      return { summary: `${url}  (domain: ${u.hostname})` };
    } catch { return { summary: url }; }
  }

  // NotebookEdit — notebook + operation + cell
  if (toolName === 'NotebookEdit') {
    const fp = toolInput?.notebook_path || '(no path)';
    const op = toolInput?.operation || '?';
    const idx = toolInput?.cell_index;
    return { summary: `${fp}  [${op} cell ${idx}]` };
  }

  // Read — path
  if (toolName === 'Read' || toolName === 'read_file') {
    const fp = String(toolInput?.file_path || toolInput?.path || '');
    const offset = toolInput?.offset ? `:${toolInput.offset}` : '';
    const limit = toolInput?.limit ? `+${toolInput.limit}` : '';
    return { summary: fp + offset + limit };
  }

  // Glob — pattern + optional base dir
  if (toolName === 'Glob') {
    const pattern = String(toolInput?.pattern || '*');
    const dir = toolInput?.path ? ` in ${toolInput.path}` : '';
    return { summary: pattern + dir };
  }

  // Grep — pattern + scope
  if (toolName === 'Grep') {
    const pattern = String(toolInput?.pattern || '');
    const dir = toolInput?.path ? ` in ${toolInput.path}` : '';
    return { summary: `/${pattern}/${dir}` };
  }

  // Fallback — show key=value pairs (no raw JSON blocks)
  const entries = Object.entries(toolInput ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${s.length > 80 ? s.slice(0, 77) + '…' : s}`;
    });
  return { summary: entries.slice(0, 4).join('  ·  ') || '(no args)' };
}

/**
 * Persist an `allow` rule for this tool call so future sessions don't
 * ask again. Scope heuristic:
 *   - Bash:   `Bash(<first word>*)`            e.g. `Bash(git *)`
 *   - Edit/Write/MultiEdit/NotebookEdit/Read: `Tool(<path-dir>/**)`
 *   - WebFetch: `WebFetch(domain:<hostname>)`
 *   - other:  `Tool(*)`  (coarse — accept any input)
 *
 * Written to `<project>/.makestudio/permissions.json` (project-scoped is
 * sane default — a rule for `rm *` in project A shouldn't leak to B).
 */
export function persistAllowRule(toolName: string, toolInput: any, ctx: any): void {
  const rule = buildAllowRuleString(toolName, toolInput);
  const projectRoot = ctx?.activeProject?.localPath || ctx?.cwd || process.cwd();
  const file = path.join(projectRoot, '.makestudio', 'permissions.json');
  let existing: any = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { swallow(err); }
  }
  if (!Array.isArray(existing.allow)) existing.allow = [];
  if (!existing.allow.includes(rule)) existing.allow.push(rule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

/**
 * Narrow allow rules — one-click "save rule" must NOT grant more than what
 * the user saw. Stress test #10 found the previous pattern `Bash(rm *)`
 * effectively whitelisted all destructive `rm` calls across sessions.
 *
 * Rules of thumb:
 *   - Bash: include as many literal argv tokens as we can be confident about
 *     (two-word commands like `git status`, `npm test` get exact match;
 *     single destructive verbs like `rm`/`mv`/`curl` stay literal + keep
 *     the original argument shape).
 *   - File tools: anchor to the EXACT file path the user authorized.
 *   - WebFetch: exact host (host-only, no subdomain expansion).
 */
function buildAllowRuleString(toolName: string, toolInput: any): string {
  if (toolName === 'Bash' || toolName === 'shell_run') {
    const cmd = String(toolInput?.command || '').trim();
    if (!cmd) return `${toolName}(*)`;
    const parts = cmd.split(/\s+/);
    // Filesystem/network mutating verbs: pin to the EXACT command. Approving
    // `rm -rf /tmp/foo` once must NOT auto-approve `rm -rf /home`.
    // `git push` and `npm run` look here too because they're high-impact —
    // `git: 2`/`npm run: 3` arity rules would auto-approve them (correct
    // semantically), but the user explicitly asked for confirmation per
    // destructive action.
    const DESTRUCTIVE = new Set(['rm', 'mv', 'cp', 'dd', 'shred', 'curl', 'wget']);
    if (DESTRUCTIVE.has(parts[0])) {
      return `${toolName}(${cmd})`;
    }
    // Everything else uses the arity-based canonical prefix from
    // permission-arity.ts. `git push origin main` → `git push *`,
    // `npm run dev` → `npm run dev *`, `docker compose up -d` →
    // `docker compose up *`. Captures the human-understandable command
    // shape so re-running with different args/flags is auto-approved.
    try {
      const { canonicalPrefix } = require('../permission-arity');
      const canonical = canonicalPrefix(cmd);
      if (canonical) return `${toolName}(${canonical} *)`;
    } catch (err) { swallow(err); }
    // Legacy fallback when arity table doesn't recognise the command.
    if (parts.length >= 2) return `${toolName}(${parts[0]} ${parts[1]} *)`;
    return `${toolName}(${parts[0]} *)`;
  }
  if (toolName === 'WebFetch' || toolName === 'web_fetch') {
    try {
      const host = new URL(String(toolInput?.url || '')).hostname.replace(/\.$/, '');
      return `${toolName}(domain:${host})`;
    } catch { return `${toolName}(*)`; }
  }
  // Glob/Grep use `pattern` as the path discriminator.
  const PATTERN_TOOLS = new Set(['Glob', 'Grep']);
  const p = PATTERN_TOOLS.has(toolName)
    ? (toolInput?.pattern || toolInput?.file_path || toolInput?.filePath)
    : (toolInput?.file_path || toolInput?.notebook_path || toolInput?.filePath);
  if (typeof p === 'string' && p.length > 0) {
    // Anchor to the exact path/pattern the user approved. Broadening to a
    // glob requires an explicit edit to permissions.json.
    const home = os.homedir();
    const rel = p.startsWith(home) ? p.replace(home, '~') : p;
    return `${toolName}(${rel})`;
  }
  return `${toolName}(*)`;
}
