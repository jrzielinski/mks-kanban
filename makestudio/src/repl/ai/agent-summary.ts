import { swallow } from '../../utils/log';
/**
 * agent-summary.ts
 *
 * Port of Claude Code's services/AgentSummary/agentSummary.ts. While the
 * agent is working (busy=true), every SUMMARY_INTERVAL_MS fires a cheap
 * LLM call that returns a 3-5 word present-continuous description of
 * what the agent is doing right now ("Reading runAgent.ts", "Fixing null
 * check in validate.ts"). The text is surfaced on a bridge slot so the
 * statusline can display it.
 *
 * buildSummaryPrompt() is VERBATIM from claude-code/services/AgentSummary/agentSummary.ts:28.
 * Everything else is adapted to our runtime (no forkedAgent, no TaskContext
 * — we reuse the main provider and store state on a WeakMap).
 */

import { ReplContext } from '../context';
import { getProvider } from './providers';

export const SUMMARY_INTERVAL_MS = 30_000;

// Verbatim from Claude Code buildSummaryPrompt — do not edit the wording.
export function buildSummaryPrompt(previousSummary: string | null): string {
  const prevLine = previousSummary
    ? `\nPrevious: "${previousSummary}" — say something NEW.\n`
    : '';

  return `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.
${prevLine}
Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`;
}

interface SummarizationHandle {
  stop: () => void;
  isRunning: () => boolean;
}

const activeByCtx: WeakMap<ReplContext, SummarizationHandle> = new WeakMap();

/** Rudimentary sanitizer — strip quotes, clamp word count, reject past-tense markers. */
export function sanitizeSummary(raw: string): string | null {
  if (!raw) return null;
  const t = raw.trim()
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .split('\n')[0]!
    .trim();
  if (!t) return null;
  // Claude Code's rules: 3-5 words, present continuous (-ing), no branch slashes.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 12) return null;
  // Reject obvious past-tense patterns ("Analyzed", "Reviewed", "Fixed …").
  if (/^(?:Analyzed|Reviewed|Fixed|Added|Created|Checked|Investigated|Explored)\b/i.test(t)) return null;
  // Reject strings that look like branch names (slash between tokens)
  if (/[A-Za-z0-9_]+\/[A-Za-z0-9_-]+/.test(t)) return null;
  return t;
}

async function runOnce(ctx: ReplContext, previous: string | null, signal: AbortSignal): Promise<string | null> {
  if (ctx.messages.length < 2) return null; // nothing meaningful yet
  const provider = getProvider(ctx.provider);
  if (!provider.sendMessage) return null;
  try {
    const messages = ctx.messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: buildSummaryPrompt(previous) });
    const params = {
      system: 'You are generating a 3-5 word status line describing the agent\'s current action.',
      messages,
      tools: [],
      effort: 'low' as const,
      signal,
    };
    // Route to the auxiliary provider if configured (role=fast). This
    // fires ~every 30s while the agent is busy, so the savings compound.
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
      .join('');
    return sanitizeSummary(raw);
  } catch { return null; }
}

/**
 * Start periodic summarisation for `ctx`. Returns a handle so the caller
 * can stop it. Calling start() twice on the same ctx is a no-op — the
 * existing handle is returned.
 */
export function startAgentSummarization(ctx: ReplContext): SummarizationHandle {
  const existing = activeByCtx.get(ctx);
  if (existing && existing.isRunning()) return existing;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let previousSummary: string | null = null;
  let currentAbort: AbortController | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, SUMMARY_INTERVAL_MS);
    // Background summarization shouldn't keep the process alive after
    // Ink unmounts — .unref() lets Node exit on explicit /quit even
    // when the next tick is scheduled further out.
    timer?.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    currentAbort = new AbortController();
    try {
      const s = await runOnce(ctx, previousSummary, currentAbort.signal);
      if (stopped) return;
      if (s) {
        previousSummary = s;
        // Push to bridge for statusline consumption.
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const b = require('../tui/bridge');
          b.setAgentSummary?.(s);
        } catch (err) { swallow(err); }
      }
    } finally {
      currentAbort = null;
      scheduleNext();
    }
  };

  const handle: SummarizationHandle = {
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (currentAbort) { currentAbort.abort(); currentAbort = null; }
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../tui/bridge').setAgentSummary?.(null);
      } catch (err) { swallow(err); }
    },
    isRunning: () => !stopped,
  };

  activeByCtx.set(ctx, handle);
  scheduleNext();
  return handle;
}

/** Stop any active summarisation for `ctx`. Safe to call repeatedly. */
export function stopAgentSummarization(ctx: ReplContext): void {
  activeByCtx.get(ctx)?.stop();
  activeByCtx.delete(ctx);
}
