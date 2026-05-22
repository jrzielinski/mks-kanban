import * as React from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { MessageList } from './MessageList';
import { StatusLine } from './StatusLine';
import { InputBox } from './InputBox';
import { SlashMenu } from './SlashMenu';
import { TuiMessage } from './types';
import { ReplContext } from '../context';
import { loadHistory, appendHistory } from '../history';
import { getTuiBridge, installTuiBridge, uninstallTuiBridge } from './bridge';

interface AppProps {
  ctx: ReplContext;
  onExit: () => void;
}

let nextMsgId = 1;

export function App({ ctx, onExit }: AppProps): React.ReactElement {
  const app = useApp();
  const { stdout } = useStdout();
  // Read terminal dimensions directly from stdout — no state needed.
  // Ink fires scheduleRender() on resize internally, so this re-evaluates
  // automatically with the current value on every resize-triggered render.
  const cols = stdout?.columns || 80;
  const [input, setInputRaw] = React.useState('');
  // Scrubber for focus/bracketed-paste noise that ink-text-input sometimes
  // appends to the buffer (e.g. `[O`, `[I`, `\x1b[O[I[O`). Applied on every
  // state change so that whichever handler wins the race (mine vs. ink-
  // text-input's internal useInput) the noise never persists.
  const setInput = React.useCallback((next: string) => {
    // Strip ANSI/focus event noise.
    // Ink 3 may re-enable focus tracking internally; ESC gets consumed by Ink's
    // key parser leaving bare residues like "[0[I". The lookahead (?![a-zA-Z])
    // ensures "[Image #1]" is NOT stripped — "[I" followed by a letter is kept.
    const cleaned = next
      .replace(/\x1b\[[IO]/g, '')                     // ESC + focus event (with ESC)
      .replace(/\[[\d;]*\[?[IO](?![a-zA-Z])/g, '')   // bare residue: [I, [0[I, [0;0[O etc
      .replace(/\x1b\[[\d;]*[mMRHfABCDsuhl]/g, '');  // other stray ANSI sequences
    setInputRaw(cleaned);
  }, []);
  // Keep setInput reachable via ref so the raw stdin listener below can
  // push into the buffer without going through React's stale-closure trap.
  const setInputRef = React.useRef(setInput);
  setInputRef.current = setInput;
  const inputValueRef = React.useRef(input);
  inputValueRef.current = input;
  // Ref so the raw-stdin listener can bump resetKey (moves cursor to end)
  // without going through stale-closure trap.
  const bumpResetKeyRef = React.useRef(() => {});

  // isPastingRef: true while a paste is being processed (blocks spurious submits).
  const isPastingRef = React.useRef(false);

  // Raw-stdin + keypress listener for paste handling.
  //
  // For multi-line pastes: the text is stored as an attachment and a compact
  // marker "[Pasted text #N +M lines]" is shown in the input box instead of
  // rendering all lines. handleSubmit expands markers before sending to the AI.
  //
  // Detection modes:
  //   a) Bracketed paste (ESC[200~...ESC[201~): terminal wraps paste in markers.
  //      We write ESC[?2004h before Ink mounts (tui-index.tsx) to enable this.
  //   b) Heuristic: data chunk with >2 chars containing \n (no ESC prefix).
  React.useEffect(() => {
    let pasteBuffer = '';
    let inPaste = false;
    let prePasteValue = '';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bridge = require('./bridge');

    const finalizePaste = (pasted: string, base: string) => {
      isPastingRef.current = false;
      (global as any).__makestudio_pasting = false;
      const normalized = pasted.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
      const lineCount = normalized.split('\n').length;
      if (lineCount > 1) {
        // Store full text and show compact marker.
        const { id, lines } = bridge.storePastedText(normalized);
        const marker = `[Pasted text #${id} +${lines} lines]`;
        setInputRef.current(base ? base + marker : marker);
      } else {
        // Single-line paste: insert normally.
        setInputRef.current(base ? base + normalized : normalized);
      }
    };

    // keypress interceptor: runs before Ink's handler, blocks return during paste.
    const keypressInterceptor = (_str: any, key: any) => {
      if (isPastingRef.current && key && key.return) {
        key.return = false;
      }
    };
    try { (process.stdin as any).prependListener('keypress', keypressInterceptor); } catch { /* */ }

    const listener = (chunk: Buffer | string) => {
      const raw = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;

      // ── a) Bracketed paste (ESC[200~ ... ESC[201~) ─────────────────────
      if (inPaste || raw.includes('\x1b[200~')) {
        let s = raw;
        if (!inPaste) {
          s = s.slice(s.indexOf('\x1b[200~') + 6);
          inPaste = true;
          isPastingRef.current = true;
          (global as any).__makestudio_pasting = true;
          prePasteValue = inputValueRef.current;
        }
        const endIdx = s.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          pasteBuffer += s.slice(0, endIdx);
          inPaste = false;
          const pasted = pasteBuffer;
          const base = prePasteValue;
          pasteBuffer = '';
          prePasteValue = '';
          setImmediate(() => finalizePaste(pasted, base));
        } else {
          pasteBuffer += s;
        }
        return;
      }

      // ── b) Heuristic paste: multi-char chunk with newline ───────────────
      if (raw.length > 2 && raw.includes('\n') && !raw.startsWith('\x1b')) {
        isPastingRef.current = true;
        (global as any).__makestudio_pasting = true;
        const base = inputValueRef.current;
        const pasted = raw;
        setImmediate(() => finalizePaste(pasted, base));
        // Don't return — let readline render chars; keypress interceptor blocks \n submits.
      }

      // ── Ctrl+V (0x16) → clipboard image paste ──────────────────────────
      if (raw.includes('\x16')) {
        let attach: any;
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { readClipboardImage } = require('../image-paste');
          const r = readClipboardImage();
          if (r.ok) attach = r.attached;
        } catch { /* */ }
        if (attach) {
          const marker = `[Image #${attach.id}] `;
          setImmediate(() => {
            let cur = inputValueRef.current;
            if (cur.endsWith('v')) cur = cur.slice(0, -1);
            setInputRef.current(cur ? `${cur} ${marker}` : marker);
            // Move cursor to end of inserted marker
            bumpResetKeyRef.current();
          });
        }
      }
    };

    try {
      (process.stdin as any).prependListener('data', listener);
    } catch {
      try { process.stdin.on('data', listener); } catch { /* */ }
    }
    return () => {
      try { process.stdout.write('\x1b[?2004l'); } catch { /* */ }
      try { process.stdin.off('data', listener); } catch { /* */ }
      try { process.stdin.off('keypress', keypressInterceptor); } catch { /* */ }
    };
  }, []);
  // Hydrate from ctx.messages on mount — supports --continue / --resume
  // where the session file was loaded into ctx before the App mounted.
  const [messages, setMessages] = React.useState<TuiMessage[]>(() => {
    // Hydrate from prior session (see tui-index.tsx — --continue / --resume).
    // Each ChatMessage.content can be a string (most providers) or an array
    // of Anthropic content blocks (tool_use/tool_result intermixed). Extract
    // plain text from both shapes; non-text blocks are ignored here since
    // the tool history is reconstructed from the session file separately.
    const contentToText = (content: any): string => {
      if (typeof content === 'string') {
        // appendMessage serializes array content as JSON — try to restore it
        // so image blocks become [Image #N] instead of raw base64 in the terminal.
        if (content.startsWith('[') || content.startsWith('{')) {
          try { return contentToText(JSON.parse(content)); } catch { /* plain string */ }
        }
        return content;
      }
      if (Array.isArray(content)) {
        const parts: string[] = [];
        let imgCount = 0;
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
          else if (b.type === 'image' || b.type === 'image_url') { imgCount++; parts.push(`[Image #${imgCount}]`); }
        }
        return parts.join('\n');
      }
      return content == null ? '' : String(content);
    };
    return ctx.messages.map((m: any, i: number) => {
      // displayText is set by router.ts when a slash-skill expanded into
      // a multi-KB body. Without this, session resume re-prints the entire
      // skill body as a "user message" and the user sees raw markdown for
      // hundreds of lines.
      const text = m.displayText ? String(m.displayText) : contentToText(m.content);
      return {
        id: `h${i}`,
        role: m.role,
        text,
        preRendered: false,
        timestamp: Date.now(),
      } as TuiMessage;
    });
  });
  const [busy, setBusy] = React.useState(false);
  const [busyLabel, setBusyLabel] = React.useState('');
  // Timestamp when `busy` last flipped from false→true. The statsTick poll
  // (below) derives elapsed seconds from this; clearing it while idle stops
  // the counter from growing between turns.
  const busyStartedAtRef = React.useRef<number>(0);
  const [elapsedSec, setElapsedSec] = React.useState(0);
  const [streamTokens, setStreamTokens] = React.useState(0);
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const [completions, setCompletions] = React.useState<string[]>([]);
  // Slash-menu state — list of {name, description, source} that appears as a
  // popup ABOVE the InputBox when input starts with `/`. The user navigates
  // with ↑/↓ and accepts with Enter (or Tab) to fill the InputBox.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const [slashItems, setSlashItems] = React.useState<import('./completions').SlashCompletion[]>([]);
  const [slashSelectedIdx, setSlashSelectedIdx] = React.useState(0);
  // Claude Code re-reads history.jsonl from disk on every arrow-press. We
  // do the same (loadHistory(ctx.cwd) in the ↑/↓ handlers — see below). The
  // React state is kept only for Ctrl+R reverse-search, which InputBox
  // reads as a prop; we refresh it right after each successful submit so
  // fresh entries are reachable via Ctrl+R too.
  const [history, setHistory] = React.useState<string[]>(() => loadHistory(ctx.cwd));
  const [historyIdx, setHistoryIdx] = React.useState(-1);
  const [draft, setDraft] = React.useState('');
  const [inputResetKey, setInputResetKey] = React.useState(0);
  bumpResetKeyRef.current = () => setInputResetKey((k) => k + 1);

  // Command queue — while a turn is streaming (busy), user input is queued
  // and flushed sequentially when busy returns to false. Ctrl+R / history
  // navigation / pending AskUserQuestion still bypass the queue.
  const queueRef = React.useRef<string[]>([]);
  const [queueSize, setQueueSize] = React.useState(0);
  // Synchronous in-flight gate. React's `busy` state flips async, so three
  // rapid Enters can all see busy=false and each spawn runTurn — the user
  // sees the same message triple-echoed. This ref commits synchronously
  // before React can batch. Paired with a 400ms debounce on identical
  // text to swallow accidental double-Enter.
  const inflightRef = React.useRef(false);
  const lastSubmitRef = React.useRef<{ value: string; at: number }>({ value: '', at: 0 });

  // Double-Esc cancel hint state
  const [escArmed, setEscArmed] = React.useState(false);
  const escTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  // Expose TUI message count + bytes to the global debug-log. Called per
  // mem-snapshot from the dispatcher; no per-keystroke cost.
  const messagesRef = React.useRef(messages);
  messagesRef.current = messages;
  React.useEffect(() => {
    (global as any).__makestudio_tuiStats = () => {
      const ms = messagesRef.current;
      let bytes = 0;
      for (const m of ms) {
        if (typeof m.text === 'string') bytes += Buffer.byteLength(m.text, 'utf8');
        if (typeof m.toolOutput === 'string') bytes += Buffer.byteLength(m.toolOutput, 'utf8');
      }
      return { count: ms.length, bytes };
    };
    return () => { delete (global as any).__makestudio_tuiStats; };
  }, []);

  // Tick that bumps every 3s to re-render derived stats (ctx.usage, ctx.messages.length)
  // since ReplContext is a mutable class, not React state. 1s was too aggressive
  // and caused the whole tree to flicker; 3s stays responsive without flashing.
  // Also polls the bridge's pendingQuestion flag so we can unlock the InputBox
  // when a tool (AskUserQuestion) is waiting for the user's inline answer.
  const [statsTick, setStatsTick] = React.useState(0);
  // Tick that bumps whenever coordinator state changes (workers spawned/completed,
  // session activated/deactivated). Passed to StatusLine so its React.memo comparator
  // can detect mutations on the mutable ctx object.
  const [coordinatorTick, setCoordinatorTick] = React.useState(0);
  // Snapshot of coordinator state used to detect changes on each poll interval.
  const coordinatorSnapshotRef = React.useRef<string>('');
  const [awaitingAnswer, setAwaitingAnswer] = React.useState(false);
  const [pickerState, setPickerState] = React.useState<null | { items: any[]; title: string; placeholder: string }>(null);
  const [permState, setPermState] = React.useState<any>(null);
  const [usageOpen, setUsageOpenState] = React.useState<boolean>(false);
  const [matrixOpen, setMatrixOpenState] = React.useState<boolean>(false);
  const [fireOpen, setFireOpenState] = React.useState<boolean>(false);
  const [fireworksOpen, setFireworksOpenState] = React.useState<boolean>(false);
  const [toasts, setToasts] = React.useState<Array<{ id: string; text: string; kind: string }>>([]);

  // Toasts subscribe — transient banners that live above the InputBox and
  // self-expire via setTimeout in the bridge. React component just mirrors.
  React.useEffect(() => {
    try {
      const { onToastsChange, getToasts } = require('./bridge');
      const apply = () => setToasts(getToasts().map((t: any) => ({ id: t.id, text: t.text, kind: t.kind })));
      apply();
      const off = onToastsChange(apply);
      // Re-poll every second so UI ticks toasts off right after they expire
      // even when no new toast is pushed to trigger the listener.
      const poll = setInterval(apply, 1000);
      return () => { off(); clearInterval(poll); };
    } catch { /* */ }
  }, []);

  // Subscribe synchronously to pendingPicker changes — the 500ms poll
  // below is too slow for a picker→askTuiOrReadline handoff (observed:
  // both UIs painted simultaneously). `onPendingPickerChange` fires
  // inline when `showFuzzyPicker` / `consumePickerResult` is called, so
  // we react immediately. Same approach for pendingPermission.
  React.useEffect(() => {
    try {
      const { onPendingPickerChange, getPendingPicker, onPendingPermissionChange, getPendingPermission } = require('./bridge');
      const applyPicker = () => {
        const p = getPendingPicker();
        setPickerState(p ? { items: p.items, title: p.title, placeholder: p.placeholder } : null);
      };
      const applyPerm = () => setPermState(getPendingPermission?.() || null);
      const { onUsageOpenChange, getUsageOpen, onMatrixOpenChange, getMatrixOpen, onFireOpenChange, getFireOpen, onFireworksOpenChange, getFireworksOpen } = require('./bridge');
      const applyUsage = () => setUsageOpenState(!!getUsageOpen?.());
      const applyMatrix = () => setMatrixOpenState(!!getMatrixOpen?.());
      const applyFire = () => setFireOpenState(!!getFireOpen?.());
      const applyFireworks = () => setFireworksOpenState(!!getFireworksOpen?.());
      applyPicker();
      applyPerm();
      applyUsage();
      applyMatrix();
      applyFire();
      applyFireworks();
      const offPicker = onPendingPickerChange(applyPicker);
      const offPerm = onPendingPermissionChange ? onPendingPermissionChange(applyPerm) : () => {};
      const offUsage = onUsageOpenChange ? onUsageOpenChange(applyUsage) : () => {};
      const offMatrix = onMatrixOpenChange ? onMatrixOpenChange(applyMatrix) : () => {};
      const offFire = onFireOpenChange ? onFireOpenChange(applyFire) : () => {};
      const offFireworks = onFireworksOpenChange ? onFireworksOpenChange(applyFireworks) : () => {};
      return () => { offPicker(); offPerm(); offUsage(); offMatrix(); offFire(); offFireworks(); };
    } catch { /* bridge optional */ }
  }, []);

  // Focus tracking disabled — enabling ESC[?1004h causes the terminal to emit
  // ESC[I on click/focus, which Ink 3 splits: ESC consumed internally, bare [I
  // leaks into ink-text-input and pollutes the input buffer. The 500ms/2000ms
  // tick optimization is not worth that corruption.
  const terminalFocused = true;

  React.useEffect(() => {
    // While the user is in ANOTHER window, tick at 2s (just enough to
    // catch awakening). While focused, tick at 500ms for smooth stats.
    // The shared clock means every animated element (spinner, elapsed,
    // stream-tokens) re-renders on the same beat — no visual jitter.
    const intervalMs = terminalFocused ? 500 : 2000;
    const id = setInterval(() => {
      setStatsTick((t) => t + 1);
      try {
        const b = require('./bridge');
        setAwaitingAnswer(!!b.getPendingQuestion());
        // Elapsed secs + live stream token count only when a turn is in
        // flight. When idle, busyStartedAtRef.current is 0 and both stay 0.
        const started = busyStartedAtRef.current;
        if (started > 0) {
          setElapsedSec(Math.max(0, Math.floor((Date.now() - started) / 1000)));
          setStreamTokens(b.getStreamTokens?.() || 0);
        }
      } catch { /* */ }
      // Poll coordinator state — ctx is mutated in place so we derive a
      // snapshot string and bump coordinatorTick when it changes.
      try {
        const active = (ctx as any).coordinatorActive ? '1' : '0';
        const sessionId = (ctx as any).coordinatorSessionId || '';
        const workers: any = (ctx as any).coordinatorWorkers;
        let workerSummary = '';
        if (workers instanceof Map) {
          for (const [k, w] of workers.entries()) {
            workerSummary += `${k}:${(w as any).status};`;
          }
        }
        const snapshot = `${active}|${sessionId}|${workerSummary}`;
        if (snapshot !== coordinatorSnapshotRef.current) {
          coordinatorSnapshotRef.current = snapshot;
          setCoordinatorTick((t) => t + 1);
        }
      } catch { /* coordinator fields may not exist */ }
    }, intervalMs);
    return () => clearInterval(id);
  }, [terminalFocused]);

  // ── window resize ─────────────────────────────────────────
  // No custom handler needed — Ink listens to stdout 'resize' internally
  // and calls scheduleRender(), which re-renders the whole tree.
  // Reading stdout.columns directly (not via state) avoids a second render
  // cycle that caused duplicate InputBox+StatusLine on resize.

  // ── keyboard: exit, clear, double-esc cancel ──────────────
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      onExit();
      app.exit();
      return;
    }
    if (key.ctrl && inputChar === 'l') {
      // Full reset — match /clear behaviour: LLM context, TUI messages,
      // and terminal scrollback.
      ctx.clearConversation();
      setMessages([]);
      process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
      return;
    }
    // Double-Esc cancels the in-flight request without killing the REPL.
    // First Esc arms the hint; second Esc within 600ms triggers cancel.
    if (key.escape) {
      if (escArmed) {
        if (escTimerRef.current) clearTimeout(escTimerRef.current);
        escTimerRef.current = null;
        setEscArmed(false);
        try {
          const controller = (ctx as any).currentAbortController as AbortController | null;
          if (controller && !controller.signal.aborted) {
            controller.abort();
          }
        } catch { /* */ }
      } else if (busy) {
        setEscArmed(true);
        if (escTimerRef.current) clearTimeout(escTimerRef.current);
        escTimerRef.current = setTimeout(() => {
          setEscArmed(false);
          escTimerRef.current = null;
        }, 600);
      }
    }
  });

  // ── Bridge: allow outside code (router, chat.ts) to update UI ──
  const addMessage = React.useCallback((m: Omit<TuiMessage, 'id' | 'timestamp'>): string => {
    const id = `m${nextMsgId++}`;
    setMessages((prev) => [...prev, { ...m, id, timestamp: Date.now() }]);
    return id;
  }, []);

  const updateMessage = React.useCallback((id: string, patch: Partial<TuiMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const setBusyFn = React.useCallback((b: boolean, label?: string) => {
    setBusy(b);
    if (label !== undefined) setBusyLabel(label);
    if (b) {
      busyStartedAtRef.current = Date.now();
      setElapsedSec(0);
      setStreamTokens(0);
      try { require('./bridge').setStreamTokens(0); } catch { /* */ }
    } else {
      busyStartedAtRef.current = 0;
      setElapsedSec(0);
      setStreamTokens(0);
      try { require('./bridge').setStreamTokens(0); } catch { /* */ }
    }
  }, []);

  const clearMessages = React.useCallback(() => {
    setMessages([]);
  }, []);

  React.useEffect(() => {
    // Guard against setState-after-unmount when schedules / async
    // callbacks fire during the detach window of a spawned command
    // (`/refine`, `/doctor`, ...). The ref flips to false when this
    // App instance unmounts — wrapping every state update in that
    // check is cheaper than teaching every call site about lifecycle.
    const mountedRef = { v: true };
    const bridge = {
      addMessage: (m: Omit<TuiMessage, 'id' | 'timestamp'>) => {
        if (!mountedRef.v) return '';
        return addMessage(m);
      },
      updateMessage: (id: string, patch: Partial<TuiMessage>) => {
        if (!mountedRef.v) return;
        updateMessage(id, patch);
      },
      setBusy: (b: boolean, label?: string) => {
        if (!mountedRef.v) return;
        setBusyFn(b, label);
      },
      clearMessages: () => {
        if (!mountedRef.v) return;
        clearMessages();
      },
      getCtx: () => ctx,
    };
    installTuiBridge(bridge);
    return () => {
      mountedRef.v = false;
      uninstallTuiBridge(bridge);
    };
  }, [addMessage, updateMessage, setBusyFn, clearMessages, ctx]);

  // ── Autocomplete on input change ────────────────────────
  // Only update completions state when the list actually changes — otherwise
  // every keystroke re-renders the whole tree via new-array identity.
  React.useEffect(() => {
    let next: string[];
    let nextItems: import('./completions').SlashCompletion[] = [];
    const isSlashContext =
      input.startsWith('/') && (!input.includes(' ') || input.startsWith('/agent '));
    if (!isSlashContext) {
      next = [];
    } else {
      const { getCompletions, getCompletionsWithMeta } = require('./completions');
      next = getCompletions(input, ctx);
      nextItems = getCompletionsWithMeta(input, ctx);
    }
    setCompletions((prev) => {
      if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
      return next;
    });
    setSlashItems((prev) => {
      if (prev.length === nextItems.length && prev.every((v, i) => v.name === nextItems[i].name)) {
        return prev;
      }
      return nextItems;
    });
    // Reset selection to top whenever the filtered list changes shape.
    setSlashSelectedIdx((idx) => (idx >= nextItems.length ? 0 : idx));
  }, [input, ctx]);

  const completionsRef = React.useRef(completions);
  completionsRef.current = completions;

  // Refs so callbacks below can stay stable — if we put `input`/`historyIdx`/
  // `draft` in the deps array, every keystroke rebuilds the callback and
  // invalidates InputBox's memoization.
  const inputRef = React.useRef(input);
  const historyIdxRef = React.useRef(historyIdx);
  const draftRef = React.useRef(draft);
  inputRef.current = input;
  historyIdxRef.current = historyIdx;
  draftRef.current = draft;

  // Tab: recompute completions SYNCHRONOUSLY at the moment of the keypress
  // instead of relying on the useEffect-populated state. The effect might
  // not have flushed yet after a fast keystroke → completionsRef empty →
  // Tab silently does nothing. Reading input directly here bypasses the
  // race entirely.
  const handleTab = React.useCallback(() => {
    const current = inputRef.current;
    if (!current.startsWith('/') || current.includes(' ')) return;
    let matches: string[] = completionsRef.current;
    if (matches.length === 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getCompletions } = require('./completions');
        matches = getCompletions(current, ctx);
      } catch { matches = []; }
    }
    if (matches.length === 0) return;
    const first = matches[0].split(' ')[0];
    setInput(first + ' ');
    setCompletions([]);
    setInputResetKey((k) => k + 1);
  }, [ctx]);

  // Slash-menu handlers — the popup is `open` whenever `slashItems.length > 0`
  // (input starts with `/` and matches at least one command). ↑/↓ navigates,
  // Tab accepts, Esc dismisses by clearing the filter (we just empty input).
  const slashItemsRef = React.useRef(slashItems);
  slashItemsRef.current = slashItems;
  const slashSelectedIdxRef = React.useRef(slashSelectedIdx);
  slashSelectedIdxRef.current = slashSelectedIdx;

  const handleSlashUp = React.useCallback(() => {
    const len = slashItemsRef.current.length;
    if (len === 0) return;
    setSlashSelectedIdx((i) => (i - 1 + len) % len);
  }, []);
  const handleSlashDown = React.useCallback(() => {
    const len = slashItemsRef.current.length;
    if (len === 0) return;
    setSlashSelectedIdx((i) => (i + 1) % len);
  }, []);
  const handleSlashAccept = React.useCallback(() => {
    const items = slashItemsRef.current;
    const idx = slashSelectedIdxRef.current;
    if (idx < 0 || idx >= items.length) return;
    // Insert `<command> ` so the user can immediately type args. The space
    // also closes the menu (the autocomplete effect reacts to includes(' ')).
    setInput(items[idx].name + ' ');
    setInputResetKey((k) => k + 1);
  }, []);
  const handleSlashCancel = React.useCallback(() => {
    // Clearing the input is the simplest way to dismiss the menu without
    // tripping the "history nav" path — it also feels right ergonomically:
    // Esc inside the menu = "scratch that, start over".
    setInput('');
    setInputResetKey((k) => k + 1);
  }, []);

  const handleHistoryPrev = React.useCallback(() => {
    const cur = loadHistory(ctx.cwd);         // read fresh — matches Claude Code
    if (cur.length === 0) return;
    if (historyIdxRef.current === -1) setDraft(inputRef.current);
    const newIdx = historyIdxRef.current === -1 ? cur.length - 1 : Math.max(0, historyIdxRef.current - 1);
    setHistoryIdx(newIdx);
    setInput(cur[newIdx]);
    setInputResetKey((k) => k + 1);
  }, [ctx.cwd]);

  const handleHistoryNext = React.useCallback(() => {
    if (historyIdxRef.current === -1) return;
    const cur = loadHistory(ctx.cwd);         // fresh
    const newIdx = historyIdxRef.current + 1;
    if (newIdx >= cur.length) {
      setHistoryIdx(-1);
      setInput(draftRef.current);
      setDraft('');
    } else {
      setHistoryIdx(newIdx);
      setInput(cur[newIdx]);
    }
    setInputResetKey((k) => k + 1);
  }, [ctx.cwd]);

  const handleScroll = React.useCallback((delta: number) => {
    // delta negativo (shift+↑) = scrollar para tras (ver mais antigas)
    // delta positivo (shift+↓) = scrollar para frente (voltar ao recente)
    // scrollOffset: 0 = ultima msg no bottom, -N = N msgs atras
    setScrollOffset((prev) => {
      const next = prev + delta;
      // Clamp: nao scrollar alem do total de mensagens, nao ultrapassar 0
      const minOffset = -(messages.length - 1);
      return Math.max(minOffset, Math.min(0, next));
    });
  }, [messages.length]);

  const runTurn = React.useCallback(async (value: string) => {
    inflightRef.current = true;
    addMessage({ role: 'user', text: value });
    try {
      // Use setBusyFn — the plain setBusy/setBusyLabel pair bypasses the
      // busyStartedAtRef+streamTokens reset that the StatusLine reads.
      setBusyFn(true, value.startsWith('/') ? `executing ${value.split(' ')[0]}...` : 'thinking...');
      try { require('../tui/bridge').resetLastTool?.(); } catch { /* */ }
      const { routeInputTui } = require('./tui-router');
      await routeInputTui(value, ctx);
    } catch (err: any) {
      addMessage({ role: 'error', text: err.message || String(err) });
    } finally {
      setBusyFn(false, '');
      inflightRef.current = false;
    }
  }, [addMessage, ctx, setBusyFn]);

  const handleSubmit = React.useCallback(async (value: string) => {
    if (!value.trim()) return;
    if (isPastingRef.current) return;

    // Expand "[Pasted text #N +M lines]" markers with their stored content.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    value = require('./bridge').expandPasteMarkers(value);

    // Debounce accidental double-Enter on the exact same text within 400ms.
    const now = Date.now();
    if (lastSubmitRef.current.value === value && now - lastSubmitRef.current.at < 400) {
      setInput('');
      return;
    }
    lastSubmitRef.current = { value, at: now };

    // If a tool (e.g. AskUserQuestion) is waiting for the user's inline
    // answer, consume this submit as the answer and DO NOT route it to
    // chat. Keep the turn in its current busy state.
    const { consumePendingAnswer } = require('./bridge');
    if (consumePendingAnswer(value)) {
      setInput('');
      addMessage({ role: 'user', text: value });
      return;
    }

    appendHistory(value, ctx.cwd);
    setHistory(loadHistory(ctx.cwd));         // refresh in-memory for Ctrl+R
    setInput('');
    setHistoryIdx(-1);
    setScrollOffset(0);

    // ── /ask side question while busy: lightweight LLM call, 1 turn, no tools ──
    // When the agent is processing and the user types /ask <question>, we
    // spawn a parallel LLM call instead of queuing. The main agent continues
    // streaming uninterrupted — the answer appears as a separate message.
    // Port of Claude Code's /btw immediate command.
    if (inflightRef.current && /^\/ask\b/.test(value.trim())) {
      const question = value.trim().replace(/^\/ask\s*/, '');
      if (!question) {
        addMessage({ role: 'info', text: '/ask <question> — ask a quick side question while the agent is working' });
        return;
      }
      addMessage({ role: 'user', text: value });
      // Fire and forget — answer arrives asynchronously. The main agent
      // keeps streaming without interruption.
      try {
        const { runSideQuestion } = require('../side-question');
        runSideQuestion(question, ctx).then(({ answer, error }: any) => {
          if (error) {
            addMessage({ role: 'error', text: `Ask failed: ${error}` });
          } else {
            addMessage({ role: 'assistant', text: answer || '(no response)' });
          }
        });
      } catch { /* side-question optional */ }
      return;
    }

    // Use the synchronous ref — not React's `busy` state, which lags a
    // tick behind and lets 3 rapid Enters each spawn their own runTurn.
    if (inflightRef.current) {
      // Queue the new message — DO NOT abort the running turn. Mirrors
      // the placeholder hint "type to queue · Esc Esc = cancel": typing
      // while the agent is busy means "next, please" not "stop now".
      // Cancelling is reserved for Esc Esc, which is handled separately
      // in the useInput handler above.
      queueRef.current.push(value); // back of the queue, FIFO order
      setQueueSize(queueRef.current.length);
      addMessage({
        role: 'info',
        text: `(queued — ${queueRef.current.length} message${queueRef.current.length === 1 ? '' : 's'} waiting · Esc Esc to cancel current task)`,
      });
      return;
    }

    await runTurn(value);
  }, [addMessage, ctx, runTurn]);

  // ── Drain queued commands when busy falls ─────────────────
  React.useEffect(() => {
    if (busy || inflightRef.current) return;
    if (queueRef.current.length === 0) return;
    const next = queueRef.current.shift()!;
    setQueueSize(queueRef.current.length);
    // runTurn flips inflightRef synchronously so a subsequent effect run
    // in the same tick can't grab another queue item before busy updates.
    runTurn(next);
  }, [busy, runTurn]);

  // ── Compute context usage for status line ───────────────
  // Uses the shape-aware estimateTokens() (chars/3 for code, chars/3.5 for
  // JSON, chars/4 for prose) and the per-model window table. Both 'ctx %'
  // and 'tok' come from the SAME `total` — they're guaranteed consistent.
  const contextStats = React.useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { estimateTokens, estimateContextWindow } = require('../ai/token-estimation');
    const systemTokens = estimateTokens(ctx.buildSystemPrompt());
    const msgTokens = ctx.messages.reduce((s, m) => {
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return s + estimateTokens(body);
    }, 0);
    const total = systemTokens + msgTokens;
    const maxCtx = estimateContextWindow(ctx.providerInfo?.model || '');
    return { pct: (total / maxCtx) * 100, tokens: total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTick, messages.length, ctx.providerInfo]);
  const contextPct = contextStats.pct;
  const currentContextTokens = contextStats.tokens;

  // Todo snapshot for status line — recomputed on each tick.
  const todoSnapshot = React.useMemo(() => {
    try {
      const { getCurrentTodos } = require('../ai/advanced-tools');
      const list = getCurrentTodos(ctx);
      if (!list.length) return undefined;
      const done = list.filter((t: any) => t.status === 'completed').length;
      const inProg = list.find((t: any) => t.status === 'in_progress');
      return {
        total: list.length,
        done,
        inProgress: inProg ? (inProg.activeForm || inProg.subject) : undefined,
      };
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTick, messages.length]);

  // Easter-egg overlays. Both MatrixView and FireView paint via direct
  // stdout writes inside the terminal's alt-screen buffer, so the React
  // tree below KEEPS rendering normally — those writes go to alt-screen
  // and the user sees only the rain/fire. On unmount they leave
  // alt-screen and the main-screen content is restored verbatim, with
  // Ink continuing to render its tree on top exactly as before.
  if (matrixOpen || fireOpen || fireworksOpen) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MatrixView } = require('./MatrixView');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FireView } = require('./FireView');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FireworksView } = require('./FireworksView');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setMatrixOpen, setFireOpen, setFireworksOpen } = require('./bridge');
    if (matrixOpen) return <MatrixView onClose={() => setMatrixOpen(false)} />;
    if (fireOpen) return <FireView onClose={() => setFireOpen(false)} />;
    return <FireworksView onClose={() => setFireworksOpen(false)} />;
  }

  return (
    <Box flexDirection="column" width={cols}>
      <MessageList messages={messages} ctx={ctx} cols={cols} />
      {permState ? (
        (() => {
          const { PermissionPrompt } = require('./PermissionPrompt');
          return <PermissionPrompt spec={permState} />;
        })()
      ) : pickerState ? (
        (() => {
          const { FuzzyPicker } = require('./FuzzyPicker');
          return (
            <FuzzyPicker
              items={pickerState.items}
              title={pickerState.title}
              placeholder={pickerState.placeholder}
            />
          );
        })()
      ) : usageOpen ? (
        (() => {
          const { UsageView } = require('./UsageView');
          const { setUsageOpen } = require('./bridge');
          return <UsageView onClose={() => setUsageOpen(false)} />;
        })()
      ) : (
        <>
          {toasts.length > 0 && (
            <Box flexDirection="column" paddingX={1}>
              {toasts.map((t) => (
                <Box key={t.id}>
                  <Text color={t.kind === 'error' ? '#ef4444' : t.kind === 'warn' ? '#f59e0b' : '#6b7280'} dimColor>
                    {'· '}{t.text}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
          {slashItems.length > 0 && (
            <SlashMenu items={slashItems} selectedIdx={slashSelectedIdx} />
          )}
          <InputBox
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={busy && !awaitingAnswer}
          completions={completions}
          onHistoryPrev={handleHistoryPrev}
          onHistoryNext={handleHistoryNext}
          onTab={handleTab}
          resetKey={inputResetKey}
          history={history}
          slashMenuOpen={slashItems.length > 0}
          onSlashUp={handleSlashUp}
          onSlashDown={handleSlashDown}
          onSlashAccept={handleSlashAccept}
          onSlashCancel={handleSlashCancel}
        />
        </>
      )}
      <StatusLine
        ctx={ctx}
        busy={busy}
        busyLabel={
          awaitingAnswer
            ? 'waiting for your answer…'
            : escArmed
              ? 'press Esc again to cancel…'
              : queueSize > 0
                ? `${busyLabel}  ·  ${queueSize} queued`
                : busyLabel
        }
        elapsedSec={elapsedSec}
        streamTokens={streamTokens}
        contextPct={contextPct}
        msgsCount={ctx.messages.length}
        totalTokens={currentContextTokens}
        sessionPromptTokens={ctx.usage.promptTokens}
        sessionCompletionTokens={ctx.usage.completionTokens}
        sessionCacheReads={ctx.usage.cacheReads}
        cacheReads={ctx.usage.cacheReads}
        todos={todoSnapshot}
        coordinatorTick={coordinatorTick}
      />
    </Box>
  );
}
