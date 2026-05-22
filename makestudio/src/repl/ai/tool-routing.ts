import { swallow } from '../../utils/log';
/**
 * tool-routing.ts — pre-turn relevance routing.
 *
 * Inspired by claw-code's `route_prompt(limit=5)` (runtime.py:90-107). When
 * the agent has a large tool catalogue (60+ entries with MCP servers), the
 * model often reaches for tools that have nothing to do with the user's
 * actual request — git_log on a "como estamos" question, for instance.
 * The cause is that everything is visible at once.
 *
 * What this does (dynamic, no hardcode):
 *   1. Tokenise the user's current prompt + the recent assistant text.
 *   2. Score every available tool by how many tokens of its
 *      (name + description) overlap with the prompt tokens. Heavy bonus
 *      when the tool name appears literally in the prompt (e.g. user
 *      typed "Read the file"). Tool aliases (`Bash` → "run", "shell")
 *      help the matcher cover synonyms.
 *   3. Always include a small core set of utility tools (Read, Glob,
 *      Grep, Bash, Edit, Write, MultiEdit, TodoWrite, AskUserQuestion,
 *      memory_search) regardless of score — these come up in nearly
 *      every workflow, and excluding them would force the model to
 *      apologise mid-turn.
 *   4. Pick top-K from the remaining tools. Default K aims at a
 *      catalogue of ~15 tools per turn.
 *
 * Safety nets:
 *   - If the catalogue is already small (<= TARGET total), no-op.
 *   - If the prompt is empty / whitespace, no-op.
 *   - If routing would yield zero scored matches AND the prompt looks
 *     non-trivial, fall back to the full catalogue (we'd rather over-
 *     expose than starve the model on something we can't classify).
 *   - Setting `toolRoutingDisabled: true` in ~/.makestudio/settings.json
 *     bypasses the entire pass.
 */

const ROUTING_TARGET = 15;      // total tools the model sees per turn
// Fallback to full catalogue only when the prompt is genuinely rich
// (lots of distinctive tokens) but our matcher couldn't find a single
// relevant tool — that signals our scoring mistook a complex task for
// a casual question. For short / casual prompts (status, "como estamos"),
// even zero matches just means "core is enough" — keep routing tight.
const SCORE_FALLBACK_THRESHOLD = 15;

// Always-on utility set. Empty list of tools and the model can't even
// fetch a file to understand the project. These are the bread-and-butter
// tools every workflow leans on; the routing decides everything else.
const ALWAYS_INCLUDE = new Set<string>([
  'Read', 'read_file',
  'Glob', 'glob_files',
  'Grep', 'search_code',
  'Bash', 'shell_run',
  'Edit', 'edit_file',
  'Write', 'write_file',
  'MultiEdit',
  'TodoWrite', 'TodoUpdate', 'TodoGet', 'TodoList',
  'AskUserQuestion',
  'memory_search', 'memory_save',
  'web_fetch', 'web_search', 'WebFetch', 'WebSearch',
]);

// Synonyms that make the matcher more forgiving — the user rarely says
// "Bash" out loud; they say "run", "execute", "command". Without this,
// the score for Bash is zero on most prompts.
const NAME_SYNONYMS: Record<string, string[]> = {
  Bash: ['run', 'execute', 'command', 'shell', 'rodar', 'executar'],
  shell_run: ['run', 'execute', 'command', 'shell', 'rodar', 'executar'],
  Read: ['ler', 'leia', 'read', 'see', 'view', 'open', 'abrir', 'mostrar', 'show'],
  read_file: ['ler', 'leia', 'read', 'see', 'view', 'open', 'abrir', 'mostrar', 'show'],
  Glob: ['find', 'list', 'where', 'locate', 'achar', 'procurar', 'listar'],
  Grep: ['search', 'find', 'busca', 'procurar', 'pattern', 'regex'],
  Edit: ['edit', 'change', 'modify', 'alterar', 'mudar', 'corrigir', 'fix'],
  Write: ['create', 'write', 'criar', 'escrever', 'novo'],
  TodoWrite: ['plan', 'task', 'todo', 'tarefa', 'plano'],
  memory_search: ['memory', 'memoria', 'remember', 'lembrar', 'previous', 'antes'],
  web_fetch: ['url', 'http', 'fetch', 'download', 'site', 'page'],
  web_search: ['search', 'google', 'pesquisar', 'web'],
};

