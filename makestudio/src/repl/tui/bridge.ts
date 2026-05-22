import { swallow } from '../../utils/log';
/**
 * TUI Bridge — singleton that connects non-React code (router, chat, tools)
 * to the React/Ink state in App.tsx.
 *
 * Non-React code calls tuiBridge.addMessage(...), tuiBridge.setBusy(...), etc.
 * App.tsx wires these into its React state via `installTuiBridge`.
 *
 * This is the only global mutable state in the TUI layer.
 */

import { TuiMessage } from './types';
import { ReplContext } from '../context';

export interface TuiBridge {
  addMessage: (m: Omit<TuiMessage, 'id' | 'timestamp'>) => string;
  updateMessage: (id: string, patch: Partial<TuiMessage>) => void;
  setBusy: (busy: boolean, label?: string) => void;
  clearMessages: () => void;
  getCtx: () => ReplContext;
}

let bridge: TuiBridge | null = null;

// Pending AskUserQuestion — FIFO queue (was a single slot). Multiple
// concurrent tools could overwrite each other's resolve callback,
// stranding the earlier tool's promise unresolved. Same antipattern as
// pendingPermission below — fixed identically. Renderer reads head;
// consumePendingAnswer shifts the head forward.
type PendingQuestion = {
  resolve: (answer: string) => void;
  placeholder?: string;
};
const pendingQuestionQueue: PendingQuestion[] = [];

export function installTuiBridge(b: TuiBridge): void {
  // Wrap addMessage to also fire remote-control hooks
  const originalAddMessage = b.addMessage;
  b.addMessage = (m) => {
    const text = typeof m.text === 'string' ? m.text : '';
    if (text) notifyMessageHooks(m.role || 'info', text);
    return originalAddMessage(m);
  };
  bridge = b;
}

export function uninstallTuiBridge(current?: TuiBridge): void {
  // Only clear if we're the latest bridge — guards against an older
  // instance's cleanup nulling out the new bridge after remount.
  if (!current || bridge === current) bridge = null;
}

export function getTuiBridge(): TuiBridge | null {
  return bridge;
}

type QuestionListener = () => void;
const questionListeners: Set<QuestionListener> = new Set();
export function onPendingQuestionChange(fn: QuestionListener): () => void {
  questionListeners.add(fn);
  return () => questionListeners.delete(fn);
}
function notifyQuestionChange(): void {
  for (const fn of questionListeners) {
    try { fn(); } catch (err) { swallow(err); }
  }
}

export function setPendingQuestion(q: { resolve: (answer: string) => void; placeholder?: string } | null): void {
  if (q === null) {
    // Legacy "clear current" semantics — drop the head if any. The whole
    // queue is preserved otherwise.
    pendingQuestionQueue.shift();
  } else {
    pendingQuestionQueue.push(q);
  }
  notifyQuestionChange();
}
export function getPendingQuestion(): PendingQuestion | null {
  return pendingQuestionQueue[0] ?? null;
}
export function consumePendingAnswer(answer: string): boolean {
  const head = pendingQuestionQueue.shift();
  if (!head) return false;
  notifyQuestionChange();
  head.resolve(answer);
  return true;
}

// ── Pending fuzzy picker (Fase 3.3) ──────────────────────────────────────
// When set, App.tsx renders <FuzzyPicker> instead of the normal input box.
// Used by /sessions, /resume, @file autocomplete etc. Only one picker
// active at a time — serialise callers if you need to chain.

export interface PickerItem {
  /** Primary text shown in the list and used for matching. */
  label: string;
  /** Optional dim line below the label (e.g. path, timestamp). */
  detail?: string;
  /** Opaque payload returned to the caller when the item is selected. */
  value: unknown;
}

// FIFO queue (was a single slot). Same overwrite-resolve antipattern as
// pendingPermission / pendingQuestion: two callers showing pickers in
// quick succession would clobber the earlier resolve, hanging the first
// caller's promise. Renderer reads the head; consumePickerResult shifts.
type PendingPicker = {
  items: PickerItem[];
  title: string;
  placeholder: string;
  resolve: (value: unknown | null) => void;
};
const pendingPickerQueue: PendingPicker[] = [];

