import { swallow } from '../../utils/log';
/**
 * Per-iteration guards that run AFTER the streaming response has been
 * fully consumed but BEFORE we decide to break out of the tool loop.
 * Each guard can inject a synthetic correction into chatMessages and
 * tell the caller to retry the iteration.
 *
 * Pattern (one-shot per turn): each guard checks its own
 * `__<name>RetryDone` / `__<name>Fired` flag on ctx, fires once, and
 * returns true. The caller `continue`s the outer for-loop.
 *
 * Same shape as `runAntiFabricationGuards` in chat-guards.ts.
 */

export interface StreamingGuardArgs {
  ctx: any;
  accumulatedText: string;
  toolUses: any[];
  chatMessages: any[];
  buildAssistantMessage: (text: string | null, toolCalls?: any[]) => any;
  bridge: { addMessage: (m: any) => any };
}

const TOOL_MARKUP_PATTERNS: RegExp[] = [
  // DeepSeek fullwidth-pipe markup (｜ = U+FF5C). Covers
  // <｜DSML｜tool_calls>, <｜DSML｜invoke name="…">,
  // <｜DSML｜parameter name="…">, <｜tool_calls｜>, etc. The
  // marker is "fullwidth pipe + tool/DSML keyword + fullwidth
  // pipe", optionally with a trailing tag-name; we match the
  // whole tag up to the closing >.
  /<[^>\n]{0,8}[｜|][^>\n]{0,8}(?:DSML|tool[_-]?calls?|tool[_-]?use|invoke|function[_-]?calls?)[^>\n]{0,40}>/i,
  // Anthropic-style markup (function_calls/invoke/parameter)
  /<\s*function_calls\s*>[\s\S]*?<\s*invoke\b/i,
  /<\s*invoke\s+name\s*=\s*["'][\w-]+["']/i,
  // OpenAI-style tool-call markers
  /<\|\s*tool[_-]?call[_-]?(?:start|begin|sep)\s*\|>/i,
  // Bracket-style markers used by some OSS models
  /\[TOOL[_-]?CALL\][\s\S]{0,200}\[\/TOOL[_-]?CALL\]/i,
];

const MAX_TOOL_MARKUP_RETRIES = 2;

/**
 * Detects when a model emitted tool-call serialization markup as PROSE
 * TEXT instead of via the structured tool-use API. Common with
 * DeepSeek-V3, occasional Qwen and other OSS models.
 *
 * Allows up to MAX_TOOL_MARKUP_RETRIES retries with escalating prompts,
 * then aborts the turn with a clear error so the user never sees the
 * garbage markup as a final response. The caller checks
 * `ctx.__toolMarkupAbort` and breaks the loop on abort.
 */
export function runToolMarkupGuard(args: StreamingGuardArgs): boolean {
  const { ctx, accumulatedText, toolUses, chatMessages, buildAssistantMessage, bridge } = args;
  if (toolUses.length !== 0 || !accumulatedText) return false;

  let matchedMarkup: string | null = null;
  for (const re of TOOL_MARKUP_PATTERNS) {
    const m = accumulatedText.match(re);
    if (m) {
      matchedMarkup = m[0].slice(0, 120);
      break;
    }
  }
  if (!matchedMarkup) return false;

  const prevCount = ((ctx as any).__toolMarkupRetryCount as number | undefined) ?? 0;
  const count = prevCount + 1;
  (ctx as any).__toolMarkupRetryCount = count;

  try {
    const dbg = require('../debug-log');
    dbg.dbgWarn('tool_markup_as_text', {
      pattern: matchedMarkup,
      model: ctx.providerInfo?.model || 'unknown',
      attempt: count,
      max: MAX_TOOL_MARKUP_RETRIES,
    });
  } catch (err) { swallow(err); }

  if (count > MAX_TOOL_MARKUP_RETRIES) {
    // Escape hatch: the model has produced this garbage > MAX times in
    // a row. Stop retrying and abort the turn cleanly so the user
    // never sees the markup as a final assistant message.
    (ctx as any).__toolMarkupAbort = true;
    bridge.addMessage({
      role: 'error',
      text:
        `Modelo continuou emitindo markup de tool-call como texto após ${MAX_TOOL_MARKUP_RETRIES} tentativas. ` +
        'Tente trocar o modelo via /model — provavelmente um modelo menor ou mal-tunado para tool-use.',
    });
    return true;
  }

  const escalation =
    count === 1
      ? ''
      : '\n\nSEGUNDA tentativa — você ignorou a instrução anterior. ' +
        'Apenas RESPONDA ao usuário em texto comum. NÃO emita NENHUMA tag, NENHUM markup, NENHUMA chamada de tool. Apenas texto puro.';

  bridge.addMessage({
    role: 'warn',
    text: `(model emitted tool-call markup as text — ${matchedMarkup.slice(0, 60)}… — retrying ${count}/${MAX_TOOL_MARKUP_RETRIES})`,
  });
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      '<system-reminder>\n' +
      'You wrote tool-call MARKUP as plain text inside your response — that is NOT how tools are invoked. The markup gets shown to the user as garbage text and NO tool actually runs.\n\n' +
      `Detected pattern: \`${matchedMarkup}\`\n\n` +
      'To call a tool, use the structured tool-call API (the same way you would call any other function in this conversation). Do NOT emit:\n' +
      '  • `<｜DSML｜tool_calls>` / `<｜DSML｜invoke …>` / `<｜DSML｜parameter …>` (DeepSeek internal markup)\n' +
      '  • `<function_calls><invoke name="…">…</invoke></function_calls>` (Anthropic-style markup)\n' +
      '  • `<|tool_call_start|>` / `[TOOL_CALL]` (other vendor markup)\n\n' +
      'These are SERIALIZATION FORMATS used internally by the API — they must NEVER appear in your text output. If you intend to call a tool, just call it. Re-emit the response now: either (a) actually invoke the tool you intended via the proper tool API, or (b) re-emit the response without that markup if no tool call was needed.' +
      escalation +
      '\n</system-reminder>',
  });
  return true;
}

