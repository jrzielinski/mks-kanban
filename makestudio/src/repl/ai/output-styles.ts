import { swallow } from '../../utils/log';
/**
 * output-styles.ts — dynamic loading of user-defined output styles.
 *
 * Port of Claude Code's src/services/outputStyles + constants/outputStyles.ts.
 * Lets users add styles without editing source: a markdown file with YAML
 * frontmatter in `~/.makestudio/output-styles/<name>.md` or the project-local
 * equivalent defines a new style. The markdown body is appended to the system
 * prompt when that style is active; the frontmatter controls metadata.
 *
 * Precedence (later wins on name collision):
 *   built-in < user (~/.makestudio/output-styles/) < project (<cwd>/.makestudio/output-styles/) < managed (~/.makestudio/.mdm/output-styles/)
 *
 * Example file — ~/.makestudio/output-styles/tutorial.md:
 *   ---
 *   name: tutorial
 *   description: Teaching mode — explains every decision, asks before destructive changes
 *   keepCodingInstructions: true
 *   ---
 *   When working, narrate your reasoning step-by-step. Before any Write/Edit,
 *   pause and confirm with the user what you're about to change and why.
 *   Prefer explanations over brevity. Use analogies when helpful.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface OutputStyleDef {
  name: string;
  description: string;
  /** If false, the built-in "coding instructions" section is stripped from
   *  the system prompt for this style (useful for "Chat only" style). */
  keepCodingInstructions?: boolean;
  /** Markdown body appended to the system prompt. */
  body: string;
  /** Debug: which file produced this definition. */
  source: 'builtin' | 'user' | 'project' | 'managed';
  path?: string;
}

const BUILTIN_STYLES: OutputStyleDef[] = [
  { name: 'default',   description: 'Balanced output',                                                   keepCodingInstructions: true, body: '', source: 'builtin' },
  { name: 'terse',     description: 'Minimal prose, answer-first',                                       keepCodingInstructions: true, body: 'Be terse. Answer first. Skip preamble and summaries.', source: 'builtin' },
  { name: 'verbose',   description: 'Explain reasoning, show alternatives',                              keepCodingInstructions: true, body: 'Explain your reasoning. When relevant, mention alternatives you considered and why the chosen approach wins.', source: 'builtin' },
  { name: 'explain',   description: 'Teaching mode — step-by-step walkthroughs',                         keepCodingInstructions: true, body: 'Work step by step. After each significant action, briefly explain WHY (not what) to the user.', source: 'builtin' },
  { name: 'code-only', description: 'Emit code blocks; minimal prose',                                   keepCodingInstructions: true, body: 'Respond primarily with code. Keep prose to one sentence before and one sentence after the code block.', source: 'builtin' },
];

function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, any> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.+)$/);
    if (!kv) continue;
    let value: any = kv[2].trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: m[2].trim() };
}

function loadFromDir(dir: string, source: OutputStyleDef['source']): OutputStyleDef[] {
  if (!fs.existsSync(dir)) return [];
  const out: OutputStyleDef[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    try {
      const content = fs.readFileSync(full, 'utf8');
      const { meta, body } = parseFrontmatter(content);
      const name = String(meta.name || file.replace(/\.md$/, '')).trim();
      if (!name) continue;
      out.push({
        name,
        description: String(meta.description || '(no description)').trim(),
        keepCodingInstructions: meta.keepCodingInstructions !== false,
        body,
        source,
        path: full,
      });
    } catch (err) { swallow(err); }
  }
  return out;
}

export function loadOutputStyles(cwd?: string): OutputStyleDef[] {
  const cwdRoot = cwd || process.cwd();
  const home = os.homedir();
  const byName = new Map<string, OutputStyleDef>();
  for (const s of BUILTIN_STYLES) byName.set(s.name, s);
  for (const s of loadFromDir(path.join(home, '.makestudio', 'output-styles'), 'user')) byName.set(s.name, s);
  for (const s of loadFromDir(path.join(cwdRoot, '.makestudio', 'output-styles'), 'project')) byName.set(s.name, s);
  for (const s of loadFromDir(path.join(home, '.makestudio', '.mdm', 'output-styles'), 'managed')) byName.set(s.name, s);
  return Array.from(byName.values());
}