// Subscribers fire synchronously whenever pendingPicker changes. App.tsx
// uses this to update React state immediately instead of waiting for the
// 500ms poll — otherwise a rapid picker→askTuiOrReadline sequence paints
// both UIs on top of each other (observed in Fase 3.3 first test).
type PickerListener = () => void;
const pickerListeners: Set<PickerListener> = new Set();
export function onPendingPickerChange(fn: PickerListener): () => void {
  pickerListeners.add(fn);
  return () => pickerListeners.delete(fn);
}

// ── Usage dashboard open/closed ─────────────────────────────────────────
// /usage flips this on; the view's own ESC handler flips it off. Same
// publish/subscribe pattern as pendingPicker so App.tsx reacts instantly
// instead of waiting for the 500ms stats poll.
let usageOpen = false;
const usageListeners: Set<() => void> = new Set();
export function getUsageOpen(): boolean { return usageOpen; }
export function setUsageOpen(v: boolean): void {
  if (usageOpen === v) return;
  usageOpen = v;
  for (const fn of usageListeners) { try { fn(); } catch (err) { swallow(err); } }
}
export function onUsageOpenChange(fn: () => void): () => void {
  usageListeners.add(fn);
  return () => usageListeners.delete(fn);
}

// ── Matrix easter-egg overlay ────────────────────────────────────────────
let matrixOpen = false;
const matrixListeners: Set<() => void> = new Set();
export function getMatrixOpen(): boolean { return matrixOpen; }
export function setMatrixOpen(v: boolean): void {
  if (matrixOpen === v) return;
  matrixOpen = v;
  for (const fn of matrixListeners) { try { fn(); } catch (err) { swallow(err); } }
}
export function onMatrixOpenChange(fn: () => void): () => void {
  matrixListeners.add(fn);
  return () => matrixListeners.delete(fn);
}

// ── Fire easter-egg overlay ──────────────────────────────────────────────
let fireOpen = false;
const fireListeners: Set<() => void> = new Set();
export function getFireOpen(): boolean { return fireOpen; }
export function setFireOpen(v: boolean): void {
  if (fireOpen === v) return;
  fireOpen = v;
  for (const fn of fireListeners) { try { fn(); } catch (err) { swallow(err); } }
}
export function onFireOpenChange(fn: () => void): () => void {
  fireListeners.add(fn);
  return () => fireListeners.delete(fn);
}

// ── Fireworks easter-egg overlay ─────────────────────────────────────────
let fireworksOpen = false;
const fireworksListeners: Set<() => void> = new Set();
export function getFireworksOpen(): boolean { return fireworksOpen; }
export function setFireworksOpen(v: boolean): void {
  if (fireworksOpen === v) return;
  fireworksOpen = v;
  for (const fn of fireworksListeners) { try { fn(); } catch (err) { swallow(err); } }
}
export function onFireworksOpenChange(fn: () => void): () => void {
  fireworksListeners.add(fn);
  return () => fireworksListeners.delete(fn);
}
function notifyPickerChange(): void {
  for (const fn of pickerListeners) {
    try { fn(); } catch (err) { swallow(err); }
  }
}

// ── Plan mode state (advanced-tools EnterPlanMode/ExitPlanMode) ────────
// Snapshot publicado pra UI saber se um banner de plan-mode deve aparecer.
// Atualizado direto pelos impls de enterPlanModeImpl/exitPlanModeImpl
// após a transição de `ctx.permissionMode`.
export interface PlanModeState {
  active: boolean;
  planFilePath?: string;
}
let planModeState: PlanModeState = { active: false };
const planModeListeners: Set<() => void> = new Set();
function notifyPlanModeChange(): void {
  for (const fn of planModeListeners) { try { fn(); } catch (err) { swallow(err); } }
}
export function getPlanModeState(): PlanModeState { return planModeState; }
export function setPlanModeState(s: PlanModeState | null): void {
  const next: PlanModeState = s ?? { active: false };
  // Diff superficial — evita re-emit em chamadas redundantes.
  if (
    planModeState.active === next.active &&
    planModeState.planFilePath === next.planFilePath
  ) return;
  planModeState = next;
  notifyPlanModeChange();
}
export function onPlanModeChange(fn: () => void): () => void {
  planModeListeners.add(fn);
  return () => planModeListeners.delete(fn);
}

