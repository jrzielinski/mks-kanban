import * as React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from './CustomTextInput';
import { createVimState, handleVimKey, VimState } from './vim';

interface InputBoxProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;
  completions: string[];
  onHistoryPrev: () => void;
  onHistoryNext: () => void;
  onTab: () => void;
  resetKey: number; // bumped to force cursor to end after tab/history
  history: string[]; // full history list — used by Ctrl+R reverse search
  // ── Slash menu (popup with command suggestions) ───────────────
  // When `slashMenuOpen` is true, ↑/↓ navigates the menu (instead of
  // history), Tab / Enter accepts the highlighted item, and Esc closes.
  slashMenuOpen?: boolean;
  onSlashUp?: () => void;
  onSlashDown?: () => void;
  onSlashAccept?: () => void;
  onSlashCancel?: () => void;
}

/**
 * Parse a keybinding string (e.g. "ctrl+r", "up", "tab", "escape+escape")
 * and return a matcher function.
 */
function matchesBinding(binding: string, input: string, key: any): boolean {
  if (!binding) return false;
  const parts = binding.toLowerCase().split('+');
  // Double-key bindings (escape+escape) are handled separately — we just
  // match the last key here and let the caller implement the double-press.
  const target = parts[parts.length - 1];
  const needsCtrl = parts.includes('ctrl');
  const needsMeta = parts.includes('meta') || parts.includes('cmd');
  const needsShift = parts.includes('shift');

  // Some Ink / terminal combinations deliver bare special keys (Tab, arrow
  // keys, etc.) with spurious modifier flags set — typically `key.ctrl=true`
  // even when the user did not hold ctrl. Confirmed via the key-log:
  // `keys=[ctrl,tab]` and `keys=[ctrl,up]`. When the binding asks for a
  // bare special key (no modifiers) AND the key.<flag> is set, trust the
  // explicit key flag and ignore stray modifiers.
  const BARE_SPECIAL_TARGETS = new Set(['tab', 'up', 'down', 'left', 'right', 'escape', 'esc', 'enter', 'return', 'backspace', 'bs', 'delete']);
  const isBareSpecial =
    BARE_SPECIAL_TARGETS.has(target) && !needsCtrl && !needsMeta && !needsShift;
  if (!isBareSpecial) {
    if (needsCtrl !== !!key.ctrl) return false;
    if (needsMeta !== !!key.meta) return false;
    if (needsShift && !key.shift) return false;
  }

  switch (target) {
    case 'up':     return !!key.upArrow;
    case 'down':   return !!key.downArrow;
    case 'left':   return !!key.leftArrow;
    case 'right':  return !!key.rightArrow;
    case 'tab':
      // Defence in depth: some terminals / Ink versions set key.tab
      // correctly, some only deliver raw '\t' (0x09) as input, some
      // deliver shift+Tab with the same code. Accept all of them.
      return !!key.tab
        || input === '\t'
        || (!!input && input.charCodeAt(0) === 9);
    case 'enter':
    case 'return': return !!key.return;
    case 'escape':
    case 'esc':    return !!key.escape;
    case 'space':  return input === ' ';
    case 'backspace':
    case 'bs':     return !!key.backspace;
    case 'delete': return !!key.delete;
    default:
      // single-character key; compare lower-case
      return input.toLowerCase() === target;
  }
}

