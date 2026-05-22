import { swallow } from '../../utils/log';
/**
 * llm-classifier.ts
 *
 * Generic helper for fast-tier LLM classification calls. Used by every
 * place in the codebase that needs semantic judgement on short text where
 * regex has been failing — audit-mode detection, absence-claim
 * extraction, contradiction checking, promised-action detection, etc.
 *
 * Routing:
 *   - Direct fast-tier provider via selectProviderForTier('fast')
 *     (Groq llama-3.3-70b / Cerebras / etc, depending on backend config)
 *   - 3s default timeout — these are gating checks, never block the turn
 *   - Returns null on any failure (no fast tier, network, timeout). Caller
 *     must handle null as "I don't know" — fall back to conservative path
 *     (= don't trigger the safety check), never error the turn.
 */

export interface FastLLMOptions {
  systemPrompt: string;
  userInput: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Tag for the debug log entry. Helps trace which classifier is firing. */
  classifierTag?: string;
}

/**
 * Make a one-shot fast-tier LLM call. Returns the trimmed text response
 * (text content blocks concatenated) or null on failure.
 */
export async function callFastLLM(opts: FastLLMOptions): Promise<string | null> {
  const tag = opts.classifierTag || 'fast_classifier';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { selectProviderForTier } = require('./providers/factory');
    const selection = selectProviderForTier('fast');
    if (!selection) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../debug-log').dbgInfo(`${tag}_skipped`, { reason: 'no_fast_tier' });
      } catch (err) { swallow(err); }
      return null;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3_000);
    let resp: any;
    try {
      resp = await selection.provider.send({
        system: opts.systemPrompt,
        messages: [{ role: 'user', content: opts.userInput.slice(0, 4000) }],
        tools: [],
        effort: 'low',
        maxTokens: opts.maxTokens ?? 200,
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
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../debug-log').dbgInfo(`${tag}_response`, {
        raw: text.slice(0, 200),
        // Surface which model handled the classification so the operator
        // can verify the fast tier is pointing where they expect (e.g.
        // gpt-4.1-mini vs llama-3.3-70b vs haiku-4.5). Log once per call
        // — cheap and high signal.
        provider: selection.entry?.provider,
        model: selection.entry?.model,
      });
    } catch (err) { swallow(err); }
    return text || null;
  } catch (err: any) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../debug-log').dbgWarn(`${tag}_failed`, {
        error: String(err?.message || err).slice(0, 200),
      });
    } catch (err) { swallow(err); }
    return null;
  }
}

/** Parse first JSON array/object found in the LLM response. Returns null
 *  if no valid JSON is found — handles common LLM mistakes (markdown
 *  fence wrapping, prose preamble, trailing commentary). */