// ── Worktree state (advanced-tools EnterWorktree/ExitWorktree) ─────────
export interface WorktreeStateSnapshot {
  active: boolean;
  branch?: string;
  path?: string;
  originalCwd?: string;
}
let worktreeStateSnapshot: WorktreeStateSnapshot = { active: false };
const worktreeListeners: Set<() => void> = new Set();
function notifyWorktreeChange(): void {
  for (const fn of worktreeListeners) { try { fn(); } catch (err) { swallow(err); } }
}
export function getWorktreeState(): WorktreeStateSnapshot { return worktreeStateSnapshot; }
export function setWorktreeState(s: WorktreeStateSnapshot | null): void {
  const next: WorktreeStateSnapshot = s ?? { active: false };
  if (
    worktreeStateSnapshot.active === next.active &&
    worktreeStateSnapshot.branch === next.branch &&
    worktreeStateSnapshot.path === next.path &&
    worktreeStateSnapshot.originalCwd === next.originalCwd
  ) return;
  worktreeStateSnapshot = next;
  notifyWorktreeChange();
}
export function onWorktreeChange(fn: () => void): () => void {
  worktreeListeners.add(fn);
  return () => worktreeListeners.delete(fn);
}

// ── Transient toasts ───────────────────────────────────────────────────
// For ephemeral status notices (snipCompact trimmed, memory saved, etc.)
// that shouldn't clutter the permanent message list. Shown above the
// InputBox and auto-removed after ttlMs. Same publish/subscribe pattern.
export interface Toast { id: string; text: string; expiresAt: number; kind: 'info' | 'warn' | 'error' }
const toasts: Toast[] = [];
const toastListeners: Set<() => void> = new Set();
let nextToastId = 1;
function notifyToasts(): void {
  for (const fn of toastListeners) { try { fn(); } catch (err) { swallow(err); } }
}
export function onToastsChange(fn: () => void): () => void {
  toastListeners.add(fn);
  return () => toastListeners.delete(fn);
}
export function getToasts(): Toast[] {
  const now = Date.now();
  // Lazy prune — consumers always get a fresh, non-expired snapshot.
  for (let i = toasts.length - 1; i >= 0; i--) {
    if (toasts[i].expiresAt <= now) toasts.splice(i, 1);
  }
  return toasts.slice();
}
export function showToast(text: string, opts: { ttlMs?: number; kind?: Toast['kind'] } = {}): string {
  const id = `toast-${nextToastId++}`;
  const ttl = opts.ttlMs ?? 5000;
  toasts.push({ id, text, expiresAt: Date.now() + ttl, kind: opts.kind || 'info' });
  notifyToasts();
  const t = setTimeout(() => {
    const idx = toasts.findIndex((x) => x.id === id);
    if (idx >= 0) { toasts.splice(idx, 1); notifyToasts(); }
  }, ttl);
  t.unref?.();
  return id;
}

export function setPendingPicker(p: PendingPicker | null): void {
  if (p === null) {
    pendingPickerQueue.shift();
  } else {
    pendingPickerQueue.push(p);
  }
  notifyPickerChange();
}
export function getPendingPicker(): PendingPicker | null {
  return pendingPickerQueue[0] ?? null;
}
export function consumePickerResult(value: unknown | null): void {
  const head = pendingPickerQueue.shift();
  if (!head) return;
  notifyPickerChange();
  head.resolve(value);
}

// ── Pending permission prompt (Fase 3.1) ─────────────────────────────────
// Rich Ink-based replacement for the readline detach flow when a tool
// needs interactive approval. Resolves with one of:
//   'allow'          → allow this ONE call only
//   'allow-session'  → allow this tool for the rest of the session (in-memory)
//   'allow-rule'     → write a permission rule to disk so future sessions are covered
//   'deny'           → deny this call (tool returns an error result to the LLM)
//   null             → user pressed Esc (treated as deny)

export type PermissionChoice = 'allow' | 'allow-session' | 'allow-rule' | 'deny' | null;

export interface PermissionPromptSpec {
  toolName: string;
  toolInput: any;
  /** What the policy decided — the reason we're asking the user. */
  reason: string;
  /** Preview summary for the UI (Bash command, file path, URL). */
  preview: string;
  /** Diff preview string (for Edit/Write/MultiEdit). */
  diff?: string;
  /** Non-blocking risk advisory from getDestructiveCommandWarning (e.g.
   *  "may discard uncommitted changes"). Shown prominently in the prompt. */
  warning?: string;
  resolve: (v: PermissionChoice) => void;
}