function InputBoxImpl(props: InputBoxProps): React.ReactElement {
  // Load user keybindings once — they only change after /restart which
  // rebuilds the whole REPL process.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const settings = React.useMemo(() => require('../settings').loadSettings(), []);
  const kb = settings.keybindings as Record<string, string>;
  const vimEnabled = !!settings.vimMode;

  // Vim state machine — kept in a ref so updates don't cause extra renders.
  const vimStateRef = React.useRef<VimState>(createVimState());
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>(vimStateRef.current.mode);

  // Reverse history search state (configurable via kb.reverseSearch).
  const [searchMode, setSearchMode] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchIdx, setSearchIdx] = React.useState(0);

  // Shift+Enter: ink-text-input fires onSubmit for any key.return. We set
  // swallowNextSubmitRef so handleSubmit can swallow the spurious submit.
  // Ctrl+J newline insertion is handled in App.tsx's raw-stdin listener.
  const swallowNextSubmitRef = React.useRef(false);

  const matches = React.useMemo(() => {
    if (!searchMode) return [];
    const q = searchQuery.toLowerCase();
    if (!q) return [...props.history].reverse();
    return [...props.history].reverse().filter(h => h.toLowerCase().includes(q));
  }, [searchMode, searchQuery, props.history]);

  const currentMatch = matches[searchIdx] || '';

  // Multiline support: split value on \n so previous lines render above the
  // active TextInput and the TextInput only manages the last (current) line.
  const lines = props.value.split('\n');
  const prevLines = lines.slice(0, -1);
  const lastLine = lines[lines.length - 1];
  const isMultiline = prevLines.length > 0;

  useInput((input, key) => {
    // Short-circuit when the keypress is pure focus/bracketed-paste noise
    // (`[I`, `[O`, `\x1b[O[I[O`, …). The parent's setInput already scrubs
    // these runs from the buffer whichever useInput handler won the race —
    // here we just stop our own binding logic from firing on junk.
    const FOCUS_RX = /(?:\x1b\[[IO]|\[[IO])+/g;
    if (input && input.replace(FOCUS_RX, '') === '') return;

    // Vim mode: intercept keys BEFORE anything else when enabled.
    if (vimEnabled) {
      const result = handleVimKey(
        { value: props.value, cursor: props.value.length, state: vimStateRef.current },
        input,
        key,
      );
      if (result.handled) {
        vimStateRef.current = result.state;
        if (result.state.mode !== vimMode) setVimMode(result.state.mode);
        if (result.value !== props.value) props.onChange(result.value);
        if (result.submit !== undefined) props.onSubmit(result.submit);
        return;
      }
    }

    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearchQuery('');
        setSearchIdx(0);
        return;
      }
      if (key.return) {
        if (currentMatch) props.onChange(currentMatch);
        setSearchMode(false);
        setSearchQuery('');
        setSearchIdx(0);
        return;
      }
      if (matchesBinding(kb.reverseSearch, input, key) || key.upArrow) {
        setSearchIdx(i => Math.min(matches.length - 1, i + 1));
        return;
      }
      if (key.downArrow) {
        setSearchIdx(i => Math.max(0, i - 1));
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery(q => q.slice(0, -1));
        setSearchIdx(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearchQuery(q => q + input);
        setSearchIdx(0);
        return;
      }
      return;
    }

    // Normal mode — match against configured bindings

    // Ctrl+V → clipboard image paste (handled in App.tsx raw-stdin listener).
    if (input === '\x16' || ((key.ctrl || key.meta) && (input === 'v' || input === 'V'))) {
      return;
    }

    // Ctrl+J → insert newline (multiline mode).
    // ink-text-input is patched to skip ctrl+j early-return, so no 'j' leaks.
    if ((key.ctrl && input === 'j') || matchesBinding(kb.newline || 'ctrl+j', input, key)) {
      props.onChange(props.value + '\n');
      return;
    }

    // Shift+Enter (key.shift=true + key.return=true, in terminals that
    // distinguish it). ink-text-input fires onSubmit for any key.return, so
    // swallowNextSubmitRef signals handleSubmit to absorb the spurious submit.
    if (key.shift && key.return) {
      swallowNextSubmitRef.current = true;
      props.onChange(props.value + '\n');
      return;
    }

    if (matchesBinding(kb.reverseSearch, input, key)) {
      setSearchMode(true); setSearchQuery(''); setSearchIdx(0); return;
    }

    // Slash-menu navigation takes precedence over history when the popup
    // is showing — ↑/↓ moves the highlight, Esc dismisses it.
    if (props.slashMenuOpen) {
      if (key.upArrow)   { props.onSlashUp?.();     return; }
      if (key.downArrow) { props.onSlashDown?.();   return; }
      if (key.escape)    { props.onSlashCancel?.(); return; }
    }
    if (matchesBinding(kb.historyPrev, input, key)) { props.onHistoryPrev(); return; }
    if (matchesBinding(kb.historyNext, input, key)) { props.onHistoryNext(); return; }
    // Tab fallback: match if the user's binding says so OR if raw Tab
    // came through. Note we IGNORE key.ctrl — some terminals deliver Tab
    // with ctrl flag set spuriously (see the terminal keys debug log).
    const tabPressed = !key.meta && (
      !!key.tab
      || input === '\t'
      || (!!input && input.charCodeAt(0) === 9)
    );
    // DEBUG — dump every keypress to /tmp/makestudio-keys.log when
    // MAKESTUDIO_DEBUG_KEYS=1 is set. Works without polluting the TUI.
    if (process.env.MAKESTUDIO_DEBUG_KEYS === '1') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        const code = input ? input.charCodeAt(0) : -1;
        const flags = Object.keys(key).filter((k) => (key as any)[k]).join(',');
        fs.appendFileSync('/tmp/makestudio-keys.log',
          `${new Date().toISOString()} input=${JSON.stringify(input)} code=${code} keys=[${flags}] value='${props.value}' disabled=${!!props.disabled} vim=${vimEnabled} search=${searchMode}\n`);
      } catch { /* */ }
    }
    if (matchesBinding(kb.tabComplete || 'tab', input, key) || tabPressed) {
      // Slash-menu open: Tab accepts the highlighted command and lets the
      // user keep typing args after the auto-inserted space.
      if (props.slashMenuOpen && props.onSlashAccept) {
        props.onSlashAccept();
        return;
      }
      // When input is empty and a prompt suggestion is pending, Tab fills it.
      if (!props.value) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { consumePendingSuggestion } = require('./bridge');
          const s = consumePendingSuggestion();
          if (s) {
            props.onChange(s);
            return;
          }
        } catch { /* */ }
      }
      props.onTab();
      return;
    }
  });

  // TextInput manages only the last line. onChange reconstructs the full
  // multiline value; onSubmit fires the full value or swallows Shift+Enter.
  const handleLastLineChange = React.useCallback((v: string) => {
    props.onChange(prevLines.length > 0 ? [...prevLines, v].join('\n') : v);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onChange, prevLines.join('\n')]);

  const handleSubmit = React.useCallback((_lastLine: string) => {
    if (swallowNextSubmitRef.current) {
      swallowNextSubmitRef.current = false;
      return;
    }
    // Submit the full multiline value, not just the last line that TextInput sees.
    props.onSubmit(props.value);
  }, [props.onSubmit, props.value]);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const themeBorder = (() => {
    try { return require('../theme').inputBorderColor(); } catch { return 'cyan'; }
  })();

  // Live terminal width via Ink's hook — re-renders on resize so the
  // top/bottom rules stay flush with the edges. Subtract 2 for the
  // parent's paddingX={1} (1 char each side).
  const { stdout } = useStdout();
  const cols = (stdout?.columns ?? process.stdout.columns ?? 80) - 2;
  const hr = '─'.repeat(Math.max(1, cols));

  return (
    <Box flexDirection="column" paddingX={1}>
      {(() => {
        if (searchMode) return null;
        return (
          <Box>
            <Text color={themeBorder}>{hr}</Text>
          </Box>
        );
      })()}
      {searchMode ? (
        <Box flexDirection="column">
          <Box>
            <Text color="yellow" bold>{'(reverse-i-search) '}</Text>
            <Text color="yellow">{`'${searchQuery}': `}</Text>
            <Text>{currentMatch}</Text>
          </Box>
          <Box>
            <Text color="gray">
              {matches.length === 0
                ? '  no matches — ESC to cancel'
                : `  ${searchIdx + 1}/${matches.length}  · Ctrl+R/↑ next · ↓ prev · Enter accept · ESC cancel`}
            </Text>
          </Box>
        </Box>
      ) : (
        <>
          {/* Previous lines — show last 4, truncate long lines, collapse middle */}
          {(() => {
            const MAX_SHOW = 4;
            const MAX_COLS = (process.stdout.columns || 80) - 6; // 6 = border + padding + prefix
            const truncate = (s: string) =>
              s.length > MAX_COLS ? s.slice(0, MAX_COLS - 1) + '…' : s;
            const vimPfx = vimEnabled ? (
              <Text color={vimMode === 'NORMAL' ? 'green' : 'magenta'} bold>
                {`[${vimMode === 'NORMAL' ? 'N' : 'I'}] `}
              </Text>
            ) : null;
            if (prevLines.length <= MAX_SHOW) {
              return prevLines.map((line, i) => (
                <Box key={i}>
                  {vimPfx}
                  <Text color="cyan" bold>{'  '}</Text>
                  <Text dimColor>{truncate(line) || ' '}</Text>
                </Box>
              ));
            }
            // Many lines: show first 1, collapsed count, last (MAX_SHOW-2)
            const head = prevLines.slice(0, 1);
            const tail = prevLines.slice(-(MAX_SHOW - 2));
            const hidden = prevLines.length - 1 - (MAX_SHOW - 2);
            return [
              ...head.map((line, i) => (
                <Box key={`h${i}`}>
                  {vimPfx}
                  <Text color="cyan" bold>{'  '}</Text>
                  <Text dimColor>{truncate(line) || ' '}</Text>
                </Box>
              )),
              <Box key="ellipsis">
                <Text color="gray">{`  ··· ${hidden} more lines ···`}</Text>
              </Box>,
              ...tail.map((line, i) => (
                <Box key={`t${i}`}>
                  {vimPfx}
                  <Text color="cyan" bold>{'  '}</Text>
                  <Text dimColor>{truncate(line) || ' '}</Text>
                </Box>
              )),
            ];
          })()}
          {/* Active (last) line with TextInput */}
          <Box>
            {vimEnabled ? (
              <Text color={vimMode === 'NORMAL' ? 'green' : 'magenta'} bold>
                {`[${vimMode === 'NORMAL' ? 'N' : 'I'}] `}
              </Text>
            ) : null}
            <Text color={props.disabled ? 'yellow' : 'cyan'} bold>{'> '}</Text>
            {/* Always accept input. When disabled (busy), submits are queued
                by the App — InputBox itself stays editable so you can keep
                typing while the current turn streams. */}
            <TextInput
              key={props.resetKey}
              value={lastLine}
              onChange={handleLastLineChange}
              onSubmit={handleSubmit}
              placeholder={props.disabled
                ? 'type to queue · Esc Esc = cancel'
                : 'type /help, /cost, /ctx... or just chat'}
            />
          </Box>
          {/* Multiline hint shown only when there are multiple lines */}
          {isMultiline && (
            <Box marginTop={0}>
              <Text color="gray">{`  ${lines.length} lines · Ctrl+J to add line · Enter to send`}</Text>
            </Box>
          )}
          {/* Inline completion hint disabled — the rich slash-menu popup
              rendered by App.tsx (above the InputBox) replaces this. */}
          {/* Footer badges (PermissionMode / OutputStyle) moved to the
              StatusLine — adds the `mode` / `style` fields and frees the
              input box from a noisy second row that misaligned the cursor.
              See StatusLine.tsx case 'mode' / 'style'. */}
        </>
      )}
      {(() => {
        if (searchMode) return null;
        return (
          <Box>
            <Text color={themeBorder}>{hr}</Text>
          </Box>
        );
      })()}
    </Box>
  );
}