export function tryParseJSON<T = any>(raw: string | null): T | null {
  if (!raw) return null;
  // Strip markdown fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Try direct parse
  try { return JSON.parse(cleaned) as T; } catch (err) { swallow(err); }
  // Try first {...} or [...] substring
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  for (const m of [arrMatch, objMatch]) {
    if (!m) continue;
    try { return JSON.parse(m[0]) as T; } catch (err) { swallow(err); }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Specific classifiers
// ────────────────────────────────────────────────────────────────────────

/**
 * Extract absence claims from a coding-assistant response. An absence
 * claim asserts that some software/codebase LACKS a specific feature.
 * Returns a list of {subject, feature} pairs, or [] if none.
 *
 * Used as fallback when the regex-based absence detector misses unusual
 * phrasings ("Sem persistência, sem replay" / "ausência de Y" / etc).
 */
export interface AbsenceClaim {
  subject: string;
  feature: string;
  /** Verbatim phrase from the response that constitutes the claim. */
  phrase: string;
}

export async function extractAbsenceClaims(text: string): Promise<AbsenceClaim[]> {
  const SYSTEM = [
    'You analyze a coding-assistant RESPONSE for ABSENCE CLAIMS.',
    'An ABSENCE CLAIM asserts that some software/project/codebase LACKS,',
    'IS MISSING, or DOES NOT IMPLEMENT a specific feature.',
    '',
    'INPUT LANGUAGE: the response may be in any natural language',
    '(English, Portuguese, Spanish, French, etc.). Match by INTENT,',
    'not by surface words. Idiomatic equivalents of "lacks / is missing /',
    '/ has no / does not implement / never called / only X has Y" all',
    'count as absence claims regardless of language.',
    '',
    'Examples of absence claims (illustrative; the literal wording you',
    'see in real input may differ and may be in any language):',
    '  - "X doesn\'t have file history"',
    '  - "X is missing event sourcing"',
    '  - "X lacks an event bus"',
    '  - "only Y has feature Z" (implies others lack it)',
    '  - "Y is never called" (absence at usage level)',
    '',
    'Output a JSON array of objects: [{"subject":"...","feature":"...","phrase":"..."}].',
    '  subject = the project / module / file the claim is about.',
    '  feature = the capability being denied.',
    '  phrase  = verbatim snippet (≤120 chars) from the input that',
    '            contains the claim — copy it exactly, in whatever',
    '            language the input used.',
    '',
    'If no absence claims, output: []',
    '',
    'Output ONLY valid JSON. No markdown fences, no commentary.',
  ].join('\n');
  const raw = await callFastLLM({
    systemPrompt: SYSTEM,
    userInput: text.slice(0, 4000),
    maxTokens: 800,
    classifierTag: 'absence_extractor',
  });
  const parsed = tryParseJSON<AbsenceClaim[]>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c) => c && typeof c.subject === 'string' && typeof c.feature === 'string')
    .map((c) => ({
      subject: String(c.subject).slice(0, 100),
      feature: String(c.feature).slice(0, 200),
      phrase: typeof c.phrase === 'string' ? c.phrase.slice(0, 200) : '',
    }));
}

/**
 * Check whether an absence claim contradicts the tool outputs the agent
 * collected this turn. Returns the contradicting evidence line, or null
 * if no contradiction.
 */
export async function findContradiction(
  claim: { subject: string; feature: string; phrase: string },
  toolOutputs: string,
): Promise<string | null> {
  if (!toolOutputs.trim()) return null;
  const SYSTEM = [
    'You verify whether an absence CLAIM contradicts EVIDENCE from tool outputs the agent collected this turn.',
    'A contradiction exists when the tool outputs literally show the feature/identifier the claim says is missing.',
    '',
    'If you find a contradiction, output the SINGLE most relevant line from the tool outputs that proves the contradiction (verbatim, ≤200 chars).',
    'If no contradiction (the tool outputs do NOT prove the claim wrong), output exactly: NONE',
    '',
    'Output one line. No markdown, no commentary.',
  ].join('\n');
  const userMsg = [
    `CLAIM: ${claim.phrase || `${claim.subject} lacks ${claim.feature}`}`,
    `(subject=${claim.subject}, feature=${claim.feature})`,
    '',
    'TOOL OUTPUTS (from this turn, may be truncated):',
    toolOutputs.slice(0, 3500),
  ].join('\n');
  const raw = await callFastLLM({
    systemPrompt: SYSTEM,
    userInput: userMsg,
    maxTokens: 250,
    classifierTag: 'contradiction_check',
  });
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^none\b/i.test(trimmed)) return null;
  // Take first non-empty line as the contradicting citation.
  const line = trimmed.split('\n').find((l) => l.trim()) || '';
  return line.slice(0, 240).trim() || null;
}

/**
 * Detect whether the assistant's response presents OUTPUT BLOCKS
 * (shell-log style "command: X / output: Y") that do NOT appear in
 * the real tool outputs collected this turn. This catches the failure
 * mode where a smaller model writes a plausible-looking output block
 * to support a conclusion, instead of pasting the actual tool result.
 *
 * Returns a brief description of the fabricated block, or null if all
 * presented outputs check out.
 *
 * Notes on cost/scope:
 *  - Only meaningful in audit-mode turns (where the agent presents
 *    "verbatim" outputs as evidence). Outside audit mode the agent
 *    typically summarises/synthesises and the comparison is meaningless.
 *  - One LLM call per response. ~$0.0002 worst case.
 */