/**
 * Pure: does the LAST sentence of the response end with an interrogative
 * marker? Used by runPromisedActionGuard to bail out before the LLM
 * promise-classifier ever runs — questions are permission-requests, not
 * promises, regardless of language.
 *
 * Recognises `?` (universal) and `¿` (Spanish opening, when the response
 * itself is structured around it). Last-sentence boundary is the
 * rightmost of `.`, `!`, `?` — the trailing punctuation tells us the
 * closing intent.
 *
 * Exported for unit testing.
 */
export function lastSentenceIsQuestion(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  // Strip a closing parenthesis / bracket / brace / quote that some
  // models append after the punctuation.
  const stripped = trimmed.replace(/[)\]}>"']+$/, '');
  const lastChar = stripped[stripped.length - 1];
  return lastChar === '?' || lastChar === '¿';
}

/**
 * If the model described a tool action in prose but emitted zero
 * tool_use blocks, inject a single correction and retry. Two-stage
 * detection: regex fast-path (compiler/test errors → fix promised),
 * then LLM classifier for creative phrasings.
 */
export async function runPromisedActionGuard(args: StreamingGuardArgs): Promise<boolean> {
  const { ctx, accumulatedText, toolUses, chatMessages, buildAssistantMessage, bridge } = args;
  if (toolUses.length !== 0 || !accumulatedText) return false;
  if ((ctx as any).__promisedActionNudgeFired) return false;

  // Audit/report bail: if the agent already performed ≥1 tool call this
  // turn, the response is reporting on completed work — not a fresh
  // promise. This is THE primary cause of false positives: model lists
  // a directory with Glob/Bash, then summarises in prose, and the
  // classifier (small fast LLM) misreads the summary as "I will do X".
  // The classifier prompt already has "AUDIT/REPORT → NONE" but smaller
  // models miss it; gate it deterministically here. ctx.__turnToolCount
  // is reset per-turn in chat.ts and incremented by every tool dispatch.
  if (((ctx as any).__turnToolCount || 0) > 0) return false;

  const lastUserMsg = (() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i] as any;
      if (m?.role === 'user' && typeof m?.content === 'string') return m.content;
      if (m?.role === 'user' && Array.isArray(m?.content)) {
        const t = m.content.find((c: any) => c.type === 'text');
        if (t) return t.text || '';
      }
    }
    return '';
  })();
  // Question-form bail: when the assistant's last sentence is a
  // question — "ataco?" / "should I…?" / "¿sigo?" / "vamos?" — it is
  // ASKING PERMISSION, not promising action. The classifier prompt
  // already says "asks a clarifying question → NONE", but smaller
  // classifier models occasionally mis-fire when the message has a
  // statement-then-question shape ("Next up: X — go ahead?"). A
  // punctuation-level pre-check is language-agnostic (every language
  // uses `?` for interrogatives, plus Spanish opens with `¿`) and
  // cheaper than the LLM call.
  const tail = accumulatedText.trim();
  if (lastSentenceIsQuestion(tail)) return false;

  const hasPendingErrors =
    /error TS\d+|Found \d+ error|FAILED|✗|Exception|AssertionError|SyntaxError|TypeError/i.test(lastUserMsg);
  let promiseDescription: string | null = null;
  if (hasPendingErrors) {
    promiseDescription = 'fix the compile/test error described in the previous turn';
  } else if (accumulatedText.length > 80) {
    // Stage 2 — LLM classifier. Only when the response is long
    // enough to plausibly contain a promise (skips one-liner
    // acknowledgements). Returns null if nothing was promised.
    try {
      const { detectUnfulfilledPromise } = require('./llm-classifier');
      promiseDescription = await detectUnfulfilledPromise(lastUserMsg, accumulatedText);
    } catch (err) { swallow(err); }
  }
  if (!promiseDescription) return false;

  (ctx as any).__promisedActionNudgeFired = true;
  bridge.addMessage({
    role: 'warn',
    text: `(your response looked like it promised an action — ${promiseDescription} — but made no tool call. nudging)`,
  });
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      `Your previous response appeared to commit to: ${promiseDescription}. ` +
      'But it made ZERO tool calls — so the action did not happen. Two paths:\n' +
      '  (a) If you DID intend to take that action — call the appropriate tool (Edit / Write / Bash / etc) NOW to carry it out. Do not describe it again.\n' +
      '  (b) If the previous response was an answer / report / explanation and the "promise" was a misclassification — re-emit the SAME ANSWER to the user, in plain language, without committing to a new action. Do NOT echo this nudge or apologise; just answer the user.',
  });
  return true;
}

