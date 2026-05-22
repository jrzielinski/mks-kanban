import { swallow } from '../../utils/log';
/**
 * custom-agents.ts — load user-defined subagents from disk (Fase 4.1).
 *
 * Port of Claude Code's src/tools/AgentTool/loadAgentsDir.ts (simplified).
 * Agents live in:
 *   ~/.claude/agents/*.md          (user, shared with Claude Code)
 *   <cwd>/.claude/agents/*.md      (project, also shared)
 *   ~/.makestudio/agents/*.md      (user, MakeStudio-only)
 *   <cwd>/.makestudio/agents/*.md  (project, MakeStudio-only)
 *
 * Format (YAML frontmatter + markdown body as the agent's system prompt):
 *   ---
 *   name: api-reviewer
 *   description: Reviews REST API design against project conventions
 *   tools: [Read, Glob, Grep, LSP, web_fetch]
 *   model: fast            # optional — "fast" routes to role=fast config
 *   ---
 *   You are an API reviewer. When invoked, read the endpoint in question,
 *   compare it to patterns in src/**\/*.controller.ts, and ...
 *
 * The body becomes the agent's system prompt. `tools` whitelist is applied
 * at dispatch time (see tools.ts:dispatch_agent handling). `model: fast`
 * is honored when the fast provider is configured.
 *
 * Precedence when the same name appears in multiple dirs:
 *   project-makestudio > project-claude > user-makestudio > user-claude
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Nomes de built-in subagents (prompts vivem em subagent-config.ts).
 *  Single source of truth — usado por inheritance + saveCustomAgent guard
 *  + UI list. Adicionar built-in: estender ESTE Set. */
const BUILT_IN_AGENT_NAMES = new Set([
  'general-purpose', 'explore', 'plan', 'code-reviewer', 'verification',
]);

export interface CustomAgent {
  name: string;
  description: string;
  prompt: string;
  /** Explicit allow-list. If set, ONLY these tool names are available. */
  tools?: string[];
  /** Explicit deny-list applied AFTER allow-list. Lets an agent inherit
   *  the full read-only set but forbid specific tools (e.g. omit NotebookEdit).
   *  Port of Claude Code's disallowedToolNames in built-in agent defs. */
  disallowedTools?: string[];
  model?: 'primary' | 'fast' | string;
  /** Override MAX_ITERS for this agent type. Default: 10 general, 25 verify.
   *  Useful for tight read-only agents (set 3-5) that shouldn't loop. */
  maxTurns?: number;
  /** List of MCP server names this agent requires. If any is not configured
   *  in the current REPL session, dispatch fails fast with an actionable
   *  error instead of silently missing functionality mid-turn. */
  requiredMcpServers?: string[];
  /** Inherit prompt + tools from another agent (bundled type name OR custom
   *  agent name). The base's prompt is PREPENDED to this agent's prompt,
   *  and `tools` / `disallowedTools` union/intersection sensibly. */
  baseAgent?: string;
  /** Short strings re-injected into the agent's system prompt on EVERY turn.
   *  Use for hard invariants you want reinforced (e.g. "Always ask before
   *  deleting files"). Port of Claude Code's critical system reminders. */
  criticalReminders?: string[];
  /** Persist state across invocations. `project` → <cwd>/.makestudio/agent-memory/<name>.json;
   *  `user` → ~/.makestudio/agent-memory/<name>.json. The agent can read/write
   *  the file via Read/Write on that exact path (tools permission applies). */
  memory?: 'project' | 'user' | 'none';
  source: 'user-claude' | 'user-makestudio' | 'project-claude' | 'project-makestudio';
  path: string;
}

function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, any> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    let value: any = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: m[2].trim() };
}