export async function detectFabricatedOutput(
  responseText: string,
  toolOutputs: string,
): Promise<string | null> {
  if (!toolOutputs.trim()) return null;
  // Skip when the response has no shell-log markers — nothing to verify.
  const hasOutputBlock = /(?:^|\n)\s*(?:`{3,}|```|\$\s+\w|>>>|output:|veredito:|verdict:)/i.test(responseText);
  if (!hasOutputBlock) return null;
  const SYSTEM = [
    'You audit a coding-assistant RESPONSE for FABRICATED tool output.',
    '',
    'The response is structured as a shell log — for each item it shows a',
    'COMMAND followed by an OUTPUT block (often inside ``` fences) and a',
    'VERDICT. You also receive the REAL tool outputs the agent actually',
    'collected this turn.',
    '',
    'Your job: find any OUTPUT block in the response whose content does',
    'NOT correspond to anything in the real tool outputs. The agent is',
    'allowed to TRIM and FILTER the real output (showing only relevant',
    'lines) — that is fine. The agent is NOT allowed to invent output',
    'lines that never existed, or to truncate output in a way that',
    'changes the conclusion (e.g. showing only 2 lines when there were',
    '7 callsites and concluding "zero callsites").',
    '',
    'For each fabricated or selectively-truncated-to-deceive block,',
    'output one short line in this format:',
    '  FABRICATED: <which item / what was wrong / what the real output shows>',
    '',
    'If every output block in the response is consistent with the real',
    'tool outputs (full or honestly trimmed), output exactly: NONE',
    '',
    'Output ONLY the lines as specified. No markdown, no preamble.',
  ].join('\n');
  const userMsg = [
    'RESPONSE FROM AGENT (presented as shell-log audit):',
    '----',
    responseText.slice(0, 6000),
    '----',
    '',
    'REAL TOOL OUTPUTS this turn (concatenated, truncated to relevant slices):',
    '----',
    toolOutputs.slice(0, 6000),
    '----',
  ].join('\n');
  const raw = await callFastLLM({
    systemPrompt: SYSTEM,
    userInput: userMsg,
    maxTokens: 400,
    classifierTag: 'fabricated_output',
  });
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^none\b/i.test(trimmed)) return null;
  // Take all FABRICATED: lines, join briefly.
  const lines = trimmed.split('\n').filter((l) => /^FABRICATED:/i.test(l)).slice(0, 5);
  if (lines.length === 0) return null;
  return lines.join('\n').slice(0, 800);
}

/**
 * Detect whether the assistant's response promises an action it did not
 * carry out (no tool calls in the same turn). Returns a brief description
 * of the broken promise, or null if no promise was made.
 */