const TOKEN_RX = /[a-z0-9_-]{3,}/g;

function tokenize(s: string): string[] {
  if (!s) return [];
  return s.toLowerCase().match(TOKEN_RX) || [];
}

function scoreTool(promptTokens: Set<string>, tool: any): number {
  if (!tool) return 0;
  const name: string = tool.name || '';
  const desc: string = tool.description || '';
  const synonyms = NAME_SYNONYMS[name] || [];
  // Tool's own vocabulary: name + description + synonyms.
  const toolTokens = new Set<string>([
    ...tokenize(`${name} ${desc}`),
    ...synonyms.map((s) => s.toLowerCase()),
  ]);
  let score = 0;
  for (const tok of toolTokens) {
    if (promptTokens.has(tok)) score += 1;
  }
  // Heavy boost when the tool name appears in the prompt verbatim — that
  // is by far the strongest signal of intent ("call Read on X").
  if (name && promptTokens.has(name.toLowerCase())) score += 10;
  return score;
}

export interface RouteToolsOptions {
  limit?: number;
  /** Force the full catalogue regardless of routing decision. */
  bypass?: boolean;
}

/**
 * Returns a filtered tool list for the current turn. Pure function —
 * input array is not mutated. Order: ALWAYS_INCLUDE first (in their
 * original catalogue order), then scored remainder in descending score.
 */
export function routeTools(
  promptText: string,
  allTools: any[],
  opts: RouteToolsOptions = {},
): any[] {
  const limit = opts.limit ?? ROUTING_TARGET;
  if (opts.bypass) return allTools;
  if (!Array.isArray(allTools) || allTools.length <= limit) return allTools;
  const trimmed = (promptText || '').trim();
  if (!trimmed) return allTools;

  // Per-user opt-out.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('../settings');
    if (loadSettings()?.toolRoutingDisabled === true) return allTools;
  } catch (err) { swallow(err); }

  const promptTokens = new Set(tokenize(trimmed));

  // Split tools into "core utility" (always in) and "context-dependent"
  // (rank-and-filter). Core may have < limit entries, leaving room for
  // the scored picks below.
  const core: any[] = [];
  const contextual: any[] = [];
  for (const t of allTools) {
    if (t && ALWAYS_INCLUDE.has(t.name)) core.push(t);
    else contextual.push(t);
  }

  const scored = contextual.map((t) => ({ tool: t, score: scoreTool(promptTokens, t) }));
  // Total signal in the contextual layer. If the prompt is rich (lots
  // of distinctive tokens) but no contextual tool matched, we'd rather
  // expose all than guess wrong — fall back to full catalogue.
  const totalScore = scored.reduce((a, b) => a + b.score, 0);
  if (totalScore === 0 && promptTokens.size >= SCORE_FALLBACK_THRESHOLD) {
    return allTools;
  }

  scored.sort((a, b) => b.score - a.score);
  const slots = Math.max(0, limit - core.length);
  const picked = scored.slice(0, slots).map((s) => s.tool);

  // Maintain the original catalogue order within `core` (callers may
  // depend on it for cache-stable serialisation), and append picked in
  // score order. Cache_control marker is applied to the LAST item by
  // the backend, so the *order itself* matters for cache reuse — but
  // routing is, by design, dynamic per turn, so we already trade cache
  // stability for narrower attention.
  return [...core, ...picked];
}