function loadFromDir(dir: string, source: CustomAgent['source']): CustomAgent[] {
  if (!fs.existsSync(dir)) return [];
  const out: CustomAgent[] = [];
  let entries: string[] = [];
  // Sort so the agent list in the system prompt is byte-stable across
  // turns even after unrelated fs ops re-shuffle readdir order.
  try { entries = fs.readdirSync(dir).sort(); } catch { return []; }
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    try {
      const content = fs.readFileSync(full, 'utf8');
      const { meta, body } = parseFrontmatter(content);
      const name = String(meta.name || file.replace(/\.md$/, '')).trim();
      if (!name) continue;
      if (!body.trim()) continue; // body IS the agent's system prompt — skip empty
      const maxTurnsRaw = meta.maxTurns ?? meta.max_turns;
      const maxTurns = typeof maxTurnsRaw === 'number'
        ? maxTurnsRaw
        : (typeof maxTurnsRaw === 'string' && /^\d+$/.test(maxTurnsRaw.trim()))
          ? parseInt(maxTurnsRaw.trim(), 10)
          : undefined;
      const requiredMcp = Array.isArray(meta.requiredMcpServers)
        ? meta.requiredMcpServers.map(String)
        : (Array.isArray(meta.required_mcp_servers) ? meta.required_mcp_servers.map(String) : undefined);
      const criticalReminders = Array.isArray(meta.criticalReminders)
        ? meta.criticalReminders.map(String)
        : (Array.isArray(meta.critical_reminders) ? meta.critical_reminders.map(String) : undefined);
      const memoryRaw = String(meta.memory || '').toLowerCase().trim();
      const memory: 'project' | 'user' | 'none' | undefined =
        memoryRaw === 'project' || memoryRaw === 'user' || memoryRaw === 'none' ? memoryRaw : undefined;
      out.push({
        name,
        description: String(meta.description || '(no description)').trim(),
        prompt: body,
        tools: Array.isArray(meta.tools) ? meta.tools.map(String) : undefined,
        disallowedTools: Array.isArray(meta.disallowedTools)
          ? meta.disallowedTools.map(String)
          : (Array.isArray(meta.disallowed_tools) ? meta.disallowed_tools.map(String) : undefined),
        model: meta.model ? String(meta.model) : undefined,
        maxTurns: maxTurns && maxTurns > 0 ? maxTurns : undefined,
        requiredMcpServers: requiredMcp,
        baseAgent: meta.baseAgent ? String(meta.baseAgent).trim()
          : (meta.base_agent ? String(meta.base_agent).trim() : undefined),
        criticalReminders,
        memory,
        source,
        path: full,
      });
    } catch (err) { swallow(err); }
  }
  return out;
}

/**
 * Load all available custom agents. Resolution order (later entries win):
 *   user-claude → user-makestudio → project-claude → project-makestudio
 * so a project definition always beats a user-level one with the same name.
 */
export function loadCustomAgents(cwd: string): CustomAgent[] {
  const agentsByName = new Map<string, CustomAgent>();
  const sources: Array<[string, CustomAgent['source']]> = [
    [path.join(os.homedir(), '.claude', 'agents'),     'user-claude'],
    [path.join(os.homedir(), '.makestudio', 'agents'), 'user-makestudio'],
    [path.join(cwd, '.claude', 'agents'),              'project-claude'],
    [path.join(cwd, '.makestudio', 'agents'),          'project-makestudio'],
  ];
  for (const [dir, src] of sources) {
    for (const a of loadFromDir(dir, src)) agentsByName.set(a.name, a);
  }
  return Array.from(agentsByName.values());
}

export function findCustomAgent(cwd: string, name: string): CustomAgent | null {
  return loadCustomAgents(cwd).find((a) => a.name === name) || null;
}

/**
 * Resolve a custom agent against its base chain. Returns a "materialised"
 * copy where:
 *   - prompt = base.prompt + "\n\n" + this.prompt
 *   - tools = intersection of base.tools and this.tools (both must allow)
 *   - disallowedTools = union of base.disallowedTools and this.disallowedTools
 *   - criticalReminders = base + this (both injected)
 * Cycle detection: if a chain revisits itself, the cycle is broken and
 * later ancestors are skipped. Max depth = 4 matches Claude Code's cap.
 *
 * When `baseAgent` is a built-in type name ('explore'/'plan'/...), inheritance
 * is skipped for prompt (built-in prompts are constructed by dispatch_agent)
 * but tool defaults are honoured (the built-ins are read-only).
 */