export async function detectUnfulfilledPromise(
  userPrompt: string,
  assistantText: string,
): Promise<string | null> {
  const SYSTEM = [
    'You detect UNFULFILLED PROMISES in coding-assistant responses.',
    'An unfulfilled promise = the assistant said it WILL or IS GOING TO take a NEW concrete action (edit a file, run a command, create something) but the response made ZERO tool calls.',
    '',
    'DEFAULT BIAS: when in doubt, output NONE. False positives are far worse than false negatives — an over-eager NONE merely lets a real promise slip; an over-eager PROMISED hijacks a legitimate answer turn and confuses the user.',
    '',
    'CRITICAL — these are NOT unfulfilled promises (output NONE):',
    '  - The response is an AUDIT / REPORT / ANALYSIS / SUMMARY of work the assistant ALREADY did this turn (listed files, read a doc, ran a script). Reporting on completed work is the answer, not a promise.',
    '  - The response describes / summarises / explains existing code, a project structure, or a tool output, without committing to change it',
    '  - The response proposes options for the user to choose',
    '  - The response asks a clarifying question',
    '  - The response references commands as EXAMPLES or DOCUMENTATION (in code fences, tables, or quoted strings) without the assistant claiming to run them',
    '  - The response answers "yes/no" with cited evidence (path:line) and stops',
    '  - The response is a ONE-WORD or SHORT acknowledgement / heading / banner ("Done.", "MakeStudio", "Ok.") — those are presentational, not promissory',
    '  - The response says "I have already done X" / "I just did X" — past tense reports of work done in earlier iterations of the same turn',
    '',
    'These ARE unfulfilled promises (output PROMISED:):',
    '  - "I will edit src/foo.ts to fix this" (no Edit call followed)',
    '  - Any future-tense / volitive phrasing in any language meaning "I am about to do X now" without the corresponding tool call',
    '  - "I\'ll run the tests now" (no Bash call followed) — note the explicit future-tense INTENT to act, not a description of what the user could run',
    '',
    'INPUT LANGUAGE: the response may be in any language. Recognize',
    'future-tense / volitive constructs by INTENT, not by surface words.',
    'Any phrasing that means "I will do X now" / "let me do X" /',
    '"I am going to X" counts, regardless of the language used.',
    '',
    'Heuristic: if the response would still make sense to the user as-is (an answer, a report, a verdict, a summary), it is NOT a promise. Only flag when the response END-STATE clearly expects a follow-up tool call that did not happen, AND the user would feel cheated by the response stopping there.',
    '',
    'WORKED EXAMPLES — output for each:',
    '  USER: "what files are in src/?"',
    '  RESPONSE: "src/ has app.ts, utils.ts, and a tests/ subfolder."',
    '  → NONE (summary of work already done — no future action implied)',
    '',
    '  USER: "summarise the package"',
    '  RESPONSE: "MakeStudio is a local agent CLI. v0.1.1013. Bin: makestudio."',
    '  → NONE (descriptive answer)',
    '',
    '  USER: "fix the TS error"',
    '  RESPONSE: "I\'ll edit src/foo.ts to fix the type mismatch."',
    '  → PROMISED: edit src/foo.ts to fix type mismatch',
    '',
    '  USER: "any more bugs?"',
    '  RESPONSE: "Yes — 3 left, all in handlers/. Let me fix them."',
    '  → PROMISED: fix the 3 remaining bugs in handlers/',
    '',
    'Output: "PROMISED: <≤80 char description>" if and only if a NEW future-tense action was promised and not kept. Otherwise output exactly: NONE',
  ].join('\n');
  const userMsg = [
    `USER PROMPT: ${userPrompt.slice(0, 800)}`,
    '',
    `ASSISTANT RESPONSE (made zero tool calls):`,
    assistantText.slice(0, 2500),
  ].join('\n');
  const raw = await callFastLLM({
    systemPrompt: SYSTEM,
    userInput: userMsg,
    maxTokens: 100,
    classifierTag: 'promised_action',
  });
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^none\b/i.test(trimmed)) return null;
  const m = trimmed.match(/^PROMISED:\s*(.*)$/im);
  return m ? m[1].slice(0, 200).trim() : null;
}

/**
 * Detect FABRICATED NUMERICAL CLAIMS in the response.
 *
 * Failure mode caught: model reports performance numbers / counts /
 * percentages that aren't traceable to tool output from this turn.
 * Common with smaller models doing benchmarks: a script crashes with
 * non-zero exit, model fabricates the would-be numbers and reports them
 * as if measured.
 *
 * Allowed: numbers derived by simple arithmetic from real outputs
 * (e.g. "1500 / 500 = 3× faster"), and absolute literals that DO appear.
 * Disallowed: numbers with no provenance in the corpus.
 *
 * Returns a brief description of the fabricated claim, or null if all
 * claims trace back. One LLM-fast call.
 */