// FIFO queue, NOT a single slot. When the model emits N parallel tools
// that all need approval (concurrency-safe batch in chat.ts → Promise.all),
// they all call showPermissionPrompt simultaneously. The previous
// implementation overwrote the active prompt with each new call — every
// resolve callback EXCEPT the last was lost forever, so the corresponding
// dispatchStreamingTool promise never settled and Promise.all hung
// indefinitely. Now: queue them, surface one at a time. After consume,
// we promote the next pending entry. Renderer only needs to know about
// the head of the queue.
const pendingPermissionQueue: PermissionPromptSpec[] = [];
type PermListener = () => void;
const permListeners: Set<PermListener> = new Set();
export function onPendingPermissionChange(fn: PermListener): () => void {
  permListeners.add(fn);
  return () => permListeners.delete(fn);
}
function notifyPermissionChange(): void {
  for (const fn of permListeners) { try { fn(); } catch (err) { swallow(err); } }
}
export function getPendingPermission(): PermissionPromptSpec | null {
  return pendingPermissionQueue[0] ?? null;
}
export function consumePermissionResult(choice: PermissionChoice): void {
  const head = pendingPermissionQueue.shift();
  if (!head) return;
  // Notify so the renderer sees the next pending entry (or empty queue).
  notifyPermissionChange();
  head.resolve(choice);
}

export function showPermissionPrompt(spec: Omit<PermissionPromptSpec, 'resolve'>): Promise<PermissionChoice> {
  return new Promise<PermissionChoice>((resolve) => {
    pendingPermissionQueue.push({ ...spec, resolve });
    notifyPermissionChange();
  });
}

/**
 * Promise-based helper. Renders a fuzzy picker over the REPL's input
 * area; resolves with the selected item's `value`, or null on Esc.
 * Caller's code resumes after selection exactly like askTuiOrReadline.
 */
export function showFuzzyPicker<T = unknown>(opts: {
  items: Array<T | PickerItem>;
  getLabel?: (item: T) => string;
  getDetail?: (item: T) => string | undefined;
  title?: string;
  placeholder?: string;
}): Promise<T | null> {
  const getLabel = opts.getLabel || ((i: any) => String(i?.label ?? i));
  const getDetail = opts.getDetail || ((i: any) => i?.detail as string | undefined);
  const items: PickerItem[] = opts.items.map((raw: any) => ({
    label: getLabel(raw),
    detail: getDetail(raw),
    value: raw,
  }));
  return new Promise((resolve) => {
    pendingPickerQueue.push({
      items,
      title: opts.title || 'Select',
      placeholder: opts.placeholder || 'Type to filter, ↑/↓ to navigate, Enter to select, Esc to cancel',
      resolve: (v) => resolve(v as T | null),
    });
    notifyPickerChange();
  });
}

// ── Pending prompt suggestion (PromptSuggestion port) ─────────────────────
// After each assistant turn, the suggestion service stores a single-line
// prediction of the user's next prompt here. InputBox's Tab handler
// consumes it when the input is empty.

let pendingSuggestion: string | null = null;
const pendingSuggestionListeners: Set<(s: string | null) => void> = new Set();

export function setPendingSuggestion(s: string | null): void {
  pendingSuggestion = s;
  for (const fn of pendingSuggestionListeners) { try { fn(s); } catch (err) { swallow(err); } }
}
export function getPendingSuggestion(): string | null {
  return pendingSuggestion;
}
export function onPendingSuggestionChange(fn: (s: string | null) => void): () => void {
  pendingSuggestionListeners.add(fn);
  return () => pendingSuggestionListeners.delete(fn);
}
/** Consume the pending suggestion (null it out) and return what it was. */
export function consumePendingSuggestion(): string | null {
  const s = pendingSuggestion;
  pendingSuggestion = null;
  return s;
}

// ── Pasted text store ─────────────────────────────────────────────────────
// Large multi-line pastes are stored here with an ID. The input box shows a
// compact marker "[Pasted text #N +M lines]" instead of all the raw lines.
// handleSubmit in App.tsx expands the markers before sending to the AI.

const pastedTexts = new Map<number, string>();
let pasteCounter = 0;

export function storePastedText(text: string): { id: number; lines: number } {
  const id = ++pasteCounter;
  pastedTexts.set(id, text);
  return { id, lines: text.split('\n').length };
}

export function expandPasteMarkers(value: string): string {
  return value.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (_match, idStr) => {
    const id = Number(idStr);
    return pastedTexts.get(id) ?? _match;
  });
}