export function resolveAgentInheritance(agent: CustomAgent, cwd: string): CustomAgent {
  const BUILT_IN_TYPES = BUILT_IN_AGENT_NAMES;
  const MAX_DEPTH = 4;
  const visited = new Set<string>([agent.name]);
  let chain: CustomAgent[] = [];
  let cursor: CustomAgent | null = agent;
  while (cursor && cursor.baseAgent && chain.length < MAX_DEPTH) {
    if (BUILT_IN_TYPES.has(cursor.baseAgent)) {
      // Built-in ancestor — nothing to pull from disk. Stop the walk;
      // the dispatch handler applies built-in defaults itself when the
      // final baseAgent in the chain is a built-in type.
      break;
    }
    if (visited.has(cursor.baseAgent)) break; // cycle
    const parent = findCustomAgentRaw(cwd, cursor.baseAgent);
    if (!parent) break;
    visited.add(parent.name);
    chain.push(parent);
    cursor = parent;
  }
  if (chain.length === 0) return agent;

  // Base → tip merge: parent's contributions first, then each descendant.
  chain = chain.reverse();
  let mergedPrompt = chain.map((p) => p.prompt.trim()).filter(Boolean).join('\n\n') + '\n\n' + agent.prompt.trim();
  // tools: intersection. If base has no tools declared (undefined), it
  // means "inherit parent's default"; we keep the child's tools.
  let mergedTools: string[] | undefined = agent.tools;
  for (const p of chain) {
    if (p.tools && p.tools.length > 0) {
      mergedTools = mergedTools
        ? mergedTools.filter((t) => p.tools!.includes(t))
        : [...p.tools];
    }
  }
  // disallowedTools: union.
  const disallowedSet = new Set<string>(agent.disallowedTools || []);
  for (const p of chain) for (const t of (p.disallowedTools || [])) disallowedSet.add(t);
  // criticalReminders: parent first, then child (parent's invariants are
  // usually more fundamental).
  const reminders: string[] = [];
  for (const p of chain) if (p.criticalReminders) reminders.push(...p.criticalReminders);
  if (agent.criticalReminders) reminders.push(...agent.criticalReminders);

  return {
    ...agent,
    prompt: mergedPrompt,
    tools: mergedTools,
    disallowedTools: disallowedSet.size > 0 ? Array.from(disallowedSet) : undefined,
    criticalReminders: reminders.length > 0 ? reminders : undefined,
  };
}

function findCustomAgentRaw(cwd: string, name: string): CustomAgent | null {
  // Non-resolved lookup so inheritance walking doesn't infinite-loop into
  // itself — `findCustomAgent` could be wired to resolve later; keep this
  // internal helper that always does the raw disk read.
  return loadCustomAgents(cwd).find((a) => a.name === name) || null;
}

/**
 * Read/write the agent's memory JSON file. Returns null if memory isn't
 * enabled (`memory: 'none'` or absent). Path resolution:
 *   project → <cwd>/.makestudio/agent-memory/<name>.json
 *   user    → ~/.makestudio/agent-memory/<name>.json
 * File is auto-created empty on first read; writes atomic via temp-then-rename.
 */
export interface AgentMemoryHandle {
  path: string;
  read(): any;
  write(state: any): void;
}