export async function detectFabricatedNumbers(
  responseText: string,
  toolOutputs: string,
): Promise<string | null> {
  if (!toolOutputs.trim()) return null;
  // Cheap pre-gate: skip if the response has no numerical claims with
  // performance-style units. Pure narrative responses are uninteresting.
  const HAS_PERF_NUM = /\b\d+(?:[.,]\d+)?\s*(?:ms\b|µs\b|us\b|s\b|%\b|×|x\s*(?:faster|slower|mais|menos)|times\s+(?:faster|slower)|MB\b|GB\b|KB\b)/i;
  const HAS_RATIO = /\b\d+(?:[.,]\d+)?\s*[→\-]\s*\d+(?:[.,]\d+)?\b/;
  if (!HAS_PERF_NUM.test(responseText) && !HAS_RATIO.test(responseText)) return null;
  const SYSTEM = [
    'You audit a coding-assistant RESPONSE for FABRICATED numerical claims.',
    '',
    'Input: the RESPONSE (with measurements, percentages, or comparisons)',
    'and the REAL TOOL OUTPUTS the agent collected this turn.',
    '',
    'A FABRICATED number = a quantitative claim in the response whose value',
    'CANNOT be derived from the real tool outputs (directly present, OR by',
    'simple arithmetic of values that ARE present).',
    '',
    'Examples of fabrication (flag these):',
    '  - "60-71% faster" when no run produced anything close to 60% or 71%.',
    '  - "1140ms → 458ms" when those exact values do not appear in the',
    '    outputs and no arithmetic on present values yields them.',
    '  - "3× speedup" when the real ratio between present numbers is ~1.1×.',
    '',
    'Examples NOT fabricated (output NONE):',
    '  - "1573ms → 1210ms" when both numbers literally appear in outputs.',
    '  - "saved ~400ms" when 1573 - 1140 ≈ 400 and both values are present.',
    '  - Round-number rephrasings of present values ("about 1.5s" for "1500ms").',
    '',
    'Output one line per fabrication, format:',
    '  FABRICATED-NUMBER: <claim from response> | <why it does not trace>',
    '',
    'If all numerical claims trace back, output exactly: NONE',
    '',
    'Output ONLY those lines. No markdown, no preamble.',
  ].join('\n');
  const userMsg = [
    'RESPONSE FROM AGENT:',
    '----',
    responseText.slice(0, 4000),
    '----',
    '',
    'REAL TOOL OUTPUTS this turn:',
    '----',
    toolOutputs.slice(0, 8000),
    '----',
  ].join('\n');
  const raw = await callFastLLM({
    systemPrompt: SYSTEM,
    userInput: userMsg,
    maxTokens: 400,
    classifierTag: 'fabricated_numbers',
  });
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^none\b/i.test(trimmed)) return null;
  const lines = trimmed.split('\n').filter((l) => /^FABRICATED-NUMBER:/i.test(l)).slice(0, 5);
  if (lines.length === 0) return null;
  return lines.join('\n').slice(0, 800);
}

/**
 * Detect MISSING TEST EXECUTION — the user prompt explicitly demanded
 * tests / deliverables / "RODE" / "paste output literal" but this turn's
 * tool outputs do NOT contain evidence those tests were actually run.
 *
 * Failure mode caught: model implements correctly + claims "done" but
 * skips the testing phase the prompt explicitly required. Different from
 * fabricated-output (which detects INVENTED shell logs in the response):
 * here the response simply OMITS the test phase, doesn't fabricate it.
 *
 * Pre-gate: prompt must contain explicit test/deliverable markers
 * (TESTES, RODE, paste output literal, lettered list (a)(b), Deliverables,
 * etc.). Otherwise return null without an LLM call.
 *
 * Returns a brief description of the missing test(s), or null when all
 * demanded tests have matching tool output (or prompt didn't demand any).
 */
