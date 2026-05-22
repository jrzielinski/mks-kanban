/**
 * session-constraints.ts
 *
 * Light-weight per-session constraint registry. The user occasionally
 * states a hard rule that must hold for the rest of the conversation —
 * "I want unit tests for everything you change", "verify with tsc and
 * zero errors", "do not commit without permission", "cargo check must
 * pass before declaring done", "pytest passes 100%". The model tends
 * to forget these mid-flight when the work grows long, then declares
 * done having quietly skipped them.
 *
 * Pinning is LLM-driven via the `pin_session_constraint` tool — the
 * model recognises a session-wide rule in the user's message and calls
 * the tool with the canonical text PLUS (optionally) a shell command
 * that verifies the rule for THIS PROJECT. There is intentionally NO
 * regex-based natural-language classifier and NO hard-coded list of
 * languages/build-tools/test-runners in this module: the agent must be
 * agnostic to the project's stack. The model knows the project's
 * stack (from CLAUDE.md, file inspection, etc.) and chooses the right
 * verify command — `npx tsc --noEmit`, `cargo check`, `pytest -q`,
 * `mvn test`, `go vet ./...`, whatever fits.
 *
 * Verifier contract: at end-of-turn, run `verifyCommand` if present;
 * exit==0 means PASS, anything else means FAIL. Constraints without a
 * verifyCommand are SKIP (the model self-verifies).
 */
import type { ReplContext } from './context';

export interface PinnedConstraint {
  /** Canonical imperative form, exactly as pinned. */
  text: string;
  /** Optional shell command whose `exit==0` outcome proves the
   *  constraint was met for this turn. The LLM picks it knowing the
   *  project stack — language-agnostic by design. */
  verifyCommand: string | null;
}

/** Per-ctx map: text → verifyCommand (or null when absent). Map
 *  preserves insertion order so prompt rendering is stable. */
const sessionConstraints: WeakMap<ReplContext, Map<string, string | null>> = new WeakMap();

export function addConstraint(
  ctx: ReplContext,
  text: string,
  verifyCommand: string | null = null,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  let map = sessionConstraints.get(ctx);
  if (!map) { map = new Map(); sessionConstraints.set(ctx, map); }
  // Re-pinning the same text with a verifyCommand upgrades the entry
  // — useful when the LLM first pins without one and later figures out
  // how to verify.
  const cmd = typeof verifyCommand === 'string' && verifyCommand.trim().length > 0
    ? verifyCommand.trim()
    : null;
  map.set(trimmed, cmd);
}

export function listConstraints(ctx: ReplContext): PinnedConstraint[] {
  const map = sessionConstraints.get(ctx);
  if (!map) return [];
  return Array.from(map.entries()).map(([text, verifyCommand]) => ({ text, verifyCommand }));
}

export function clearConstraints(ctx: ReplContext): void {
  sessionConstraints.delete(ctx);
}

/**
 * Format constraints for inclusion in a system prompt or info banner.
 * Returns null when the session has no constraints — caller should skip
 * the section entirely instead of emitting an empty header.
 */
export function formatConstraintsForPrompt(ctx: ReplContext): string | null {
  const list = listConstraints(ctx);
  if (list.length === 0) return null;
  const lines = ['## Session-pinned constraints (set by the user — must hold every turn)'];
  for (const c of list) {
    if (c.verifyCommand) {
      lines.push(`- ${c.text}  _(verify: \`${c.verifyCommand}\`)_`);
    } else {
      lines.push(`- ${c.text}`);
    }
  }
  lines.push('');
  lines.push('Before declaring a turn done or summarising your work, verify each constraint above. If any was skipped, say so explicitly.');
  return lines.join('\n');
}