export function getAgentMemory(agent: CustomAgent, cwd: string): AgentMemoryHandle | null {
  if (!agent.memory || agent.memory === 'none') return null;
  const dir = agent.memory === 'project'
    ? path.join(cwd, '.makestudio', 'agent-memory')
    : path.join(os.homedir(), '.makestudio', 'agent-memory');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agent.name}.json`);
  return {
    path: file,
    read(): any {
      try {
        if (!fs.existsSync(file)) return {};
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { return {}; }
    },
    write(state: any): void {
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(tmp, file);
      } catch (err) { swallow(err); }
    },
  };
}

// ── Phase 12: Custom Agents CRUD ──────────────────────────────────────

function safeAgentFileName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return clean || 'untitled';
}

function agentDirFor(scope: 'user' | 'project', cwd?: string): string {
  // We persist into the makestudio-specific path (avoids stomping the user's
  // Claude Code agents in ~/.claude/agents). loadCustomAgents continues to
  // see both, so a user shared with Claude Code stays editable in either UI.
  if (scope === 'project') {
    return path.join(cwd || process.cwd(), '.makestudio', 'agents');
  }
  return path.join(os.homedir(), '.makestudio', 'agents');
}

export interface SaveCustomAgentArgs {
  scope: 'user' | 'project';
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  requiredMcpServers?: string[];
  baseAgent?: string;
  criticalReminders?: string[];
  memory?: 'project' | 'user' | 'none';
  cwd?: string;
}

function yamlString(v: string): string {
  if (!/[":#&*!|>%@`{}[\]\n]/.test(v) && !v.startsWith(' ') && !v.endsWith(' ')) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function yamlList(xs: string[]): string {
  return `[${xs.map(yamlString).join(', ')}]`;
}

/**
 * Persist a custom agent. Refuses built-in names so the user can't shadow
 * `general-purpose` and break dispatch.
 */
export function saveCustomAgent(args: SaveCustomAgentArgs): string {
  const trimmed = args.name.trim();
  if (!trimmed) throw new Error('agent: nome não pode ser vazio');
  if (BUILT_IN_AGENT_NAMES.has(trimmed)) {
    throw new Error(`agent: "${trimmed}" é built-in — escolha outro nome`);
  }
  const dir = agentDirFor(args.scope, args.cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeAgentFileName(trimmed)}.md`);
  const headerLines = [
    '---',
    `name: ${yamlString(trimmed)}`,
    `description: ${yamlString(args.description ?? '')}`,
  ];
  if (args.tools && args.tools.length > 0) headerLines.push(`tools: ${yamlList(args.tools)}`);
  if (args.disallowedTools && args.disallowedTools.length > 0) {
    headerLines.push(`disallowedTools: ${yamlList(args.disallowedTools)}`);
  }
  if (args.model) headerLines.push(`model: ${yamlString(args.model)}`);
  if (typeof args.maxTurns === 'number') headerLines.push(`maxTurns: ${args.maxTurns}`);
  if (args.requiredMcpServers && args.requiredMcpServers.length > 0) {
    headerLines.push(`requiredMcpServers: ${yamlList(args.requiredMcpServers)}`);
  }
  if (args.baseAgent) headerLines.push(`baseAgent: ${yamlString(args.baseAgent)}`);
  if (args.criticalReminders && args.criticalReminders.length > 0) {
    headerLines.push(`criticalReminders: ${yamlList(args.criticalReminders)}`);
  }
  if (args.memory) headerLines.push(`memory: ${yamlString(args.memory)}`);
  headerLines.push('---');
  const content = `${headerLines.join('\n')}\n\n${(args.prompt ?? '').trim()}\n`;
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

export function deleteCustomAgent(scope: 'user' | 'project', name: string, cwd?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (BUILT_IN_AGENT_NAMES.has(trimmed)) {
    throw new Error('agent built-in não pode ser deletado');
  }
  const dir = agentDirFor(scope, cwd);
  if (!fs.existsSync(dir)) return false;
  const direct = path.join(dir, `${safeAgentFileName(trimmed)}.md`);
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

export function builtInAgentNames(): string[] {
  return Array.from(BUILT_IN_AGENT_NAMES);
}

/**
 * Summary string for injection into dispatch_agent's prompt — tells the
 * model which custom agents are available and what each does. Keeps it
 * short; the full prompt only loads when dispatched.
 */
export function customAgentsDescription(cwd: string): string {
  const list = loadCustomAgents(cwd);
  if (list.length === 0) return '';
  const lines = list.map((a) =>
    `  - ${a.name} — ${a.description}${a.tools ? ` [tools: ${a.tools.join(', ')}]` : ''}`,
  );
  return `\n## Custom subagents available in this project/user\n\n${lines.join('\n')}\n\nPass \`subagent_type\` with the agent name (above) to invoke its custom prompt + tool whitelist.`;
}