// ── Agent summary (AgentSummary port) ─────────────────────────────────────
// While the agent is busy, the summarization loop writes a 3-5 word
// present-continuous action here. Statusline reads it and displays.

let agentSummaryText: string | null = null;
const agentSummaryListeners: Set<(s: string | null) => void> = new Set();
export function setAgentSummary(s: string | null): void {
  agentSummaryText = s;
  for (const fn of agentSummaryListeners) { try { fn(s); } catch (err) { swallow(err); } }
}
export function getAgentSummary(): string | null {
  return agentSummaryText;
}
export function onAgentSummaryChange(fn: (s: string | null) => void): () => void {
  agentSummaryListeners.add(fn);
  return () => agentSummaryListeners.delete(fn);
}

// ── Stream token counter (StatusLine port) ────────────────────────────────
// Incremental estimate of output tokens while the provider streams. Updated
// on every text_delta from chat.ts via setStreamTokens(). The StatusLine
// reads this via a 500ms poll (App's statsTick) and displays it next to the
// elapsed timer. Resets to 0 on turn start / turn end.

let streamTokens = 0;
const streamTokensListeners: Set<(n: number) => void> = new Set();
export function setStreamTokens(n: number): void {
  streamTokens = n > 0 ? n : 0;
  for (const fn of streamTokensListeners) { try { fn(streamTokens); } catch (err) { swallow(err); } }
}
export function getStreamTokens(): number {
  return streamTokens;
}
export function onStreamTokensChange(fn: (n: number) => void): () => void {
  streamTokensListeners.add(fn);
  return () => streamTokensListeners.delete(fn);
}

// ── Current tool indicator (status line) ──────────────────────────────────
// currentTool: set before execution, cleared after — "live" while tool runs.
// lastTool: persists after each call so the status line stays informative
// between tool calls and during LLM streaming. Reset only on turn start.

let currentTool: string | null = null;
let lastTool: string | null = null;
const currentToolListeners: Set<(state: { current: string | null; last: string | null }) => void> = new Set();
function fireCurrentToolListeners(): void {
  const snapshot = { current: currentTool, last: lastTool };
  for (const fn of currentToolListeners) { try { fn(snapshot); } catch (err) { swallow(err); } }
}

export function setCurrentTool(name: string | null): void {
  currentTool = name;
  if (name !== null) lastTool = name;
  fireCurrentToolListeners();
}
export function getCurrentTool(): string | null {
  return currentTool;
}
export function getLastTool(): string | null {
  return lastTool;
}
export function resetLastTool(): void {
  lastTool = null;
  currentTool = null;
  fireCurrentToolListeners();
}
export function onCurrentToolChange(
  fn: (state: { current: string | null; last: string | null }) => void,
): () => void {
  currentToolListeners.add(fn);
  return () => currentToolListeners.delete(fn);
}

// ── Transient status line message ─────────────────────────────────────────
// Short, low-intrusion note shown on the StatusLine for a few seconds —
// e.g. "microCompact freed 97k chars" or "auto-sync: pulled 3 topics from
// m-abc". Replaces a toast for housekeeping events that shouldn't pop up
// over the conversation.
//
// Semantics:
//   - Only one transient at a time; a newer one supersedes the previous.
//   - Auto-expires after ttlMs (default 4s). Timer is unref'd so it never
//     holds the process open.
//   - getTransientStatus returns null when expired; subscribers are
//     notified on set and on expiry.

interface TransientStatus { text: string; expiresAt: number; }
let transientStatus: TransientStatus | null = null;
let transientTimer: NodeJS.Timeout | null = null;
const transientSubs = new Set<() => void>();

function notifyTransient(): void { for (const fn of transientSubs) try { fn(); } catch (err) { swallow(err); } }

export function setTransientStatus(text: string, ttlMs: number = 4000): void {
  transientStatus = { text, expiresAt: Date.now() + ttlMs };
  if (transientTimer) clearTimeout(transientTimer);
  transientTimer = setTimeout(() => {
    transientStatus = null;
    transientTimer = null;
    notifyTransient();
  }, ttlMs);
  transientTimer.unref?.();
  notifyTransient();
}

export function getTransientStatus(): string | null {
  if (!transientStatus) return null;
  if (Date.now() >= transientStatus.expiresAt) {
    transientStatus = null;
    return null;
  }
  return transientStatus.text;
}

