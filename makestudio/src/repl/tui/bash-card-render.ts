/**
 * bash-card-render.ts — pure render helpers for BashLiveCard (MessageList.tsx).
 *
 * Lives in its own .ts file because the Jest config only resolves .ts
 * (not .tsx) for spec imports — extracting here keeps the dup-guard
 * logic unit-testable without taking a dependency on ink-testing-library.
 */

/**
 * Decide whether the bash card should render output rows under its header.
 *
 * Contract: while streaming, output is suppressed (returns null) so Ink's
 * dynamic area stays at 1 row per bash card. When streaming finishes,
 * <Static> prints the full card with the tail. This is the only way to
 * prevent Ink from leaking the streamed rows into scrollback AND ALSO
 * printing the same card via <Static> on finalize — i.e. the "$ ls -la …"
 * twice bug.
 */
export function bashCardOutputRows(args: {
  isStreaming: boolean;
  liveLines: string[] | undefined;
  totalLiveLines: number | undefined;
}): { lines: string[]; moreCount: number } | null {
  if (args.isStreaming) return null;
  const lines = args.liveLines || [];
  const total = args.totalLiveLines ?? lines.length;
  return { lines, moreCount: Math.max(0, total - lines.length) };
}
