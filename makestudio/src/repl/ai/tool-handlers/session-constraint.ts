/**
 * pin_session_constraint — LLM-driven constraint pinning.
 *
 * The model reads the user's message, decides whether it contains a
 * session-wide rule, and calls this tool with the canonical text PLUS
 * (optionally) a shell command that verifies the rule for THIS PROJECT.
 *
 * Language-agnostic by design — this tool does NOT know about
 * TypeScript, Node, Python, Rust, Go, Flutter, or Java. The model picks
 * `verifyCommand` based on the project's actual stack (e.g.
 * `npx tsc --noEmit` for TS, `cargo check` for Rust, `pytest -q` for
 * Python, `flutter analyze` for Flutter, `mvn verify` for Java).
 */
import type { ReplContext } from '../../context';
import { addConstraint, listConstraints } from '../../session-constraints';

export async function toolPinSessionConstraint(input: any, ctx: ReplContext): Promise<string> {
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (!text) {
    return JSON.stringify({
      error: 'text required (canonical imperative form of the rule)',
    });
  }
  const verifyCommandRaw = input?.verifyCommand;
  const verifyCommand = typeof verifyCommandRaw === 'string' && verifyCommandRaw.trim().length > 0
    ? verifyCommandRaw.trim()
    : null;
  // Reject obviously non-string verifyCommand types (number, bool, object)
  // — but `undefined` and missing key are fine: not all rules are
  // mechanically verifiable.
  if (verifyCommandRaw !== undefined && verifyCommandRaw !== null && typeof verifyCommandRaw !== 'string') {
    return JSON.stringify({
      error: 'verifyCommand must be a shell command string when present',
    });
  }
  const before = listConstraints(ctx);
  const wasNew = !before.some((c) => c.text === text);
  addConstraint(ctx, text, verifyCommand);
  return JSON.stringify({
    ok: true,
    pinned: { text, verifyCommand },
    new: wasNew,
    total: listConstraints(ctx).length,
  });
}

export const SESSION_CONSTRAINT_TOOL_HANDLERS = [
  { name: 'pin_session_constraint', handler: toolPinSessionConstraint },
];