export function findOutputStyle(name: string, cwd?: string): OutputStyleDef | null {
  return loadOutputStyles(cwd).find((s) => s.name === name) || null;
}

/**
 * Returns the markdown body to append to the system prompt for the given
 * style name. Empty string when style isn't found or has no body — caller
 * is responsible for a fallback.
 */
export function outputStylePromptAddition(name: string | undefined, cwd?: string): string {
  if (!name || name === 'default') return '';
  const s = findOutputStyle(name, cwd);
  if (!s) return '';
  if (!s.body.trim()) return '';
  return `\n\n## Output style: ${s.name}\n\n${s.body.trim()}`;
}

// ── Custom output-style CRUD (Phase 9 settings UI) ──────────────────────

/** Names that map to the BUILTIN_STYLES table — user-created files cannot
 *  shadow these on the same name. UI should validate before submitting. */
export function builtinStyleNames(): string[] {
  return BUILTIN_STYLES.map((s) => s.name);
}

function styleDirFor(scope: 'user' | 'project', cwd?: string): string {
  const home = os.homedir();
  if (scope === 'project') {
    return path.join(cwd || process.cwd(), '.makestudio', 'output-styles');
  }
  return path.join(home, '.makestudio', 'output-styles');
}

function safeFileName(name: string): string {
  // Names allowed: a-z 0-9 _ - (case-sensitive). Strict whitelist so users
  // can't accidentally write to '../../etc/passwd.md' through the name field.
  // The frontmatter `name:` is what determines runtime identity, so the
  // filename is purely cosmetic — but we still keep it readable.
  const clean = String(name).trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return clean || 'untitled';
}

export interface SaveOutputStyleArgs {
  name: string;
  description: string;
  keepCodingInstructions: boolean;
  body: string;
  scope: 'user' | 'project';
  cwd?: string;
}

/** Persist a custom output-style as `<scope-dir>/<name>.md` with YAML
 *  frontmatter mirroring the parser's expectations. Throws when the name
 *  collides with a builtin (refuse to shadow) or when the path is invalid.
 *  Returns the absolute file path written. */
export function saveOutputStyle(args: SaveOutputStyleArgs): string {
  const trimmedName = String(args.name || '').trim();
  if (!trimmedName) throw new Error('output-style: nome não pode ser vazio');
  if (builtinStyleNames().includes(trimmedName)) {
    throw new Error(`output-style: "${trimmedName}" é builtin — escolha outro nome`);
  }
  const dir = styleDirFor(args.scope, args.cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(trimmedName)}.md`);

  // YAML frontmatter — values are quoted to keep the parser happy when
  // descriptions contain `:` or other YAML-significant chars.
  const yamlEscape = (v: string): string => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const header = [
    '---',
    `name: ${yamlEscape(trimmedName)}`,
    `description: ${yamlEscape(args.description || '')}`,
    `keepCodingInstructions: ${args.keepCodingInstructions ? 'true' : 'false'}`,
    '---',
  ].join('\n');
  const content = `${header}\n\n${(args.body || '').trim()}\n`;
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/** Remove the markdown file backing a user/project output-style. Builtin
 *  and managed scopes are read-only (no caller path can write the MDM
 *  layer). Returns true when a file was deleted, false when none existed. */
export function deleteOutputStyle(
  name: string,
  scope: 'user' | 'project',
  cwd?: string,
): boolean {
  if (builtinStyleNames().includes(name)) {
    throw new Error('output-style builtin não pode ser deletado');
  }
  const dir = styleDirFor(scope, cwd);
  // Try the safeFileName first, then walk the dir as a fallback because the
  // file might have been hand-named differently while the frontmatter `name`
  // matches what we store in settings.
  const direct = path.join(dir, `${safeFileName(name)}.md`);
  if (fs.existsSync(direct)) {
    fs.unlinkSync(direct);
    return true;
  }
  if (!fs.existsSync(dir)) return false;
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return false; }
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    try {
      const content = fs.readFileSync(full, 'utf8');
      const { meta } = parseFrontmatter(content);
      if (String(meta.name || file.replace(/\.md$/, '')).trim() === name) {
        fs.unlinkSync(full);
        return true;
      }
    } catch (err) { swallow(err); }
  }
  return false;
}
