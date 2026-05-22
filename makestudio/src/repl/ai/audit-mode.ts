import { swallow } from '../../utils/log';
const AUDIT_REMINDER =
  '<system-reminder>\n' +
  'AUDIT MODE — this turn is a comparison / feature-presence / gap question.\n\n' +
  'EVIDENCE RULES:\n' +
  ' (1) Grep all relevant codebases with the SAME effort — asymmetric reading is the #1 source of false claims.\n' +
  ' (2) Search by PURPOSE not by name. List 2–4 plausible synonyms before concluding "not found".\n' +
  ' (3) Every assertion must include the VERBATIM tool output that proves it (the actual line of code, not just `path:line`). A reference without the line content is performative — paste the line.\n' +
  ' (4) Read implementations before describing what a name does. Names lie (`thinkback` is not what it sounds like).\n' +
  ' (5) Third-party comparisons are HYPOTHESES. Verify each row independently. Do not echo.\n' +
  ' (6) If verification would take more than ~3 tool calls, say "I have not checked yet" and run the check. Do not guess from prior knowledge.\n\n' +
  'OUTPUT FORMAT (cold mode — bound to audit turns):\n' +
  ' • No ranked tables, no scoring (✅/❌/⚖️), no "priority alta/média/baixa". The user ranks themselves.\n' +
  ' • No executive summary, no "what to port" list, no narrative wrap-up unless the user asked for it.\n' +
  ' • Per claim: show the tool command + verbatim output, then ONE line of verdict. Repeat. Stop.\n' +
  ' • Banned phrasing: "based on my reading", "it seems", "perhaps", "this might be", "I think". Either the evidence shows it or it does not.\n' +
  ' • No meta-commentary about your own past mistakes, accuracy score, or process. Just the current verdict.\n' +
  ' • Headers, lists, tables only when 2+ items justify them. A single fact gets a single line.\n' +
  ' • When the user asked you to DO something testable, run the test instead of writing about how to test.\n' +
  '</system-reminder>';

/**
 * Detect audit-style prompts and prepend the AUDIT_REMINDER to the user
 * message body. Sets `ctx.__auditModeActive` so the post-response verifier
 * knows whether to run.
 */
export async function applyAuditMode(
  input: string,
  effectiveInput: string,
  ctx: any,
): Promise<string> {
  try {
    // Hybrid classifier: regex fast-path → heuristic gate → fast-LLM
    // fallback. See agent/src/repl/ai/audit-classifier.ts. Async because
    // stage 3 may make a one-shot fast-tier call (~150ms via Groq).
    const { classifyAuditTurn } = require('./audit-classifier');
    const sample = String(input || '').slice(0, 600).toLowerCase();
    const isAuditTurn = await classifyAuditTurn(input);
    if (isAuditTurn) {
      (ctx as any).__auditModeActive = true;
      try { require('../debug-log').dbgInfo('audit_reminder_injected', { sample: sample.slice(0, 120) }); } catch (err) { swallow(err); }
      return `${AUDIT_REMINDER}\n\n${effectiveInput}`;
    }
    (ctx as any).__auditModeActive = false;
  } catch (err) { swallow(err); }
  return effectiveInput;
}
