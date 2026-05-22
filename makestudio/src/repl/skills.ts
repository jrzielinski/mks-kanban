import { swallow } from '../utils/log';
/**
 * Skills system — markdown-based reusable prompts with YAML frontmatter.
 *
 * Skills are discovered from:
 *   ~/.makestudio/skills/*.md      (user global)
 *   .makestudio/skills/*.md        (project-local)
 *
 * Format:
 *   ---
 *   name: deploy-staging
 *   description: Deploy backend to staging
 *   args: [environment]
 *   ---
 *   Deploy the backend to {{environment}}. Run tests first, then:
 *   1. git push origin staging
 *   2. wait for CI
 *   3. verify health endpoint
 *
 * Skills become slash commands (/deploy-staging) and are sent as prompts to the AI.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { registerBundledSkill, getBundledSkillsMap, __clearBundledSkillsForTests } from './skills-registry';
// Side-effect import: registers all bundled skills via skills-registry.
// Replaces the previous lazy `require('./skills-bundled')` inside
// loadAllSkills which created the skills → skills-bundled → skills cycle.
// skills-bundled now imports from skills-registry only.
import './skills-bundled';

export { registerBundledSkill, __clearBundledSkillsForTests };

/**
 * Skill — a prompt-expanding slash command (port of Claude Code's
 * registerBundledSkill). Distinct from custom agents: agents are specialised
 * `dispatch_agent subagent_type` targets; skills are one-shot prompt templates
 * invoked via `/<name>` or the `Skill` tool. A skill's `body` is expanded with
 * any `{{arg}}` placeholders or `$ARGUMENTS` and becomes the model's next
 * instruction set.
 */
export interface Skill {
  name: string;
  description: string;
  args: string[];
  body: string;
  source: 'bundled' | 'user' | 'project';
  path?: string;

  /** One-liner describing WHEN this skill should be used — goes into the
   *  model-facing description so the LLM can self-invoke intelligently.
   *  Port of Claude Code's `whenToUse`. */
  whenToUse?: string;
  /** Short hint shown next to the name in the slash-command menu
   *  (e.g. `[interval] <prompt>`). Port of `argumentHint`. */
  argumentHint?: string;
  /** If set, only these tool names may be called during the turn that
   *  expanded this skill. Soft guard — enforced at dispatch time. */
  allowedTools?: string[];
  /** When true, the model cannot auto-invoke this skill — it must be
   *  explicitly user-typed as `/<name>`. Used for high-surface skills like
   *  `/debug` that shouldn't fire from a model hallucination. */
  disableModelInvocation?: boolean;
  /** Gate that evaluates at runtime — e.g. `isEnabled: () => isGitRepo()`.
   *  Returning false hides the skill from the menu and rejects invocation. */
  isEnabled?: () => boolean;
  /** True if the user can invoke via `/<name>`. Default true. */
  userInvocable?: boolean;
  /** For bundled skills: a function that returns the fully-expanded prompt
   *  body given the args string (already joined). Takes precedence over
   *  `body` + `applySkillArgs`. Lets bundled skills run arbitrary logic
   *  (e.g. `/debug` tails the debug log before injecting the prompt). */
  getPromptForCommand?: (args: string, cwd: string) => Promise<string> | string;
}

function parseFrontmatter(content: string): { meta: any; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };

  const meta: any = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value: any = kv[2].trim();
    // YAML pipe scalar — `key: |` followed by indented lines. Concatenate
    // the indented block (preserving inner newlines) until we hit a line
    // that's not indented relative to the key. Without this superpowers
    // skills with multi-line descriptions parse as just "|".
    if (value === '|' || value === '>') {
      const fold = value === '>';
      const collected: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const ln = lines[j];
        if (!/^\s+/.test(ln) && ln.trim() !== '') break;
        collected.push(ln.replace(/^\s{2}/, ''));
        j++;
      }
      value = collected.join(fold ? ' ' : '\n').trim();
      i = j - 1;
      meta[key] = value;
      continue;
    }
    // Arrays: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    // Strip quotes
    if (typeof value === 'string' && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    // Coerce bare YAML booleans. Skill frontmatter uses `disableModelInvocation: true`
    // directly — without this coercion the consumer sees the string 'true'
    // and `=== true` fails.
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    meta[key] = value;
  }
  return { meta, body: m[2].trim() };
}

