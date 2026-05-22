import { swallow } from '../../utils/log';
/**
 * audit-classifier.ts
 *
 * Hybrid classifier for "is this turn asking for an audit / comparison /
 * gap-analysis / feature-presence verification?". Used to gate cold-mode
 * + the absence-claim verifier + the contradiction detector in chat.ts.
 *
 * Strategy:
 *   1. Regex fast-path — catches obvious cases at zero cost / zero latency.
 *      Covers ~80% of real audit prompts.
 *   2. Heuristic gate — even if regex misses, only escalate to LLM when
 *      the prompt has signals (long, code-related vocabulary, identifier-
 *      shaped tokens). Plain "oi" / "obrigado" never reach the LLM.
 *   3. LLM fallback (fast tier, ~150ms via Groq/Cerebras llama-3.3-70b)
 *      with 3s timeout. Returns "yes"/"no" classification. Falls back to
 *      false (= not audit) on any failure.
 *
 * The whole chain costs ~$0.0001 when the LLM fires, $0 when regex hits
 * or signals are absent. Per-turn worst case adds ~300ms latency.
 */

// Tiny regex fast-path — ONLY language-agnostic markers that are obvious
// audit signals in any of PT/EN/ES/FR. Used as a shortcut to avoid the
// LLM call on the most frequent obvious cases. Everything else, including
// conjugated audit verbs in any language, goes through the LLM (which
// handles paraphrase + multilingual + intent without growing this list).
//
// History — earlier versions had 6+ regex with PT-BR-specific verb forms
// (`audita\w*`, `auditar`, `revisar`, etc). Every new language or
// conjugation broke them. The right place to handle "is this an audit
// turn?" is the LLM; regex stays here only for the truly universal stems.
const REGEX_FAST_PATH = [
  // "vs" / "versus" / "comparar/compare/compara" — same word root across
  // PT/EN/ES/IT/FR. If the user typed any of these, audit/comparison.
  /\b(vs\.?|versus|compar\w*)\b/i,
];

/** Quick heuristic — does this prompt look "analytical" enough to justify
 *  paying the LLM call? Cheap pure-string check; runs only when regex
 *  misses. Designed to NOT fire on pure chitchat ("olá", "obrigado")
 *  while still escalating any prompt that plausibly asks for verification.
 *
 *  When in doubt the LLM is cheap (~$0.0001) and a missed audit-turn is
 *  expensive (false claims), so we bias toward calling the LLM. */
function looksAnalytical(input: string): boolean {
  // Trivially short — chitchat / yes-no / one-liner commands. ≤25 chars
  // basically excludes only "olá", "ok", "obrigado", "sim", "rodar X".
  if (input.length <= 25) return false;
  // Audit-stem trigger: if the prompt contains any verb stem that exists
  // in PT/EN/ES/FR for "audit/review/verify/inspect/analyze", AT ANY
  // length above the chitchat threshold, escalate to LLM. The LLM does
  // the actual classification — these stems are just escalation triggers,
  // they don't decide on their own.
  if (/\b(audit|review|revis|verif|valid|inspect|analy|análi|anali)\w*/i.test(input)) return true;
  // Feature-presence stems (any language) — short prompts like "X tem Y?"
  // / "does X have Y?" / "tiene Y?" / "X falta Y?".
  if (/\b(tem|t[eê]m|tiene|tienen|has|have|n[aã]o\s+tem|lacks?|missing|falta\w*|gap\w*)\b/i.test(input)) return true;
  // Identifier-shaped token (camelCase function name, dotted path, call):
  if (/[A-Za-z_][A-Za-z0-9_]+(?:\.\w+|\(|::)/.test(input)) return true;
  // Code-vocabulary word in a longer prompt
  if (input.length > 100 && /\b(c[oó]digo|source|file|arquivo|module|fun[cç][aã]o|class|method|function|implementa|sistema|recurso|feature|agent|codebase)\b/i.test(input)) return true;
  // Pasted comparison table (markdown pipes)
  if (/\n\s*\|.*\|.*\|/.test(input)) return true;
  return false;
}

const SYSTEM = [
  'TASK: Classify whether the user prompt is asking for any of:',
  '  - AUDIT or REVIEW of a codebase / agent / system',
  '  - COMPARISON between codebases, tools, or implementations',
  '  - GAP ANALYSIS (what is missing in X, what does X lack)',
  '  - FEATURE-PRESENCE VERIFICATION ("does X have Y?")',
  '  - VALIDATION of someone else\'s claim / comparison / audit',
  '',
  'INPUT LANGUAGE: the user prompt may be written in any language',
  '(English, Portuguese, Spanish, French, etc.). Match by INTENT, not by',
  'specific words. Conjugated verb forms count regardless of language',
  '(e.g. all conjugations of audit/review/verify/inspect/analyze are YES).',
  '',
  'YES — these are audit/comparison/gap prompts:',
  '  - "audit the codebase" / any conjugation of audit/review/verify',
  '  - "compare X to Y" / "X vs Y" / any phrasing of comparison',
  '  - "does X have feature Y?" / feature-presence questions',
  '  - "what is missing in X" / "list the gaps" / "what does X lack"',
  '  - "is this analysis correct?" / "verify this claim"',
  '  - "list everywhere X is called" / "check if X is implemented"',
  '',
  'NO — these are NOT audit prompts:',
  '  - chitchat / greetings / acknowledgements',
  '  - direct action requests ("edit file X", "fix the bug", "deploy")',
  '  - pure how-it-works explanations ("how does X work?")',
  '  - narrative requests ("explain this code")',
  '  - execution requests ("run the tests")',
  '  - simple reading tasks without a comparison goal',
  '',
  'RULES:',
  '  1. Match by INTENT, not by surface words.',
  '  2. Any conjugation in any language counts.',
  '  3. When uncertain → YES. False positives are cheap (slightly more',
  '     terse output). False negatives are expensive (unverified claims).',
  '',
  'OUTPUT: exactly one word — "yes" or "no". No punctuation, no explanation.',
].join('\n');

/**
 * Returns true when the turn should be treated as audit mode (cold-mode
 * reminder + absence-claim verifier active).
 */
export async function classifyAuditTurn(input: string): Promise<boolean> {
  const sample = String(input || '').slice(0, 600).toLowerCase();
  // Stage 1 — regex fast path
  for (const re of REGEX_FAST_PATH) {
    if (re.test(sample)) return true;
  }
  // Stage 2 — heuristic gate (skip LLM when prompt is clearly not analytical)
  if (!looksAnalytical(input)) return false;
  // Stage 3 — fast LLM classification
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { selectProviderForTier } = require('./providers/factory');
    const selection = selectProviderForTier('fast');
    if (!selection) return false; // no fast tier configured → conservative no
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3_000);
    let resp: any;
    try {
      resp = await selection.provider.send({
        system: SYSTEM,
        messages: [{ role: 'user', content: input.slice(0, 1500) }],
        tools: [],
        effort: 'low',
        maxTokens: 5,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const blocks = resp?.content || [];
    const text: string = blocks
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text || '')
      .join('')
      .trim();
    const verdict = /^yes\b/i.test(text);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../debug-log').dbgInfo('audit_classifier_llm', {
        verdict,
        raw: text.slice(0, 60),
        sample: input.slice(0, 120),
        provider: selection.entry?.provider,
        model: selection.entry?.model,
      });
    } catch (err) { swallow(err); }
    return verdict;
  } catch (err: any) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../debug-log').dbgWarn('audit_classifier_failed', {
        error: String(err?.message || err).slice(0, 200),
      });
    } catch (err) { swallow(err); }
    return false;
  }
}
