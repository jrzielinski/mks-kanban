/**
 * tips.ts
 *
 * Port of Claude Code's services/tips/ (tipHistory + tipScheduler +
 * tipRegistry). We keep the same rotation algorithm — pick the tip with
 * the longest gap since last shown — but skip their 686-line registry
 * of IDE/plugin/marketplace detection and ship a curated list of
 * MakeStudio-specific hints instead.
 *
 * Usage: call `bumpStartupAndPickTip()` once during boot. It increments
 * the startup counter, picks a tip, records it as shown, and returns the
 * text for display. `null` means tips are disabled OR the rotation has
 * chosen not to show anything this session.
 */

import { loadSettings, saveSettings } from './settings';

export interface Tip {
  id: string;
  /** One-line hint (<= 90 chars to fit under the banner). */
  text: string;
  /** Minimum startups between repeats. Default = TIPS.length so we cycle through everything before repeating. */
  cooldownSessions?: number;
}

// Curated list — tied to features we actually ported this session so users
// discover them without having to grep /help. Keep each hint < 90 chars.
export const TIPS: Tip[] = [
  { id: 'fork',         text: 'Try /fork to explore a risky refactor — your current conversation stays intact.' },
  { id: 'plan-mode',    text: 'Non-trivial task? Ask the assistant to use EnterPlanMode before writing code.' },
  { id: 'at-ref',       text: 'Type @src/foo.ts in any message — the agent will Read it when relevant.' },
  { id: 'theme',        text: 'Try /theme monokai for a different vibe. /restart applies changes.' },
  { id: 'continue',     text: 'makestudio -c resumes your most recent session in this directory.' },
  { id: 'sessions',     text: '/sessions lists every session in this cwd — including forks.' },
  { id: 'bang',         text: '!gh pr list runs any shell command inline without leaving the REPL.' },
  { id: 'double-esc',   text: 'Double-tap Esc to cancel an in-flight turn without killing the REPL.' },
  { id: 'ctrl-r',       text: 'Ctrl+R searches your prompt history Emacs-style.' },
  { id: 'clear',        text: '/clear wipes context + scroll — use when the conversation drifts.' },
  { id: 'vim',          text: '/vim toggles vim keybindings in the input box (NORMAL/INSERT modes).' },
  { id: 'effort',       text: '/effort max tells the assistant to be exhaustive; /effort low to stay terse.' },
  { id: 'cost',         text: '/cost shows tokens spent this session + cache hit rate.' },
  { id: 'ctx',          text: '/ctx shows how full the context window is — compact early.' },
  { id: 'worktree',     text: 'Ask the agent to EnterWorktree for risky edits quarantined on a branch.' },
  { id: 'memory',       text: 'Key preferences? Tell me — I save them to auto-memory and honour them later.' },
  { id: 'security',     text: '/security-review audits the current git diff for vulnerabilities.' },
  { id: 'pr',           text: '/pr opens a GitHub PR from the current branch with summary auto-drafted.' },
  { id: 'output-style', text: '/output-style terse | verbose | explain | code-only shapes response style.' },
  { id: 'statusline',   text: '/statusline lets you pick which fields appear in the bottom bar.' },
  { id: 'keybindings',  text: '/keybindings lets you remap history/tab/cancel keys.' },
  { id: 'disable-tips', text: 'To hide these: set tipsDisabled in ~/.makestudio/settings.json.' },
];

/**
 * Picks the tip whose "sessions since last shown" is largest.
 * Ties broken by array order. Exported for testing.
 */
export function selectLongestGapTip(
  tips: Tip[],
  history: Record<string, number>,
  currentStartup: number,
): Tip | null {
  if (tips.length === 0) return null;
  let best: { tip: Tip; gap: number } | null = null;
  for (const t of tips) {
    const last = history[t.id];
    const gap = last === undefined ? Infinity : currentStartup - last;
    // Respect cooldown — a tip shown too recently is ineligible.
    const cooldown = t.cooldownSessions ?? tips.length;
    if (gap < cooldown && last !== undefined) continue;
    if (!best || gap > best.gap) best = { tip: t, gap };
  }
  return best?.tip ?? null;
}

/**
 * Call once per REPL boot. Increments numStartups, picks a tip, records it
 * in history, and returns the text to display. Returns null when tips are
 * disabled OR every tip is currently on cooldown.
 */
export function bumpStartupAndPickTip(): string | null {
  const s = loadSettings();
  if (s.tipsDisabled) {
    // Still bump so cooldown math keeps moving.
    saveSettings({ numStartups: (s.numStartups || 0) + 1 });
    return null;
  }
  const nextStartup = (s.numStartups || 0) + 1;
  const tip = selectLongestGapTip(TIPS, s.tipsHistory || {}, nextStartup);
  const newHistory = { ...(s.tipsHistory || {}) };
  if (tip) newHistory[tip.id] = nextStartup;
  saveSettings({ numStartups: nextStartup, tipsHistory: newHistory });
  return tip ? tip.text : null;
}