/**
 * Locate the agent's install directory so we can resolve the bundled
 * `skills/` folder shipped inside the npm package. The bundled entrypoint
 * (`dist/index.js`) lives one directory below the package root, so the
 * skills sit at `<install>/skills/`. We probe a couple of layouts to be
 * resilient to dev mode (running from `build/`) vs published install
 * (running from `dist/`).
 */
function findAgentSkillsDir(): string | null {
  const candidates: string[] = [];
  try {
    const here = __dirname;
    candidates.push(path.join(here, '..', 'skills'));     // dist/ → ../skills
    candidates.push(path.join(here, '..', '..', 'skills')); // build/repl/ → ../../skills
    candidates.push(path.join(here, 'skills'));           // (just in case)
  } catch (err) { swallow(err); }
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c; } catch (err) { swallow(err); }
  }
  return null;
}

function loadAgentBundledSkills(): Skill[] {
  const dir = findAgentSkillsDir();
  if (!dir) return [];
  // Reuse loadSkillsFromDir's parsing path but tag the result as 'bundled'.
  const raw = loadSkillsFromDir(dir, 'user' as any);
  return raw.map((s) => ({ ...s, source: 'bundled' as const }));
}

function loadSkillsFromDir(dir: string, source: 'user' | 'project'): Skill[] {
  if (!fs.existsSync(dir)) return [];
  const skills: Skill[] = [];
  try {
    // Sort so the prompt-cache-stable list of skills survives unrelated
    // fs activity (renames/creates change readdir order on some FSes,
    // which would invalidate the cached prefix that lists the skills).
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.md')) continue;
      const full = path.join(dir, file);
      try {
        const content = fs.readFileSync(full, 'utf8');
        const { meta, body } = parseFrontmatter(content);
        const name = meta.name || file.replace(/\.md$/, '');
        skills.push({
          name,
          description: meta.description || '(no description)',
          args: Array.isArray(meta.args) ? meta.args : [],
          body,
          source,
          path: full,
          // Expanded schema — graceful fallback for older skill files.
          whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
          argumentHint: typeof meta.argumentHint === 'string' ? meta.argumentHint
            : (typeof meta.argument_hint === 'string' ? meta.argument_hint : undefined),
          allowedTools: Array.isArray(meta.allowedTools) ? meta.allowedTools
            : (Array.isArray(meta.allowed_tools) ? meta.allowed_tools : undefined),
          disableModelInvocation: meta.disableModelInvocation === true
            || meta.disable_model_invocation === true,
          userInvocable: meta.userInvocable !== false && meta.user_invocable !== false,
        });
      } catch (err) { swallow(err); }
    }
  } catch (err) { swallow(err); }
  return skills;
}

/**
 * In-process registry of bundled skills lives in skills-registry.ts now;
 * the register/clear functions are re-exported above. The Skill[]
 * snapshot helper stays here because callers expect it under skills.ts.
 */
export function getBundledSkills(): Skill[] {
  return Array.from(getBundledSkillsMap().values());
}

export function loadAllSkills(cwd: string): Skill[] {
  // Bundled-skill registration happens at module load via the top-level
  // `import './skills-bundled'` near the top of this file, which routes
  // through skills-registry. No lazy require here.

  const userDir = path.join(os.homedir(), '.makestudio', 'skills');
  const projectDir = path.join(cwd, '.makestudio', 'skills');
  const userSkills = loadSkillsFromDir(userDir, 'user');
  const projectSkills = loadSkillsFromDir(projectDir, 'project');
  // Bundled-with-agent skills live as .md files in <agent-install>/skills/.
  // These ship with the npm package (see package.json `files`) so a fresh
  // install on a new machine has the curated set without depending on the
  // user dir, which the user may not have populated yet.
  const agentSkills = loadAgentBundledSkills();
  const byName = new Map<string, Skill>();
  // Precedence: TS-bundled < md-bundled (agent) < user < project.
  for (const s of getBundledSkillsMap().values()) byName.set(s.name, s);
  for (const s of agentSkills) byName.set(s.name, s);
  for (const s of userSkills) byName.set(s.name, s);
  for (const s of projectSkills) byName.set(s.name, s);
  // Filter out skills that are disabled at runtime.
  return Array.from(byName.values()).filter((s) => !s.isEnabled || s.isEnabled());
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  return skills.find(s => s.name === name);
}

