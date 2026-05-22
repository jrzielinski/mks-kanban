/**
 * MarkdownTable.tsx
 *
 * Ported from Claude Code:
 *   ~/develop/claude-code/src/components/MarkdownTable.tsx
 *
 * Renders a markdown table as Ink <Box> + <Text> with proper column sizing,
 * cell wrapping, and a vertical (key-value) fallback for narrow terminals.
 */

import * as React from 'react';
import { Box, Text } from 'ink';
import type { Token, Tokens } from 'marked';
import { formatToken, padAligned, stringWidth } from '../markdown';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripAnsiLib = require('strip-ansi');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wrapAnsiLib = require('wrap-ansi');

function stripAnsi(s: string): string {
  const fn = typeof stripAnsiLib === 'function' ? stripAnsiLib : (stripAnsiLib?.default || ((x: string) => x));
  return fn(s);
}
function wrapAnsi(text: string, width: number, opts?: { hard?: boolean }): string {
  const fn = typeof wrapAnsiLib === 'function' ? wrapAnsiLib : (wrapAnsiLib?.default || ((t: string) => t));
  return fn(text, width, { hard: !!opts?.hard, trim: false, wordWrap: true });
}

const SAFETY_MARGIN = 4;
const MIN_COLUMN_WIDTH = 3;
const MAX_ROW_LINES = 4;

function wrapText(text: string, width: number, opts?: { hard?: boolean }): string[] {
  if (width <= 0) return [text];
  const trimmed = text.trimEnd();
  const wrapped = wrapAnsi(trimmed, width, opts);
  const lines = wrapped.split('\n').filter(l => l.length > 0);
  return lines.length ? lines : [''];
}

interface Props {
  token: Tokens.Table;
  forceWidth?: number;
}

function useTerminalWidth(): number {
  const [cols, setCols] = React.useState<number>(
    (process.stdout as any)?.columns || 100,
  );
  React.useEffect(() => {
    const stdout = process.stdout as any;
    if (!stdout) return;
    const onResize = () => setCols(stdout.columns || 100);
    stdout.on?.('resize', onResize);
    return () => { stdout.off?.('resize', onResize); };
  }, []);
  return cols;
}

export function MarkdownTable({ token, forceWidth }: Props): React.ReactElement {
  const actual = useTerminalWidth();
  const terminalWidth = forceWidth ?? actual;

  const formatCell = (tokens: Token[] | undefined): string =>
    (tokens || []).map(t => formatToken(t, 0, null, null)).join('');

  const getPlainText = (tokens: Token[] | undefined): string =>
    stripAnsi(formatCell(tokens));

  const getMinWidth = (tokens: Token[] | undefined): number => {
    const text = getPlainText(tokens);
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return MIN_COLUMN_WIDTH;
    return Math.max(...words.map(w => stringWidth(w)), MIN_COLUMN_WIDTH);
  };
  const getIdealWidth = (tokens: Token[] | undefined): number =>
    Math.max(stringWidth(getPlainText(tokens)), MIN_COLUMN_WIDTH);

  const minWidths = token.header.map((h, i) => {
    let m = getMinWidth(h.tokens);
    for (const r of token.rows) m = Math.max(m, getMinWidth(r[i]?.tokens));
    return m;
  });
  const idealWidths = token.header.map((h, i) => {
    let m = getIdealWidth(h.tokens);
    for (const r of token.rows) m = Math.max(m, getIdealWidth(r[i]?.tokens));
    return m;
  });

  const numCols = token.header.length;
  const borderOverhead = 1 + numCols * 3;
  const availableWidth = Math.max(
    terminalWidth - borderOverhead - SAFETY_MARGIN,
    numCols * MIN_COLUMN_WIDTH,
  );

  const totalMin = minWidths.reduce((s, w) => s + w, 0);
  const totalIdeal = idealWidths.reduce((s, w) => s + w, 0);
  let needsHardWrap = false;
  let columnWidths: number[];
  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths.slice();
  } else if (totalMin <= availableWidth) {
    const extra = availableWidth - totalMin;
    const overflows = idealWidths.map((id, i) => id - minWidths[i]);
    const total = overflows.reduce((s, o) => s + o, 0);
    columnWidths = minWidths.map((min, i) => {
      if (total === 0) return min;
      return min + Math.floor((overflows[i] / total) * extra);
    });
  } else {
    needsHardWrap = true;
    const scale = availableWidth / totalMin;
    columnWidths = minWidths.map(w => Math.max(Math.floor(w * scale), MIN_COLUMN_WIDTH));
  }

  // Determine max row lines to decide on vertical fallback
  const rowMaxLines = (cells: Array<{ tokens?: Token[] }>): number => {
    let m = 1;
    for (let i = 0; i < cells.length; i++) {
      const wrapped = wrapText(formatCell(cells[i]?.tokens), columnWidths[i], { hard: needsHardWrap });
      if (wrapped.length > m) m = wrapped.length;
    }
    return m;
  };
  let maxRowLines = rowMaxLines(token.header);
  for (const r of token.rows) maxRowLines = Math.max(maxRowLines, rowMaxLines(r));

  if (maxRowLines > MAX_ROW_LINES) {
    return <VerticalLayout token={token} terminalWidth={terminalWidth} formatCell={formatCell} getPlainText={getPlainText} />;
  }

  return <GridLayout token={token} columnWidths={columnWidths} hard={needsHardWrap} formatCell={formatCell} />;
}