/**
 * Audit-mode only — if the response makes a generic absence claim
 * ("X lacks Y", "no Z", "missing W") AND no tool call this turn touched
 * the project root, force a retry asking the model to verify or hedge.
 *
 * The detector is project-agnostic — it derives the search root from
 * ctx.activeProject / ctx.cwd, so it ports across codebases.
 */
export async function runAbsenceClaimGuard(args: StreamingGuardArgs): Promise<boolean> {
  const { ctx, accumulatedText, toolUses, chatMessages, buildAssistantMessage } = args;
  if (
    toolUses.length !== 0 ||
    !accumulatedText ||
    (ctx as any).__verifierRetryDone ||
    !(ctx as any).__auditModeActive
  ) return false;

  const text = accumulatedText;
  // Generic absence-claim shapes — NO project name hardcoded. The
  // patterns key on (subject) + (negation) + (have-verb) + (object)
  // across English, PT-BR, and Spanish. Narrow on purpose so plain
  // prose like "the user lacks context" doesn't false-positive.
  const NEG_HAVE = '(?:lacks?|is\\s+missing|n[aã]o\\s+(?:tem|t[êe]m|possui|implementa|suporta|exp[oõ]e)|sin\\s+(?:tener|implementar)|(?:doesn\'?t|does\\s+not|don\'?t|do\\s+not|n[aã]o)\\s+(?:has|have|contains?|provides?|exposes?|supports?|implements?|tem|possui|implementa|suporta))';
  // Pronouns to filter out — when the matched subject is a generic
  // person/user pronoun, it's not a codebase claim.
  const NON_CODE_SUBJECT = /^(you|i|we|he|she|they|it|voc[eê]|eu|n[oó]s|ele|ela|elas|eles|usu[aá]rio|user)$/i;
  const absencePatterns: RegExp[] = [
    new RegExp('\\b([A-Z][\\w-]+|nosso(?:\\s+\\w+){0,2}|esta\\s+(?:codebase|projeto|project|app))\\s+' + NEG_HAVE + '\\b', 'i'),
    /\b(?:somente|apenas|s[oó]|only|just|sólo)\s+([A-Z][\w-]+(?:\s*-?\s*\w+){0,2})\s+(?:tem|has|implementa|implements|provides?|supports?|expone|exp[õo]e|tiene)\b/i,
    /\b(?:falta(?:m|\s+\w+){0,2}|missing|absent)\s+(?:in|no|na|em|en)\s+([A-Z]?[\w-]+)\b/i,
    /\b(?:nada|zero|none|nothing)\s+(?:de|of)\s+\w+\s+(?:no|em|in|en)\s+\w+/i,
    /[A-Z][\w-]+\s*:[^\n]{0,200}\bsem\s+\w+\b[^\n]{0,120}\bsem\s+\w+/i,
    /\b(?:em\s+mem[óo]ria|in.?memory|stateless|ephemeral)\b[^\n]{0,120}\b(?:sem\s+\w+|no\s+\w+|n[aã]o\s+\w+)\b/i,
  ];
  let matchedClaim: RegExpMatchArray | null = null;
  for (const re of absencePatterns) {
    const m = text.match(re);
    if (!m) continue;
    const subj = (m.slice(1).find((g) => typeof g === 'string') || '').trim();
    if (subj && NON_CODE_SUBJECT.test(subj)) continue;
    matchedClaim = m;
    break;
  }
  // LLM fallback — when regex finds nothing but the response is long
  // enough to plausibly contain an absence claim. extractAbsenceClaims
  // catches paraphrases and unusual phrasings the regex misses.
  if (!matchedClaim && text.length > 200) {
    try {
      const { extractAbsenceClaims } = require('./llm-classifier');
      const llmClaims = await extractAbsenceClaims(text);
      if (llmClaims.length > 0) {
        const c = llmClaims[0];
        const phrase: string = c.phrase || `${c.subject} lacks ${c.feature}`;
        matchedClaim = Object.assign([phrase], { index: text.indexOf(phrase.slice(0, 30)) || 0, input: text }) as any;
      }
    } catch (err) { swallow(err); }
  }
  if (!matchedClaim) return false;

  // Did this turn search the active project / cwd? Look at tool
  // outputs and assistant tool_use inputs for paths inside the
  // current workspace. Project-agnostic: derives the search root
  // from ctx, not a hardcoded path.
  const projectRoot = String(
    ctx.activeProject?.localPath || ctx.cwd || process.cwd(),
  ).replace(/\/+$/, '');
  const projectRootBase = projectRoot.split('/').filter(Boolean).slice(-2).join('/');
  const searched = chatMessages.some((m: any) => {
    if (!m || (m.role !== 'tool' && m.role !== 'assistant')) return false;
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (!c) return false;
    return c.includes(projectRoot) ||
      (projectRootBase.length > 0 && c.includes(projectRootBase));
  });
  if (searched) return false;

  (ctx as any).__verifierRetryDone = true;
  try {
    const dbg = require('../debug-log');
    dbg.dbgWarn('absence_claim_unverified', {
      claim: matchedClaim[0].slice(0, 200),
      snippet: text.slice(Math.max(0, (matchedClaim.index || 0) - 40), (matchedClaim.index || 0) + 200),
      projectRoot,
    });
  } catch (err) { swallow(err); }
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      '<system-reminder>\n' +
      `STOP — your response asserted "${matchedClaim[0]}" without grepping the codebase to verify. ` +
      'This is exactly the failure mode the VERIFY-BEFORE-ASSERTING rule (in your system prompt) prohibits: claiming a codebase lacks a feature without actually searching for it.\n\n' +
      `The current project root is \`${projectRoot}\`. No tool call this turn touched a path under that root, yet the response makes an absence claim. Either:\n` +
      '  (a) Run `Grep` / `Glob` / `Bash find` against the project root with 2–4 plausible synonyms for the feature, then re-emit with `path:line` evidence — or corrected if the feature exists.\n' +
      '  (b) Re-emit the response with the absence claim REMOVED or rewritten in HEDGED language ("I haven\'t verified yet whether X has Y").\n\n' +
      'Concrete past failures of this exact kind are in your session memory — consult `audit_failures*` topics there before re-deriving file paths from prior knowledge.\n\n' +
      'DO NOT re-emit the same unverified claim. Verify or hedge.\n' +
      '</system-reminder>',
  });
  return true;
}