export function applySkillArgs(skill: Skill, args: string[]): string {
  let body = skill.body;
  // Track whether the body actually consumed the args anywhere — so we
  // know whether to append them as a fallback "User request" block. Without
  // this, a skill that doesn't declare {{vars}} or $ARGUMENTS swallows the
  // user's input silently and the model has no idea what was asked.
  let consumedArgs = false;
  for (let i = 0; i < skill.args.length; i++) {
    const value = args[i] || '';
    const re = new RegExp(`\\{\\{\\s*${skill.args[i]}\\s*\\}\\}`, 'g');
    if (re.test(body)) consumedArgs = true;
    body = body.replace(re, value);
  }
  if (/\$ARGUMENTS/.test(body)) consumedArgs = true;
  body = body.replace(/\$ARGUMENTS/g, args.join(' '));

  const argsStr = args.join(' ').trim();
  if (argsStr && !consumedArgs) {
    // Append the user's input so the model sees it. Plain markdown so
    // it's clear in the prompt where instructions end and the request begins.
    body = body + `\n\n## User request\n\n${argsStr}\n`;
  }
  return body;
}

/**
 * Expand a skill's body, honouring `getPromptForCommand` when present.
 * Returns the final prompt text that should be fed to the model as if the
 * user had typed it.
 */
export async function expandSkill(skill: Skill, argsString: string, cwd: string): Promise<string> {
  if (skill.getPromptForCommand) {
    return await skill.getPromptForCommand(argsString, cwd);
  }
  const args = argsString.trim().split(/\s+/).filter(Boolean);
  return applySkillArgs(skill, args);
}

/** Friendly list of user-invocable skills with their descriptions — used by
 *  the system prompt injection + the `/help` / completions menu. */
export function describeUserInvocableSkills(cwd: string): string {
  const skills = loadAllSkills(cwd).filter((s) => s.userInvocable !== false);
  if (skills.length === 0) return '';
  const lines = skills.map((s) => {
    const hint = s.argumentHint ? ` ${s.argumentHint}` : '';
    return `  /${s.name}${hint} — ${s.description}`;
  });
  return `\n\n## User-invocable skills\n\n${lines.join('\n')}\n\nUsers type \`/<skill-name>\` to trigger these. When a user invokes a skill, the Skill tool expands the body and you should follow it as fresh instructions.`;
}

// ── Phase 12: Skills CRUD ─────────────────────────────────────────────

function safeSkillFileName(name: string): string {
  // Same character class allowed by `name:` parsing (alnum + dash/underscore).
  // Strip dirs/dots so the filename can never escape the scope dir.
  const clean = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return clean || 'untitled';
}

export interface SaveSkillArgs {
  scope: 'user' | 'project';
  name: string;
  description: string;
  body: string;
  args?: string[];
  whenToUse?: string;
  argumentHint?: string;
  allowedTools?: string[];
  cwd?: string;
}

function skillsDirFor(scope: 'user' | 'project', cwd?: string): string {
  if (scope === 'project') {
    return path.join(cwd || process.cwd(), '.makestudio', 'skills');
  }
  return path.join(os.homedir(), '.makestudio', 'skills');
}

/**
 * Persist a skill as `<scope-dir>/<name>.md` with YAML frontmatter. Refuses
 * to overwrite a bundled skill (those ship inside the package). Returns the
 * absolute path of the file written.
 */
