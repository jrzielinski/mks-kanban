import * as React from 'react';
import { Box, Text, useInput } from 'ink';
import { consumePickerResult, type PickerItem } from './bridge';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { colors: themeColors } = require('../theme');

/**
 * FuzzyPicker — reusable Ink picker (Fase 3.3).
 *
 * Rendered by App.tsx when `bridge.pendingPicker` is set. Lives in place of
 * the input box so we stay inside Ink's dynamic block (no scrollback ghosts).
 *
 * Controls:
 *   - type               → refine filter
 *   - ↑ / ↓              → navigate
 *   - Enter              → select current item (resolves `value`)
 *   - Esc                → cancel (resolves `null`)
 *   - Backspace          → delete last char of filter
 *
 * Algorithm: in-order subsequence match with gap + length + prefix bonuses.
 * Not as clever as fuzzysort but good enough for N<500 items (which is all
 * we ever ask it for: sessions, agents, files in cwd).
 */

function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  let score = 0;
  for (const qc of q) {
    const found = t.indexOf(qc, ti);
    if (found === -1) return null;
    score += found - ti; // gap penalty
    ti = found + 1;
  }
  if (t.startsWith(q)) score -= 100; // strong prefix bonus
  if (t.includes(q)) score -= 20;    // any contiguous substring bonus
  score += t.length * 0.05;          // tie-break: shorter first
  return score;
}

const MAX_VISIBLE = 10;

export function FuzzyPicker({
  items,
  title,
  placeholder,
}: {
  items: PickerItem[];
  title: string;
  placeholder: string;
}): React.ReactElement {
  const palette = themeColors();
  const [query, setQuery] = React.useState('');
  const [idx, setIdx] = React.useState(0);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return items.map((it, i) => ({ it, score: i }));
    const scored: Array<{ it: PickerItem; score: number }> = [];
    for (const it of items) {
      const s = fuzzyScore(query, it.label);
      if (s === null && it.detail) {
        const sd = fuzzyScore(query, it.detail);
        if (sd !== null) scored.push({ it, score: sd + 50 }); // detail matches rank lower
        continue;
      }
      if (s !== null) scored.push({ it, score: s });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored;
  }, [items, query]);

  // Clamp selected index when filter changes size
  React.useEffect(() => {
    if (idx >= filtered.length) setIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, idx]);

  useInput((input, key) => {
    if (key.escape) {
      consumePickerResult(null);
      return;
    }
    if (key.return) {
      const chosen = filtered[idx]?.it;
      consumePickerResult(chosen ? chosen.value : null);
      return;
    }
    if (key.upArrow) { setIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx((i) => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setIdx(0); return; }
    if (input && !key.ctrl && !key.meta) {
      // Typable character
      setQuery((q) => q + input);
      setIdx(0);
      return;
    }
  });

  // Window: show MAX_VISIBLE items centered around idx
  const start = Math.max(0, Math.min(idx - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE));
  const end = Math.min(filtered.length, start + MAX_VISIBLE);
  const visible = filtered.slice(start, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.primary} paddingX={1}>
      <Box>
        <Text color={palette.primary} bold>{title}  </Text>
        <Text color={palette.dim}>{`(${filtered.length}/${items.length})`}</Text>
      </Box>
      <Box>
        <Text color={palette.accent}>{'❯ '}</Text>
        <Text>{query}</Text>
        <Text color={palette.dim}>
          {query ? '' : placeholder}
        </Text>
      </Box>
      {visible.length === 0 ? (
        <Text color={palette.dim}>(no matches)</Text>
      ) : (
        visible.map(({ it }, i) => {
          const realIdx = start + i;
          const isSel = realIdx === idx;
          return (
            <Box key={realIdx} flexDirection="column">
              <Box>
                <Text color={isSel ? palette.primary : palette.dim} bold={isSel}>
                  {isSel ? '❯ ' : '  '}
                </Text>
                <Text color={isSel ? palette.primary : undefined} bold={isSel}>
                  {it.label}
                </Text>
              </Box>
              {it.detail ? (
                <Text color={palette.dim}>    {it.detail}</Text>
              ) : null}
            </Box>
          );
        })
      )}
    </Box>
  );
}
