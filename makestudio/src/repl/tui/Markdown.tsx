/**
 * Markdown.tsx
 *
 * Ported from Claude Code:
 *   ~/develop/claude-code/src/components/Markdown.tsx
 *
 * Lexes markdown into tokens, then builds an Ink tree:
 *   - Tables → <MarkdownTable> (React, width-aware)
 *   - Everything else → accumulated ANSI string → <Text>
 *
 * Paragraphs separated by `gap={1}` so blocks don't cram together.
 * <StreamingMarkdown> wraps this for the streaming case, splitting at the
 * last stable token boundary so the unstable final block re-parses on each
 * delta while everything before is memoized.
 */

import * as React from 'react';
import { Box, Text } from 'ink';
import type { Token, Tokens } from 'marked';
import {
  configureMarked,
  formatToken,
  stripPromptXMLTags,
  cachedLexer,
} from '../markdown';
import { MarkdownTable } from './MarkdownTable';

interface Props {
  children: string;
}

export function Markdown({ children }: Props): React.ReactElement {
  configureMarked();
  const elements = React.useMemo(() => {
    const tokens = cachedLexer(stripPromptXMLTags(children));
    const out: React.ReactNode[] = [];
    let nonTableBuf = '';
    const flush = () => {
      if (nonTableBuf) {
        // Trim trailing whitespace / newlines — tokens like `paragraph`
        // end with EOL so the joined string always has a dangling line.
        const text = nonTableBuf.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
        out.push(<Text key={out.length}>{text}</Text>);
        nonTableBuf = '';
      }
    };

    for (const token of tokens) {
      if (token.type === 'table') {
        flush();
        out.push(<MarkdownTable key={out.length} token={token as Tokens.Table} />);
      } else {
        nonTableBuf += formatToken(token, 0, null, null);
      }
    }
    flush();
    return out;
  }, [children]);

  return (
    <Box flexDirection="column">
      {elements.map((el, i) => (
        <Box key={i} marginTop={i === 0 ? 0 : 1}>
          {el as React.ReactElement}
        </Box>
      ))}
    </Box>
  );
}

/**
 * StreamingMarkdown — splits content at the last stable top-level block.
 * Stable prefix is memoized (never re-parses as the unstable suffix grows);
 * only the final block is re-lexed per delta.
 *
 * Ported from claude-code/src/components/Markdown.tsx.
 */
export function StreamingMarkdown({ children }: Props): React.ReactElement {
  configureMarked();
  const stripped = stripPromptXMLTags(children);
  const stablePrefixRef = React.useRef('');

  // Reset if text was replaced (shouldn't happen in practice, but defensive).
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = '';
  }

  const boundary = stablePrefixRef.current.length;
  const tokens = React.useMemo(
    () => cachedLexer(stripped.substring(boundary)),
    [stripped, boundary],
  );

  // Find last non-space token — that is the "still growing" block.
  let lastContentIdx = tokens.length - 1;
  while (lastContentIdx >= 0 && tokens[lastContentIdx].type === 'space') {
    lastContentIdx--;
  }
  let advance = 0;
  for (let i = 0; i < lastContentIdx; i++) {
    advance += (tokens[i] as any).raw.length;
  }
  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance);
  }
  const stablePrefix = stablePrefixRef.current;
  const unstableSuffix = stripped.substring(stablePrefix.length);

  return (
    <Box flexDirection="column">
      {stablePrefix ? <Markdown>{stablePrefix}</Markdown> : null}
      {unstableSuffix ? <Box marginTop={stablePrefix ? 1 : 0}><Markdown>{unstableSuffix}</Markdown></Box> : null}
    </Box>
  );
}
