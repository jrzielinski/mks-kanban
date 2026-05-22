/**
 * vim.ts
 *
 * Minimal-but-real vim mode for the InputBox. Handles NORMAL/INSERT modes,
 * motions (h/j/k/l, w/b/e, 0/$/^), operators (d/c/y), commands
 * (dd/yy/x/p/P/u/r), and entering INSERT via i/I/a/A/o/O.
 *
 * No ex commands, no registers beyond the default, no visual mode (single-
 * line input doesn't benefit much), no counts. The goal is muscle-memory
 * support — not a 100% vim emulator.
 */

export type VimMode = 'INSERT' | 'NORMAL';

export interface VimState {
  mode: VimMode;
  /** Pending operator — 'd' | 'c' | 'y' | null. */
  pendingOperator: string | null;
  /** Yank register (default " in vim terms). */
  yankRegister: string;
  /** Undo stack of previous {value, cursor} snapshots. */
  undoStack: Array<{ value: string; cursor: number }>;
  /** Replace mode one-shot ('r<char>'). */
  pendingReplace: boolean;
}

export function createVimState(): VimState {
  return {
    mode: 'INSERT',
    pendingOperator: null,
    yankRegister: '',
    undoStack: [],
    pendingReplace: false,
  };
}

export interface VimKeyResult {
  value: string;
  cursor: number;
  state: VimState;
  /** If true, caller should prevent the default TextInput handling of this key. */
  handled: boolean;
  /** If non-null, caller should submit this value (Enter pressed in NORMAL). */
  submit?: string;
}

/**
 * Advance the state machine given the current buffer/cursor and an input
 * event. Pure function — returns the new buffer/cursor/state.
 */