// Memoize so parent re-renders that don't touch our props (e.g. statsTick
// bumping the StatusLine above) don't walk the TextInput tree.
export const InputBox = React.memo(InputBoxImpl, (prev, next) => {
  if (prev.value !== next.value) return false;
  if (prev.disabled !== next.disabled) return false;
  if (prev.resetKey !== next.resetKey) return false;
  if (prev.onChange !== next.onChange) return false;
  if (prev.onSubmit !== next.onSubmit) return false;
  if (prev.onTab !== next.onTab) return false;
  if (prev.onHistoryPrev !== next.onHistoryPrev) return false;
  if (prev.onHistoryNext !== next.onHistoryNext) return false;
  if (prev.history !== next.history) return false;
  if (prev.slashMenuOpen !== next.slashMenuOpen) return false;
  if (prev.onSlashUp !== next.onSlashUp) return false;
  if (prev.onSlashDown !== next.onSlashDown) return false;
  if (prev.onSlashAccept !== next.onSlashAccept) return false;
  if (prev.onSlashCancel !== next.onSlashCancel) return false;
  if (prev.completions === next.completions) return true;
  if (prev.completions.length !== next.completions.length) return false;
  for (let i = 0; i < prev.completions.length; i++) {
    if (prev.completions[i] !== next.completions[i]) return false;
  }
  return true;
});
