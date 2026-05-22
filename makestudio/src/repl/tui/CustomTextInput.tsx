/**
 * CustomTextInput — drop-in replacement for ink-text-input with extra
 * keyboard bindings:
 *   Home / Ctrl+A          → start of line
 *   End  / Ctrl+E          → end of line
 *   Ctrl+Right             → next word
 *   Ctrl+Left              → prev word
 *   Ctrl+Home              → select from cursor to start
 *   Ctrl+End               → select from cursor to end
 *
 * Selection is rendered via chalk.inverse over the highlighted range. Any
 * navigation key WITHOUT modifying intent collapses the selection. Typing
 * or backspace replaces the selected range.
 *
 * Cursor state is internal (matching ink-text-input's pattern). Value is
 * controlled by the parent via `value`/`onChange`.
 */
import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import { Text, useInput } from 'ink';
import chalk = require('chalk');

interface Props {
  value: string;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
}

// Word boundary: identifier-like chars vs everything else.
function isWordChar(ch: string): boolean {
  return /[\w$]/.test(ch);
}

function nextWordBoundary(s: string, from: number): number {
  let i = from;
  // Skip current word
  while (i < s.length && isWordChar(s[i])) i++;
  // Skip non-word chars
  while (i < s.length && !isWordChar(s[i])) i++;
  return i;
}

function prevWordBoundary(s: string, from: number): number {
  let i = from;
  if (i > 0) i--;
  // Skip non-word chars going left
  while (i > 0 && !isWordChar(s[i])) i--;
  // Skip word chars going left
  while (i > 0 && isWordChar(s[i - 1])) i--;
  return i;
}

// Detect raw escape sequences that Ink 3 doesn't parse into key.* flags.
// IMPORTANT: Ink 3 strips the leading ESC (\x1b) before invoking the
// handler and sets key.meta=true. So we match the POST-STRIP form: the
// `[H` / `[F` / `[1;5C` etc., not the raw `\x1b[H`.
function parseSpecial(input: string, key: { meta?: boolean }): string | null {
  if (!input) return null;
  // Only consider when meta flag set (means original had leading ESC).
  // Some terminals send raw `\x1b[H`; check both forms defensively.
  const i = input;
  if (key.meta) {
    if (i === '[H' || i === '[1~' || i === '[7~' || i === 'OH') return 'home';
    if (i === '[F' || i === '[4~' || i === '[8~' || i === 'OF') return 'end';
    if (i === '[1;5D' || i === 'Od') return 'ctrl-left';
    if (i === '[1;5C' || i === 'Oc') return 'ctrl-right';
    if (i === '[1;5H') return 'ctrl-home';
    if (i === '[1;5F') return 'ctrl-end';
  }
  // Raw form (rare — when ESC isn't stripped)
  if (i === '\x1b[H' || i === '\x1b[1~' || i === '\x1b[7~') return 'home';
  if (i === '\x1b[F' || i === '\x1b[4~' || i === '\x1b[8~') return 'end';
  if (i === '\x1b[1;5D' || i === '\x1bOd') return 'ctrl-left';
  if (i === '\x1b[1;5C' || i === '\x1bOc') return 'ctrl-right';
  if (i === '\x1b[1;5H') return 'ctrl-home';
  if (i === '\x1b[1;5F') return 'ctrl-end';
  return null;
}