/**
 * Audit-mode only — catches the harder failure mode: the agent ran the
 * search, the search returned the evidence, AND IGNORED IT. Builds a
 * tool-output corpus from this turn and looks for absence claims that
 * contradict identifiers actually present in tool output.
 */
export async function runContradictionGuard(args: StreamingGuardArgs): Promise<boolean> {
  const { ctx, accumulatedText, toolUses, chatMessages, buildAssistantMessage } = args;
  if (
    toolUses.length !== 0 ||
    !accumulatedText ||
    (ctx as any).__contradictionRetryDone ||
    !(ctx as any).__auditModeActive
  ) return false;

  const text = accumulatedText;
  const toolOutputCorpus = chatMessages
    .filter((m: any) => m?.role === 'tool')
    .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))
    .join('\n---\n')
    .slice(0, 8000);

  const ABSENCE_BY_ID = /[`'"]([A-Za-z_][\w.]{2,})[`'"][^.\n]{0,120}\b(?:nunca|never|sem\s+callsite|n[aã]o\s+(?:existe|chamado|funcional|implementad[ao]|encontrad[ao])|not\s+found|zero\s+(?:callsites?|matches?|usages?|hits?)|n[aã]o\s+(?:em|in)\s+runtime)/gi;
  const seen = new Set<string>();
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  type Contradiction = { id: string; full: string; line: string };
  const contradictions: Contradiction[] = [];
  for (const m of text.matchAll(ABSENCE_BY_ID)) {
    const id = m[1];
    if (!id || seen.has(id) || id.length < 3) continue;
    if (/^(the|and|for|not|but|with|some|any|all|none|null|true|false)$/i.test(id)) continue;
    seen.add(id);
    const idRe = new RegExp(`\\b${escapeRe(id)}\\b`);
    if (idRe.test(toolOutputCorpus)) {
      const line = toolOutputCorpus.split('\n').find((l: string) => idRe.test(l)) || '';
      contradictions.push({ id, full: m[0], line: line.slice(0, 240).trim() });
    }
  }
  // Stage 2 — LLM fallback for absence claims expressed without
  // backticks. Run LLM extraction + semantic contradiction check.
  if (contradictions.length === 0 && text.length > 100 && toolOutputCorpus.length > 100) {
    try {
      const { extractAbsenceClaims, findContradiction } = require('./llm-classifier');
      const llmClaims = await extractAbsenceClaims(text);
      for (const claim of llmClaims) {
        const line = await findContradiction(claim, toolOutputCorpus);
        if (line) {
          contradictions.push({
            id: claim.feature.slice(0, 60),
            full: claim.phrase || `${claim.subject} lacks ${claim.feature}`,
            line: line.slice(0, 240),
          });
        }
      }
    } catch (err) { swallow(err); }
  }
  if (contradictions.length === 0) return false;

  (ctx as any).__contradictionRetryDone = true;
  try {
    const dbg = require('../debug-log');
    dbg.dbgWarn('contradiction_detected', {
      count: contradictions.length,
      samples: contradictions.slice(0, 3).map((c) => ({ id: c.id, line: c.line.slice(0, 160) })),
    });
  } catch (err) { swallow(err); }
  const list = contradictions
    .slice(0, 5)
    .map((c, i) => `  ${i + 1}. claim asserted "${c.full.slice(0, 100)}", but a tool result this turn contains:\n     ${c.line || '(line not extractable — see tool history)'}`)
    .join('\n');
  chatMessages.push(buildAssistantMessage(accumulatedText));
  chatMessages.push({
    role: 'user',
    content:
      '<system-reminder>\n' +
      'CONTRADICTION DETECTED — your response makes absence claims about identifiers that ARE present in tool results from this same turn. You ran the search, the search returned the evidence, and your conclusion contradicts the evidence.\n\n' +
      `Found ${contradictions.length} contradiction(s):\n${list}\n\n` +
      'Re-read the tool outputs above. For each contradiction, EITHER retract the absence claim (the evidence shows the identifier exists) OR — if the claim was about something more specific (e.g. "called from <path>" while the match is in a different path) — narrow the claim with the citation, do not re-emit the original wording.\n\n' +
      'DO NOT re-emit the same wording. The reader can see the same tool output and will spot the contradiction.\n' +
      '</system-reminder>',
  });
  return true;
}

/**
 * Run all four streaming guards in sequence. Returns true if any guard
 * fired (caller should `continue` the outer for-loop).
 */
export async function runStreamingGuards(args: StreamingGuardArgs): Promise<boolean> {
  if (runToolMarkupGuard(args)) return true;
  if (await runPromisedActionGuard(args)) return true;
  if (await runAbsenceClaimGuard(args)) return true;
  if (await runContradictionGuard(args)) return true;
  return false;
}