export function handleVimKey(
  current: { value: string; cursor: number; state: VimState },
  input: string,
  key: { escape?: boolean; return?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; tab?: boolean },
): VimKeyResult {
  const { value, cursor } = current;
  let state = { ...current.state };

  // Enter NORMAL from INSERT
  if (state.mode === 'INSERT' && key.escape) {
    state.mode = 'NORMAL';
    // vim snaps cursor one left when leaving insert unless at line start
    const newCursor = Math.max(0, Math.min(value.length, cursor) - (cursor > 0 ? 1 : 0));
    return { value, cursor: newCursor, state, handled: true };
  }

  // While INSERT, only handle Esc (above). Everything else falls through.
  if (state.mode === 'INSERT') {
    return { value, cursor, state, handled: false };
  }

  // NORMAL mode
  // Submit on Enter
  if (key.return) {
    return { value, cursor, state, handled: true, submit: value };
  }

  // Replace mode one-shot (r + char)
  if (state.pendingReplace) {
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      pushUndo(state, value, cursor);
      const next = value.slice(0, cursor) + input + value.slice(cursor + 1);
      state.pendingReplace = false;
      return { value: next, cursor, state, handled: true };
    }
    state.pendingReplace = false;
    return { value, cursor, state, handled: true };
  }

  // Operator waiting (d, c, y): next keystroke is the motion
  if (state.pendingOperator) {
    const op = state.pendingOperator;
    // Double-char commands: dd, cc, yy
    if (input === op) {
      pushUndo(state, value, cursor);
      state.yankRegister = value;
      if (op === 'd') {
        return { value: '', cursor: 0, state: clearOp(state), handled: true };
      }
      if (op === 'c') {
        state.mode = 'INSERT';
        return { value: '', cursor: 0, state: clearOp(state), handled: true };
      }
      if (op === 'y') {
        return { value, cursor, state: clearOp(state), handled: true };
      }
    }
    // Operator + motion
    const range = motionRange(value, cursor, input, key);
    if (range) {
      const [start, end] = range;
      const slice = value.slice(start, end);
      pushUndo(state, value, cursor);
      state.yankRegister = slice;
      if (op === 'y') {
        return { value, cursor: start, state: clearOp(state), handled: true };
      }
      const next = value.slice(0, start) + value.slice(end);
      if (op === 'c') {
        state.mode = 'INSERT';
        return { value: next, cursor: start, state: clearOp(state), handled: true };
      }
      return { value: next, cursor: start, state: clearOp(state), handled: true };
    }
    // Unknown motion — cancel operator
    return { value, cursor, state: clearOp(state), handled: true };
  }

  // Enter INSERT
  if (input === 'i') { state.mode = 'INSERT'; return { value, cursor, state, handled: true }; }
  if (input === 'I') { state.mode = 'INSERT'; return { value, cursor: firstNonBlank(value), state, handled: true }; }
  if (input === 'a') { state.mode = 'INSERT'; return { value, cursor: Math.min(value.length, cursor + 1), state, handled: true }; }
  if (input === 'A') { state.mode = 'INSERT'; return { value, cursor: value.length, state, handled: true }; }
  if (input === 'o') {
    // Single-line input — treat as "append at end then insert"
    state.mode = 'INSERT';
    return { value, cursor: value.length, state, handled: true };
  }
  if (input === 'O') {
    state.mode = 'INSERT';
    return { value, cursor: 0, state, handled: true };
  }

  // Motions
  if (input === 'h' || key.leftArrow)  return { value, cursor: Math.max(0, cursor - 1), state, handled: true };
  if (input === 'l' || key.rightArrow) return { value, cursor: Math.min(value.length, cursor + 1), state, handled: true };
  if (input === '0')                   return { value, cursor: 0, state, handled: true };
  if (input === '$')                   return { value, cursor: value.length, state, handled: true };
  if (input === '^')                   return { value, cursor: firstNonBlank(value), state, handled: true };
  if (input === 'w') {
    const nextBoundary = nextWordStart(value, cursor);
    return { value, cursor: nextBoundary, state, handled: true };
  }
  if (input === 'b') {
    const prevBoundary = prevWordStart(value, cursor);
    return { value, cursor: prevBoundary, state, handled: true };
  }
  if (input === 'e') {
    const end = wordEnd(value, cursor);
    return { value, cursor: end, state, handled: true };
  }

  // Single-char commands
  if (input === 'x') {
    if (cursor >= value.length) return { value, cursor, state, handled: true };
    pushUndo(state, value, cursor);
    const next = value.slice(0, cursor) + value.slice(cursor + 1);
    state.yankRegister = value[cursor];
    return { value: next, cursor: Math.min(next.length, cursor), state, handled: true };
  }
  if (input === 'X') {
    if (cursor === 0) return { value, cursor, state, handled: true };
    pushUndo(state, value, cursor);
    const next = value.slice(0, cursor - 1) + value.slice(cursor);
    return { value: next, cursor: cursor - 1, state, handled: true };
  }
  if (input === 'p') {
    if (!state.yankRegister) return { value, cursor, state, handled: true };
    pushUndo(state, value, cursor);
    const insertAt = Math.min(value.length, cursor + 1);
    const next = value.slice(0, insertAt) + state.yankRegister + value.slice(insertAt);
    return { value: next, cursor: insertAt + state.yankRegister.length - 1, state, handled: true };
  }
  if (input === 'P') {
    if (!state.yankRegister) return { value, cursor, state, handled: true };
    pushUndo(state, value, cursor);
    const next = value.slice(0, cursor) + state.yankRegister + value.slice(cursor);
    return { value: next, cursor: cursor + state.yankRegister.length - 1, state, handled: true };
  }
  if (input === 'u') {
    const last = state.undoStack.pop();
    if (!last) return { value, cursor, state, handled: true };
    return { value: last.value, cursor: last.cursor, state, handled: true };
  }
  if (input === 'r') {
    state.pendingReplace = true;
    return { value, cursor, state, handled: true };
  }

  // Operators
  if (input === 'd' || input === 'c' || input === 'y') {
    state.pendingOperator = input;
    return { value, cursor, state, handled: true };
  }

  // Shortcuts
  if (input === 'D') {
    // delete to end of line
    pushUndo(state, value, cursor);
    state.yankRegister = value.slice(cursor);
    return { value: value.slice(0, cursor), cursor, state, handled: true };
  }
  if (input === 'C') {
    pushUndo(state, value, cursor);
    state.yankRegister = value.slice(cursor);
    state.mode = 'INSERT';
    return { value: value.slice(0, cursor), cursor, state, handled: true };
  }
  if (input === 'Y') {
    state.yankRegister = value;
    return { value, cursor, state, handled: true };
  }

  // Unknown key in NORMAL — swallow
  return { value, cursor, state, handled: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clearOp(state: VimState): VimState {
  return { ...state, pendingOperator: null };
}

function pushUndo(state: VimState, value: string, cursor: number): void {
  state.undoStack.push({ value, cursor });
  if (state.undoStack.length > 100) state.undoStack.shift();
}

function firstNonBlank(value: string): number {
  const m = value.match(/^\s*/);
  return m ? m[0].length : 0;
}

const WORD_BOUND = /[A-Za-z0-9_]/;

function nextWordStart(value: string, from: number): number {
  let i = from;
  const n = value.length;
  // skip current word
  if (i < n && WORD_BOUND.test(value[i])) {
    while (i < n && WORD_BOUND.test(value[i])) i++;
  } else {
    while (i < n && !WORD_BOUND.test(value[i]) && value[i] !== ' ') i++;
  }
  while (i < n && /\s/.test(value[i])) i++;
  return Math.min(i, n);
}

function prevWordStart(value: string, from: number): number {
  let i = Math.max(0, from - 1);
  while (i > 0 && /\s/.test(value[i])) i--;
  if (WORD_BOUND.test(value[i])) {
    while (i > 0 && WORD_BOUND.test(value[i - 1])) i--;
  } else {
    while (i > 0 && !WORD_BOUND.test(value[i - 1]) && value[i - 1] !== ' ') i--;
  }
  return i;
}

function wordEnd(value: string, from: number): number {
  let i = from;
  const n = value.length;
  if (i < n && /\s/.test(value[i])) {
    while (i < n && /\s/.test(value[i])) i++;
  }
  if (i < n && WORD_BOUND.test(value[i])) {
    while (i < n && WORD_BOUND.test(value[i + 1]!)) i++;
  } else {
    while (i < n && value[i + 1] && !WORD_BOUND.test(value[i + 1]) && !/\s/.test(value[i + 1])) i++;
  }
  return Math.min(i, n);
}

/**
 * Given a motion char and current position, return [start, end) range the
 * motion would cover. Used by operators d/c/y.
 */
function motionRange(
  value: string,
  cursor: number,
  input: string,
  _key: any,
): [number, number] | null {
  switch (input) {
    case 'h': return [Math.max(0, cursor - 1), cursor];
    case 'l': return [cursor, Math.min(value.length, cursor + 1)];
    case 'w': return [cursor, nextWordStart(value, cursor)];
    case 'b': return [prevWordStart(value, cursor), cursor];
    case 'e': return [cursor, Math.min(value.length, wordEnd(value, cursor) + 1)];
    case '0': return [0, cursor];
    case '$': return [cursor, value.length];
    case '^': return [firstNonBlank(value), cursor];
  }
  return null;
}