const CustomTextInput: React.FC<Props> = ({
  value,
  placeholder = '',
  focus = true,
  showCursor = true,
  onChange,
  onSubmit,
}) => {
  const [cursor, setCursor] = useState<number>(value.length);
  // null = no selection; otherwise anchor position. Selected range = [min(cursor, anchor), max(cursor, anchor))
  const [anchor, setAnchor] = useState<number | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Clamp cursor when value shrinks externally
  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
    if (anchor !== null && anchor > value.length) setAnchor(value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useInput((input, key) => {
    if (!focus) return;

    const special = parseSpecial(input, key);

    // Ctrl+A / Home → cursor to 0, collapse selection
    if (special === 'home' || (key.ctrl && input === 'a')) {
      setCursor(0); setAnchor(null); return;
    }
    // Ctrl+E / End → cursor to end
    if (special === 'end' || (key.ctrl && input === 'e')) {
      setCursor(value.length); setAnchor(null); return;
    }
    // Ctrl+Home → select from cursor to 0
    if (special === 'ctrl-home') {
      setAnchor(cursor); setCursor(0); return;
    }
    // Ctrl+End → select from cursor to length
    if (special === 'ctrl-end') {
      setAnchor(cursor); setCursor(value.length); return;
    }
    // Ctrl+Right → next word
    if (special === 'ctrl-right' || (key.ctrl && key.rightArrow)) {
      setCursor(nextWordBoundary(value, cursor));
      setAnchor(null);
      return;
    }
    // Ctrl+Left → prev word
    if (special === 'ctrl-left' || (key.ctrl && key.leftArrow)) {
      setCursor(prevWordBoundary(value, cursor));
      setAnchor(null);
      return;
    }
    // Plain Left/Right
    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - 1));
      setAnchor(null);
      return;
    }
    if (key.rightArrow) {
      setCursor(c => Math.min(value.length, c + 1));
      setAnchor(null);
      return;
    }
    // Up/Down/Tab — let parent useInput handle
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) return;

    // Return — submit
    if (key.return) {
      if (onSubmit) onSubmit(value);
      return;
    }

    // Selection-aware backspace/delete: if selection active, delete the range.
    if (key.backspace || key.delete) {
      if (anchor !== null && anchor !== cursor) {
        const [a, b] = anchor < cursor ? [anchor, cursor] : [cursor, anchor];
        const next = value.slice(0, a) + value.slice(b);
        onChange(next);
        setCursor(a);
        setAnchor(null);
        return;
      }
      if (cursor > 0) {
        const next = value.slice(0, cursor - 1) + value.slice(cursor);
        onChange(next);
        setCursor(c => c - 1);
      }
      return;
    }

    // Ignore Ctrl+C and other ctrl-letter combos that aren't a/e
    if (key.ctrl && input && input.length === 1 && input !== '\x16') {
      // Let parent handle (Ctrl+J, Ctrl+R, etc)
      return;
    }

    // Ctrl+V (clipboard) — let parent handle
    if (input === '\x16') return;

    // Regular text input (or paste). If selection is active, replace it.
    if (input && !key.meta) {
      // Filter out raw escape sequences we didn't recognize as special:
      // these typically start with ESC and have non-printable bytes.
      // Allow only printable + tab + newline (newline goes through input).
      // Specifically: drop input that starts with \x1b and we didn't classify.
      if (input.charCodeAt(0) === 0x1b) return;

      // Drag-and-drop rewrite — most terminals insert the path of a
      // dropped file as plain text. When dndAutoAtRef is enabled and
      // the entire chunk looks like a path that exists on disk, we
      // rewrite it as `@<path>` so the at-references resolver picks
      // it up automatically. Off by default; opt-in via setting.
      let pasteInput = input;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { isDndRewriteEnabled, maybeRewriteDroppedPath } = require('./dnd-path-rewrite');
        if (isDndRewriteEnabled()) {
          const rewritten = maybeRewriteDroppedPath(input);
          if (rewritten) pasteInput = rewritten;
        }
      } catch { /* helper missing — keep raw input */ }

      let next: string;
      let nextCursor: number;
      if (anchor !== null && anchor !== cursor) {
        const [a, b] = anchor < cursor ? [anchor, cursor] : [cursor, anchor];
        next = value.slice(0, a) + pasteInput + value.slice(b);
        nextCursor = a + pasteInput.length;
      } else {
        next = value.slice(0, cursor) + pasteInput + value.slice(cursor);
        nextCursor = cursor + pasteInput.length;
      }
      onChange(next);
      setCursor(nextCursor);
      setAnchor(null);
    }
  }, { isActive: focus });

  // Render. If selection, highlight selected range. Cursor rendered as
  // inverse char (matching ink-text-input visual style).
  if (!value) {
    if (placeholder) {
      const ph = chalk.gray(placeholder);
      return showCursor && focus ? (
        <Text>{chalk.inverse(placeholder[0]) + chalk.gray(placeholder.slice(1))}</Text>
      ) : <Text>{ph}</Text>;
    }
    return showCursor && focus ? <Text>{chalk.inverse(' ')}</Text> : <Text> </Text>;
  }

  // Build rendered value with selection + cursor
  const selStart = anchor !== null ? Math.min(anchor, cursor) : -1;
  const selEnd = anchor !== null ? Math.max(anchor, cursor) : -1;
  let rendered = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const inSel = anchor !== null && i >= selStart && i < selEnd;
    if (showCursor && focus && i === cursor && anchor === null) {
      rendered += chalk.inverse(ch);
    } else if (inSel) {
      rendered += chalk.bgBlue.white(ch);
    } else {
      rendered += ch;
    }
  }
  // Cursor at end of value
  if (showCursor && focus && cursor === value.length && anchor === null) {
    rendered += chalk.inverse(' ');
  }
  return <Text>{rendered}</Text>;
};

export default CustomTextInput;