export function subscribeTransientStatus(fn: () => void): () => void {
  transientSubs.add(fn);
  return () => { transientSubs.delete(fn); };
}

// ── Message broadcast hooks (for remote-control) ──────────────────────
// Subscribe to all messages flowing through the bridge so remote-control
// can broadcast them to connected browsers without coupling to React.
type MessageHook = (role: string, text: string, extra?: Record<string, unknown>) => void;
const messageHooks = new Set<MessageHook>();

export function onMessage(fn: MessageHook): () => void {
  messageHooks.add(fn);
  return () => messageHooks.delete(fn);
}

function notifyMessageHooks(role: string, text: string, extra?: Record<string, unknown>): void {
  for (const fn of messageHooks) {
    try { fn(role, text, extra); } catch (err) { swallow(err); }
  }
}

/** Convenience helpers for non-React code. No-op when bridge not installed. */
export function tuiLog(text: string, role: TuiMessage['role'] = 'info'): string | null {
  notifyMessageHooks(role, text);
  if (!bridge) { console.log(text); return null; }
  return bridge.addMessage({ role, text });
}

export function tuiToolCall(name: string, input: any, output: string = '', durationMs?: number): string | null {
  const outputText = output.slice(0, 200); // truncate for broadcast
  notifyMessageHooks('tool', `[tool] ${name}`, { toolName: name, toolInput: input, toolOutput: outputText });
  if (!bridge) return null;
  return bridge.addMessage({
    role: 'tool',
    text: '',
    toolName: name,
    toolInput: input,
    toolOutput: output,
    toolDurationMs: durationMs,
  });
}

/**
 * Add a streaming tool message to the live area. Returns the message ID so
 * the caller can patch it with tuiUpdateMessage() as output arrives.
 * Finalized by patching `streaming: false` and `toolDurationMs`.
 */
export function tuiStartStreamingTool(name: string, input: any): string | null {
  notifyMessageHooks('tool', `[tool:start] ${name}`, { toolName: name, toolInput: input, streaming: true });
  if (!bridge) return null;
  return bridge.addMessage({
    role: 'tool',
    text: '',
    streaming: true,
    toolName: name,
    toolInput: input,
    startedAt: Date.now(),
    liveLines: [],
    totalLiveLines: 0,
  });
}

export function tuiUpdateMessage(id: string, patch: Partial<TuiMessage>): void {
  if (!bridge) return;
  // Notify remote hooks of text updates (streaming deltas, final output)
  if (patch.text && typeof patch.text === 'string' && patch.text.length > 0) {
    notifyMessageHooks(patch.role || 'assistant', patch.text);
  }
  bridge.updateMessage(id, patch);
}

export function tuiSetBusy(busy: boolean, label?: string): void {
  if (!bridge) return;
  bridge.setBusy(busy, label);
}

/**
 * Ask the user for a single line of input.
 *
 * In the TUI, hijacking stdin with a fresh readline.createInterface while Ink
 * owns stdin in raw mode causes Ink to unmount (stdin 'end' event → goodbye).
 * So when the bridge is installed we route through pendingQuestion instead;
 * otherwise fall back to plain readline (non-TUI path, or tests).
 */
// ── Debug counters (consumed by debug-log.captureMemSnapshot) ─────────────
// Surfaces the size of every Set/Map in this module so leak hunts can plot
// each counter against tool-call sequence and see which one climbs.
export function __debugCounts(): Record<string, number> {
  let pastedBytes = 0;
  for (const v of pastedTexts.values()) pastedBytes += Buffer.byteLength(v, 'utf8');
  return {
    messageHooks: messageHooks.size,
    pickerListeners: pickerListeners.size,
    toastListeners: toastListeners.size,
    permListeners: permListeners.size,
    usageListeners: usageListeners.size,
    transientSubs: transientSubs.size,
    pastedTextsCount: pastedTexts.size,
    pastedTextsBytes: pastedBytes,
  };
}

export async function askTuiOrReadline(promptLabel: string): Promise<string> {
  if (bridge) {
    bridge.addMessage({ role: 'info', text: `→ ${promptLabel}` });
    return await new Promise<string>((resolve) => {
      pendingQuestionQueue.push({ resolve, placeholder: promptLabel });
      notifyQuestionChange();
    });
  }
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(`  ${promptLabel}: `, (a: string) => resolve((a || '').trim())));
  } finally {
    rl.close();
  }
}