export function saveSkill(args: SaveSkillArgs): string {
  const trimmed = args.name.trim();
  if (!trimmed) throw new Error('skill: nome não pode ser vazio');
  // Bundled skills (loaded from inside the install) cannot be shadowed.
  for (const b of getBundledSkills()) {
    if (b.name === trimmed) {
      throw new Error(`skill: "${trimmed}" é bundled — escolha outro nome`);
    }
  }
  const dir = skillsDirFor(args.scope, args.cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeSkillFileName(trimmed)}.md`);
  // YAML quoting: only quote when value contains chars YAML treats specially.
  const yamlString = (v: string): string => {
    if (!/[":#&*!|>%@`{}[\]\n]/.test(v) && !v.startsWith(' ') && !v.endsWith(' ')) return v;
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };
  const yamlList = (xs: string[]): string => `[${xs.map(yamlString).join(', ')}]`;
  const headerLines = [
    '---',
    `name: ${yamlString(trimmed)}`,
    `description: ${yamlString(args.description ?? '')}`,
  ];
  if (args.args && args.args.length > 0) headerLines.push(`args: ${yamlList(args.args)}`);
  if (args.whenToUse) headerLines.push(`whenToUse: ${yamlString(args.whenToUse)}`);
  if (args.argumentHint) headerLines.push(`argumentHint: ${yamlString(args.argumentHint)}`);
  if (args.allowedTools && args.allowedTools.length > 0) {
    headerLines.push(`allowedTools: ${yamlList(args.allowedTools)}`);
  }
  headerLines.push('---');
  const content = `${headerLines.join('\n')}\n\n${(args.body ?? '').trim()}\n`;
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * Remove a user/project skill by name. Refuses bundled. Returns true when a
 * file was removed, false when nothing matched.
 */
export function deleteSkill(scope: 'user' | 'project', name: string, cwd?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  for (const b of getBundledSkills()) {
    if (b.name === trimmed) {
      throw new Error('skill bundled não pode ser deletada');
    }
  }
  const dir = skillsDirFor(scope, cwd);
  if (!fs.existsSync(dir)) return false;
  // Try the safe-name first, fall back to scanning the dir for a matching frontmatter `name`.
  const direct = path.join(dir, `${safeSkillFileName(trimmed)}.md`);
  if (fs.existsSync(direct)) {
    fs.unlinkSync(direct);
    return true;
  }
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return false; }
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const { meta } = parseFrontmatter(raw);
      if (String(meta?.name || file.replace(/\.md$/, '')).trim() === trimmed) {
        fs.unlinkSync(full);
        return true;
      }
    } catch (err) { swallow(err); }
  }
  return false;
}

/**
 * Re-resolve a skill (bundled / user / project) and return the full body so
 * the editor can hydrate. Returns null when no matching skill exists.
 */
export function getSkillBody(name: string, cwd: string): Skill | null {
  return findSkill(loadAllSkills(cwd), name) ?? null;
}

export function ensureExampleSkills(): void {
  const userDir = path.join(os.homedir(), '.makestudio', 'skills');
  if (fs.existsSync(userDir)) return;
  try {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'project-health.md'),
      `---
name: project-health
description: Resumo rapido de saude do projeto ativo
args: []
---
Analise o projeto ativo e responda em formato tabela:
- Quantos DUMs pendentes, em progresso, concluidos
- Quantas tasks pendentes
- Ultima atividade (commit mais recente)
- Problemas detectados (tasks bloqueadas, erros de validacao)

Use as tools disponiveis para buscar esses dados.
`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(userDir, 'explain-dum.md'),
      `---
name: explain-dum
description: Explica um DUM em linguagem simples
args: [dumNumber]
---
Explique o DUM {{dumNumber}} do projeto ativo em linguagem simples:
- O que esse DUM faz (nao codigo, conceito)
- Por que ele importa no projeto
- Quais outros DUMs dependem dele
- Quanto trabalho ainda falta (tasks pendentes)
`,
      'utf8',
    );
  } catch (err) { swallow(err); }
}