// ── Grid layout ─────────────────────────────────────────────────────────────

function GridLayout({
  token, columnWidths, hard, formatCell,
}: {
  token: Tokens.Table;
  columnWidths: number[];
  hard: boolean;
  formatCell: (t: Token[] | undefined) => string;
}): React.ReactElement {
  const renderRow = (cells: Array<{ tokens?: Token[] }>, isHeader: boolean): string[] => {
    const cellLines = cells.map((cell, ci) =>
      wrapText(formatCell(cell.tokens), columnWidths[ci], { hard }),
    );
    const maxLines = Math.max(...cellLines.map(l => l.length), 1);
    const offsets = cellLines.map(lines => Math.floor((maxLines - lines.length) / 2));
    const result: string[] = [];
    for (let li = 0; li < maxLines; li++) {
      let line = '│';
      for (let ci = 0; ci < cells.length; ci++) {
        const lines = cellLines[ci];
        const off = offsets[ci];
        const idx = li - off;
        const raw = idx >= 0 && idx < lines.length ? lines[idx] : '';
        const width = columnWidths[ci];
        const align = isHeader ? 'center' : token.align?.[ci] ?? 'left';
        line += ' ' + padAligned(raw, stringWidth(raw), width, align) + ' │';
      }
      result.push(line);
    }
    return result;
  };

  const border = (type: 'top' | 'middle' | 'bottom'): string => {
    const [l, m, c, r] = {
      top: ['┌', '─', '┬', '┐'],
      middle: ['├', '─', '┼', '┤'],
      bottom: ['└', '─', '┴', '┘'],
    }[type] as [string, string, string, string];
    let line = l;
    columnWidths.forEach((w, i) => {
      line += m.repeat(w + 2);
      line += i < columnWidths.length - 1 ? c : r;
    });
    return line;
  };

  const lines: string[] = [];
  lines.push(border('top'));
  lines.push(...renderRow(token.header, true));
  lines.push(border('middle'));
  token.rows.forEach((row) => {
    lines.push(...renderRow(row, false));
  });
  lines.push(border('bottom'));

  return (
    <Box flexDirection="column">
      {lines.map((ln, i) => (
        <Text key={i}>{ln}</Text>
      ))}
    </Box>
  );
}

// ── Vertical (key-value) layout for narrow terminals ───────────────────────

function VerticalLayout({
  token, terminalWidth, formatCell, getPlainText,
}: {
  token: Tokens.Table;
  terminalWidth: number;
  formatCell: (t: Token[] | undefined) => string;
  getPlainText: (t: Token[] | undefined) => string;
}): React.ReactElement {
  const sep = '─'.repeat(Math.min(terminalWidth - 1, 60));
  const blocks: React.ReactElement[] = [];
  // Cap the rendered row count. A 200-row table in vertical layout produces
  // 200+ separator lines and 1000+ key:value rows — visually a wall of
  // dashes that hides the rest of the conversation. Past the cap we keep
  // the first N rows and append a count-of-elided notice.
  const MAX_ROWS = 30;
  const elidedRows = token.rows.length > MAX_ROWS ? token.rows.length - MAX_ROWS : 0;
  const rowsToRender = elidedRows > 0 ? token.rows.slice(0, MAX_ROWS) : token.rows;
  rowsToRender.forEach((row, ri) => {
    if (ri > 0) blocks.push(<Text key={`sep-${ri}`}>{sep}</Text>);
    row.forEach((cell, ci) => {
      const label = getPlainText(token.header[ci]?.tokens) || `Column ${ci + 1}`;
      const rawValue = formatCell(cell.tokens).trimEnd();
      const value = rawValue.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      const firstLineWidth = Math.max(10, terminalWidth - stringWidth(label) - 3);
      const subsequentLineWidth = Math.max(10, terminalWidth - 3);
      const firstPass = wrapText(value, firstLineWidth);
      const firstLine = firstPass[0] || '';
      let wrappedValue = firstPass;
      if (firstPass.length > 1 && subsequentLineWidth > firstLineWidth) {
        const remaining = firstPass.slice(1).map(l => l.trim()).join(' ');
        wrappedValue = [firstLine, ...wrapText(remaining, subsequentLineWidth)];
      }
      blocks.push(
        <Text key={`${ri}-${ci}-head`}>
          <Text bold>{label}:</Text> {wrappedValue[0] || ''}
        </Text>,
      );
      for (let i = 1; i < wrappedValue.length; i++) {
        blocks.push(<Text key={`${ri}-${ci}-ln-${i}`}>{`  ${wrappedValue[i]}`}</Text>);
      }
    });
  });
  if (elidedRows > 0) {
    blocks.push(<Text key="elided-sep">{sep}</Text>);
    blocks.push(<Text key="elided-note">{`… ${elidedRows} more rows elided (table had ${token.rows.length}; cap ${MAX_ROWS}) …`}</Text>);
  }
  return <Box flexDirection="column">{blocks}</Box>;
}
