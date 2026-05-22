import { swallow } from '../../utils/log';
/**
 * suggestion.ts
 *
 * Port of Claude Code's services/PromptSuggestion. After each assistant
 * turn we fire a background LLM call that predicts what the user is
 * likely to type next — 2-12 words, concrete, matching the user's style.
 *
 * The SUGGESTION_PROMPT below is the verbatim `SUGGESTION_PROMPT` from
 * claude-code/src/services/PromptSuggestion/promptSuggestion.ts:258.
 *
 * Differences from Claude Code: we reuse our main provider (no forkedAgent
 * infra), we don't cache-safe params, we don't gate via GrowthBook. Same
 * behaviour externally: a single short line the user can Tab-accept.
 */

import { ReplContext } from '../context';
import { getProvider } from './providers';

// Verbatim from Claude Code — do not edit the wording.
export const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`;

// Full 12-filter suite mirrored from Claude Code's
// src/services/PromptSuggestion/promptSuggestion.ts:367-456. Each rule
// targets a failure mode the small model regularly produces even with
// the suggestion prompt in place. Returning the reason (not just true)
// lets us /stats-style telemetry show which filter fires most.

const META_WRAPPED_RE = /^\(.*\)$|^\[.*\]$/;
const META_SILENCE_RE = /\bsilence is\b|\bstay(s|ing)? silent\b/;
const META_BARE_SILENCE_RE = /^\W*silence\W*$/;
const PREFIXED_LABEL_RE = /^\w+:\s/;
const MULTI_SENTENCE_RE = /[.!?]\s+[A-Z]/;
const FORMATTING_RE = /[\n*]|\*\*/;
const EVALUATIVE_RE =
  /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/;
const CLAUDE_VOICE_RE =
  /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i;

// Single-word exceptions that ARE valid suggestions (agent shortcuts).
const SINGLE_WORD_ALLOW = new Set([
  'yes', 'yeah', 'yep', 'yea', 'yup',
  'sure', 'ok', 'okay',
  'push', 'commit', 'deploy', 'stop', 'continue', 'check', 'exit', 'quit',
  'no',
]);

const ERROR_PREFIXES = [
  'api error:', 'prompt is too long', 'request timed out',
  'invalid api key', 'image was too large',
];
const META_TEXT_STARTS = [
  'nothing found', 'nothing to suggest', 'no suggestion',
];

export function shouldFilter(text: string): boolean {
  return shouldFilterWithReason(text) !== null;
}

/** Returns the filter name that rejected the suggestion, or null if accepted. */
export function shouldFilterWithReason(raw: string): string | null {
  const t = (raw || '').trim();
  const tl = t.toLowerCase();

  if (tl === '' || tl === 'done') return 'done';

  // Questions — the prompt explicitly bans them. Claude Code's filter
  // catches them via multi-sentence / formatting rules, but a plain
  // "what about using redis?" slips through those. Match the trailing
  // question mark directly.
  if (t.endsWith('?')) return 'question';

  if (META_TEXT_STARTS.some((p) => tl.startsWith(p))) return 'meta_text';
  if (META_SILENCE_RE.test(tl) || META_BARE_SILENCE_RE.test(tl)) return 'meta_text';

  if (META_WRAPPED_RE.test(t)) return 'meta_wrapped';

  if (ERROR_PREFIXES.some((p) => tl.startsWith(p))) return 'error_message';

  if (PREFIXED_LABEL_RE.test(t)) return 'prefixed_label';

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    if (!t.startsWith('/') && !SINGLE_WORD_ALLOW.has(tl)) return 'too_few_words';
  }
  if (words.length > 12) return 'too_many_words';
  if (t.length >= 100) return 'too_long';

  if (MULTI_SENTENCE_RE.test(t)) return 'multiple_sentences';
  if (FORMATTING_RE.test(t)) return 'has_formatting';

  if (EVALUATIVE_RE.test(tl)) return 'evaluative';
  if (CLAUDE_VOICE_RE.test(t)) return 'claude_voice';

  return null;
}

/**
 * Generate a single-line suggestion for the user's next prompt. Returns
 * null when the model produced nothing useful or the request was aborted.
 * Uses the provider already configured on ctx; cheap because max_tokens
 * is capped and the context is the same (cache-friendly).
 */
export async function generateSuggestion(
  ctx: ReplContext,
  signal?: AbortSignal,
): Promise<string | null> {
  if (ctx.messages.length === 0) return null;
  // Disable via env (same lever Claude Code honours).
  const envFlag = process.env.MAKESTUDIO_ENABLE_PROMPT_SUGGESTION;
  if (envFlag === '0' || envFlag === 'false') return null;
  // Disable via settings.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require('../settings').loadSettings().suggestionsDisabled) return null;
  } catch (err) { swallow(err); }

  const provider = getProvider(ctx.provider);
  if (!provider.sendMessage) return null;

  try {
    const msgs = ctx.messages.map(m => ({ role: m.role, content: m.content }));
    // Most providers (DeepSeek, Groq) require the last message to be from
    // user — an assistant-ending conversation triggers "consecutive assistant"
    // errors. Append a minimal trigger so the suggestion prompt can fire.
    if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'user') {
      msgs.push({ role: 'user', content: 'What would I type next?' });
    }
    const params = {
      system: SUGGESTION_PROMPT,
      messages: msgs,
      tools: [],
      effort: 'low' as const,
      signal,
    };
    // Fires after every assistant turn — a strong candidate for the fast
    // provider. Falls back to the primary if role=fast isn't set.
    let response: any = null;
    if (provider.sendSmall) {
      response = await provider.sendSmall(params as any);
    }
    if (!response) {
      response = await provider.sendMessage(params as any);
    }
    const raw: string = (response?.content || [])
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
      .trim();
    if (!raw) return null;
    // Strip common wrappers the model sometimes adds despite the prompt.
    const cleaned = raw
      .replace(/^["'`]+/, '')
      .replace(/["'`]+$/, '')
      .split('\n')[0]!
      .trim();
    const rejectReason = shouldFilterWithReason(cleaned);
    if (rejectReason !== null) {
      try {
        require('../../utils/events').recordEvent('suggestion_filtered', {
          reason: rejectReason,
          length: cleaned.length,
          words: cleaned.split(/\s+/).filter(Boolean).length,
        });
      } catch (err) { swallow(err); }
      return null;
    }
    return cleaned;
  } catch {
    return null;
  }
}