export async function detectMissingTestExecution(
  userPrompt: string,
  toolOutputs: string,
): Promise<string | null> {
  if (!toolOutputs.trim()) return null;
  // Stage 1 — regex pre-gate: prompt must contain explicit test demand.
  // Tighter than "any verb that smells like testing" — requires either
  // a strong all-caps imperative (TESTES/RODE/RUN), an explicit
  // "deliverables/paste literal/output literal" marker, OR at least two
  // lettered list items like "(a) ... (b) ..." (the test-list pattern).
  const HAS_STRONG_MARKER =
    /\bTESTES?\b/.test(userPrompt) ||
    /\bRODE\b/.test(userPrompt) ||
    /\bRUN\b\s+(?:the\s+)?test/i.test(userPrompt) ||
    /\b(?:rode|roda)\s+(?:de\s+verdade|os\s+testes?|tudo|todos?\s+os)\b/i.test(userPrompt) ||
    /\bpaste\s+(?:o\s+|the\s+)?(?:output|literal)/i.test(userPrompt) ||
    /\boutput\s+literal\b/i.test(userPrompt) ||
    /\bdeliverables?\b/i.test(userPrompt) ||
    /\(\s*[a-d]\s*\)[\s\S]*?\(\s*[a-d]\s*\)/i.test(userPrompt);
  if (!HAS_STRONG_MARKER) return null;

  const SYSTEM = [
    'You audit whether an agent ACTUALLY EXECUTED EACH test / command /',
    'deliverable that the USER PROMPT explicitly enumerated.',
    '',
    'CRITICAL — itemized lists must be checked ITEM BY ITEM:',
    'When the prompt contains a lettered list "(a) ... (b) ... (c) ... (d) ..."',
    'or a numbered list "1. ... 2. ... 3. ...", you MUST verify EACH item',
    'individually. Do NOT collapse them into a single binary "tests ran or',
    'not". A demand of "(a)(b)(c)(d)" with 3 executed and 1 skipped is',
    'MISSING — name the skipped item(s).',
    '',
    'Step-by-step process you MUST follow:',
    '  1. Identify the enumerated items in the prompt — every (a), (b), 1., 2.,',
    '     each "rode X" line, each Deliverables bullet.',
    '  2. For EACH item, search the tool outputs for evidence that the',
    '     specific demanded action was executed. The evidence must be a',
    '     command invocation matching the demand (e.g. demand "(d) npm run',
    '     build" requires a tool call that ran `npm run build` or equivalent;',
    '     a `node script.js` does NOT count as evidence for `npm run build`).',
    '  3. Output NONE only when every enumerated item has matching evidence.',
    '  4. If ANY item lacks evidence: output MISSING with the specific items.',
    '',
    'A test is EXECUTED when the tool outputs contain a Bash invocation',
    'matching the demand, with output that corresponds to actually running',
    'the test. SWC compile of one file is NOT evidence for "build the',
    'project". A node script that runs (a)(b)(c) inline is NOT evidence',
    'for a separate (d) demand of "npm run build".',
    '',
    'A test is MISSING when the prompt enumerated it but no matching tool',
    'output exists this turn.',
    '',
    'NOT missing (output NONE for these specific cases):',
    '  - Demands the user explicitly retracted or said "skip" in the prompt.',
    '  - Demands trivially satisfied by static reads when the prompt asked',
    '    for static checks (e.g. "grep -n shows X").',
    '',
    'INPUT LANGUAGE: prompt may be in any language. Match by INTENT.',
    '',
    'Output (ONE LINE):',
    '  "MISSING: (a) <reason>; (b) <reason>; ..." — list each skipped item',
    '            with its identifier as the prompt named it. ≤300 chars.',
    '  "NONE" — every enumerated item has matching tool output evidence.',
    '',
    'No markdown, no preamble, no commentary outside the line above.',
  ].join('\n');

  const userMsg = [
    'USER PROMPT (truncated):',
    '----',
    userPrompt.slice(0, 5000),
    '----',
    '',
    'TOOL OUTPUTS THIS TURN (concatenated, truncated):',
    '----',
    toolOutputs.slice(0, 9000),
    '----',
  ].join('\n');

  const raw = await callFastLLM({
    systemPrompt: SYSTEM,
    userInput: userMsg,
    maxTokens: 350,
    classifierTag: 'missing_test_execution',
  });
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^none\b/i.test(trimmed)) return null;
  const m = trimmed.match(/^MISSING:\s*(.*)$/im);
  if (!m) return null;
  return m[1].slice(0, 400).trim() || null;
}

export interface SearchClaim {
  /** The identifier the assistant claimed has no usage / no caller. */
  identifier: string;
  /** "no_caller" | "unused" | "no_match" | "not_referenced" */
  claimType: string;
  /** Verbatim phrase from the response (≤120 chars). */
  phrase: string;
}

/**
 * Extract NEGATIVE-SEARCH CLAIMS — phrases asserting an identifier has
 * no callers / is unused / is not referenced anywhere.
 *
 * Distinct from extractAbsenceClaims (which targets feature-level claims):
 * here we extract IDENTIFIER-level claims that can be verified by a real
 * grep across the project. Failure mode caught: the model runs a narrow
 * grep, gets no hits, and concludes "X has no callers" without trying
 * synonyms, broader scopes, or alternative paths.
 */
export async function extractSearchClaims(text: string): Promise<SearchClaim[]> {
  // Cheap pre-gate: only call LLM if at least one negative-search phrasing
  // is present. Tighter than absence-claim extractor because we want
  // identifier-level claims, not feature-level.
  const HAS_NEG = /\b(?:no\s+(?:callers?|callsites?|usages?|matches?|references?)|nunca\s+(?:tem|é)\s*(?:chamad|usad|referenciad)|n[aã]o\s+(?:tem\s+)?call(?:site)?|is\s+unused|not\s+referenced|n[aã]o\s+é\s+(?:chamad|usad|referenciad))/i;
  if (!HAS_NEG.test(text)) return [];
  const SYSTEM = [
    'You extract NEGATIVE-SEARCH CLAIMS about specific identifiers from a',
    'coding-assistant response.',
    '',
    'A negative-search claim = the assistant asserts that a SPECIFIC named',
    'identifier (function name, variable name, exported symbol) has',
    'NO callers / is unused / is never referenced / has no matches.',
    '',
    'Examples (illustrative; phrasing may vary across languages):',
    '  - "clearTurnEdits never has a callsite"',
    '  - "fooBar is unused"',
    '  - "no callers for handleX"',
    '  - "X não é chamado em lugar nenhum"',
    '',
    'NOT a search claim (skip):',
    '  - Feature-level absence ("the codebase lacks event sourcing") —',
    '    those aren\'t identifier-greppable.',
    '  - "I found no matches" without naming what was searched.',
    '  - General descriptions of code without negation.',
    '',
    'Output a JSON array of objects:',
    '  [{"identifier": "...", "claimType": "no_caller|unused|no_match|not_referenced", "phrase": "..."}]',
    '  identifier = the exact symbol name (no quotes/backticks).',
    '  claimType  = one of the four above.',
    '  phrase     = verbatim ≤120 chars from response.',
    '',
    'If no negative-search claims, output: []',
    'Output ONLY valid JSON. No markdown fences, no commentary.',
  ].join('\n');
  const raw = await callFastLLM({
    systemPrompt: SYSTEM,
    userInput: text.slice(0, 4000),
    maxTokens: 600,
    classifierTag: 'search_claim_extractor',
  });
  const parsed = tryParseJSON<SearchClaim[]>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c) => c && typeof c.identifier === 'string' && /^[A-Za-z_][\w$]*$/.test(c.identifier))
    .map((c) => ({
      identifier: String(c.identifier).slice(0, 100),
      claimType: typeof c.claimType === 'string' ? c.claimType.slice(0, 30) : 'unused',
      phrase: typeof c.phrase === 'string' ? c.phrase.slice(0, 200) : '',
    }))
    .slice(0, 5);
}
