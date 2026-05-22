import * as React from 'react';
import { Box, Text, Static } from 'ink';
import { TuiMessage } from './types';
import { looksLikeMarkdown } from '../markdown';
import { Markdown, StreamingMarkdown } from './Markdown';
import { ReplContext } from '../context';
import { bashCardOutputRows } from './bash-card-render';
import { newPartitionState, partitionMessages, PartitionState } from './messagelist-partition';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { colors: themeColors } = require('../theme');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadSettings } = require('../settings');

const MessageItem = React.memo(MessageItemImpl, (prev, next) => {
  // Only re-render when something visible changes. liveLines / toolOutput /
  // toolDurationMs MUST be checked here — otherwise the BashLiveCard freezes
  // on its initial state because the parent rebuilds the array but this
  // memo short-circuits the per-message render.
  if (prev.m === next.m) return true;
  if (prev.m.id !== next.m.id) return false;
  if (prev.m.text !== next.m.text) return false;
  if (prev.m.streaming !== next.m.streaming) return false;
  if (prev.m.liveLines !== next.m.liveLines) return false;
  if (prev.m.totalLiveLines !== next.m.totalLiveLines) return false;
  if (prev.m.toolOutput !== next.m.toolOutput) return false;
  if (prev.m.toolDurationMs !== next.m.toolDurationMs) return false;
  return true;
});

function BashLiveCard({ m }: { m: TuiMessage }): React.ReactElement {
  const palette = themeColors();
  // Tick the elapsed timer only while streaming. After completion the
  // displayed duration is frozen at toolDurationMs.
  const isStreaming = m.streaming === true;
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!isStreaming) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [isStreaming]);

  const cmd = String(m.toolInput?.command || '').trim();
  const firstLine = cmd.split('\n')[0] || '';
  const displayCmd = firstLine.length > 80 ? firstLine.slice(0, 77) + '\u2026' : firstLine;
  const lines: string[] = m.liveLines || [];
  const total: number = m.totalLiveLines ?? lines.length;
  const durationStr = (() => {
    if (isStreaming && m.startedAt) {
      const elapsed = Math.floor((now - m.startedAt) / 1000);
      return elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
    }
    if (m.toolDurationMs !== undefined) {
      const ms = m.toolDurationMs;
      if (ms < 1000) return `${ms}ms`;
      const s = Math.floor(ms / 1000);
      return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
    }
    return '';
  })();
  // Exit-status hint after completion (extracted from toolOutput's first line).
  // Exits != 0 get coloured red so the operator can spot failures while
  // scrolling \u2014 matches the Claude Code "$ cmd ... exit 1" style.
  const exitInfo: { code: number | null; failed: boolean } = (() => {
    if (isStreaming) return { code: null, failed: false };
    const out = String(m.toolOutput || '');
    const m1 = out.match(/^exit:\s*(-?\d+)/);
    if (!m1) return { code: null, failed: false };
    const code = parseInt(m1[1]!, 10);
    return { code, failed: code !== 0 };
  })();

  const output = bashCardOutputRows({ isStreaming, liveLines: lines, totalLiveLines: total });
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={exitInfo.failed ? (palette.error || 'red') : (palette.accent || 'cyan')} bold>{'$'}</Text>
        <Text>{' ' + displayCmd}</Text>
        {durationStr ? <Text color={palette.dim}>{`  ${durationStr}`}</Text> : null}
        {exitInfo.failed ? <Text color={palette.error || 'red'}>{`  exit ${exitInfo.code}`}</Text> : null}
        {isStreaming ? <Text color={palette.dim}>{'  \u2026'}</Text> : null}
      </Box>
      {output && output.lines.map((l, i) => (
        <Box key={i} marginLeft={3}>
          <Text color={palette.dim}>{l.length > 160 ? l.slice(0, 157) + '\u2026' : l}</Text>
        </Box>
      ))}
      {output && output.moreCount > 0 ? (
        <Box marginLeft={3}>
          <Text color={palette.dim}>{`+${output.moreCount} more lines`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function MessageItemImpl({ m }: { m: TuiMessage }): React.ReactElement {
  const palette = themeColors();
  if (m.role === 'user') {
    // Render markdown for user messages too. Most user input is short and
    // plain — but when a slash-skill expands into a multi-KB body, or a
    // user pastes a markdown table/code block, raw rendering looks like
    // garbage. The Markdown component handles plain text just fine, so
    // routing all user content through it is safe.
    const useMd = looksLikeMarkdown(m.text);
    return (
      <Box flexDirection="row">
        <Text color={palette.primary} bold>{'> '}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {useMd ? <Markdown>{m.text}</Markdown> : <Text>{m.text}</Text>}
        </Box>
      </Box>
    );
  }

  if (m.role === 'assistant') {
    // Don't render empty assistant messages — they are loop-start placeholders
    // that never accumulated text (model went straight to a tool call).
    if (!m.streaming && !m.text.trim()) return <></>;
    if (m.streaming) {
      // When verbose=off: render ONLY the cursor — no text in the live area.
      // Streaming text rendered here can leak into scrollback (lines that were
      // in the dynamic area before Ink's cursor-up erasure get committed when
      // they scroll past the viewport). The full text appears in <Static> once
      // streaming completes, so nothing is lost.
      // When verbose=on: show up to MAX_STREAMING_LINES for live preview.
      const verboseMode = loadSettings().verbose ?? false;
      if (!verboseMode) {
        return (
          <Box flexDirection="row">
            <Text color={palette.primary}>{'⏺ '}</Text>
            <Text>{'▌'}</Text>
          </Box>
        );
      }
      // Verbose: show completed lines only (no partial line at the cut).
      const lastNl = m.text.lastIndexOf('\n');
      const stable = lastNl >= 0 ? m.text.slice(0, lastNl) : '';
      const lines = stable.split('\n');
      const MAX_STREAMING_LINES = 14;
      const shown = lines.length > MAX_STREAMING_LINES
        ? `[${lines.length - MAX_STREAMING_LINES} earlier line(s) above]\n` +
          lines.slice(-MAX_STREAMING_LINES).join('\n')
        : stable;
      return (
        <Box flexDirection="row">
          <Text color={palette.primary}>{'⏺ '}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {shown
              ? <StreamingMarkdown>{shown}</StreamingMarkdown>
              : <Text>{''}</Text>}
            <Text>{'▌'}</Text>
          </Box>
        </Box>
      );
    }
    // Resumed messages are already ANSI-rendered at hydration — the
    // <Markdown> component's Box layout misbehaves inside <Static>, so we
    // skip it and emit the pre-baked string as raw <Text>.
    if (m.preRendered) {
      return (
        <Box flexDirection="row">
          <Text color={palette.primary}>{'⏺ '}</Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text>{m.text}</Text>
          </Box>
        </Box>
      );
    }
    const useMd = looksLikeMarkdown(m.text);
    return (
      <Box flexDirection="row">
        <Text color={palette.primary}>{'⏺ '}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {useMd ? <Markdown>{m.text}</Markdown> : <Text>{m.text}</Text>}
        </Box>
      </Box>
    );
  }

  // Live streaming Bash card — shown in dynamic area with elapsed timer
  if (m.role === 'tool' && m.streaming) {
    return <BashLiveCard m={m} />;
  }

  // Completed Bash also rendered via BashLiveCard so the command + tail of
  // output stays visible (Claude Code style). The card knows how to show
  // both states because of the `streaming` flag.
  if (
    m.role === 'tool' &&
    !m.streaming &&
    (m.toolName === 'Bash' || m.toolName === 'shell_run') &&
    m.startedAt !== undefined
  ) {
    return <BashLiveCard m={m} />;
  }

  if (m.role === 'tool') {
    const verbose = loadSettings().verbose ?? false;
    const name = m.toolName || '';
    const inp = m.toolInput || {};
    const isEdit = name === 'Edit' || name === 'MultiEdit' || name === 'Write';
    const isBash = name === 'Bash' || name === 'shell_run';
    const isRead = name === 'Read';

    // ── Compact ⎿ header arg ─────────────────────────────────────────
    const compactArg = (() => {
      const fp = String(inp.file_path || inp.filePath || inp.notebook_path || '');
      const shortFp = fp ? fp.replace(process.cwd() + '/', '') : '';
      if (isRead) return shortFp || '(path missing — model emitted incomplete input)';
      if (isEdit) {
        // Loud signal when the model emitted a tool_use header without
        // args (truncated stream, broken JSON, etc.) so the user
        // doesn't see a bare "Write" line and assume the agent froze.
        if (!fp && inp.content === undefined && (!Array.isArray(inp.edits) || inp.edits.length === 0)) {
          return '(input incomplete — model emitted tool_use header without args)';
        }
        const suffix = name === 'MultiEdit' && Array.isArray(inp.edits)
          ? ` (${inp.edits.length} edit${inp.edits.length === 1 ? '' : 's'})` : '';
        return shortFp + suffix;
      }
      if (isBash) {
        const cmd = String(inp.command || '').trim();
        const first = cmd.split('\n')[0] || '';
        return first.length > 80 ? first.slice(0, 77) + '\u2026' : first;
      }
      if (name === 'Glob') return String(inp.pattern || '');
      if (name === 'Grep') {
        const pat = String(inp.pattern || '');
        const inPath = inp.path ? ` in ${inp.path}` : '';
        return pat.length > 50 ? pat.slice(0, 47) + '\u2026' + inPath : pat + inPath;
      }
      if (name === 'TodoWrite') {
        const todos = Array.isArray(inp.todos) ? inp.todos : [];
        return `(${todos.length} item${todos.length === 1 ? '' : 's'})`;
      }
      const firstStr = Object.values(inp).find(
        (v) => typeof v === 'string' && (v as string).length > 0,
      ) as string | undefined;
      return firstStr ? firstStr.slice(0, 60) : '';
    })();

    const labelColor = isEdit
      ? (palette.warning || 'yellow')
      : isBash
        ? (palette.accent || 'cyan')
        : (palette.primary || 'cyan');

    const durationSuffix = m.toolDurationMs !== undefined
      ? <Text color={palette.dim}>{`  ${m.toolDurationMs}ms`}</Text>
      : null;

    const headerLine = (
      <Box>
        <Text color={palette.dim}>{'⎿  '}</Text>
        <Text color={labelColor} bold={isBash || isEdit}>{isBash ? '$' : name}</Text>
        {compactArg ? <Text color={isEdit ? (palette.primary || 'cyan') : undefined}>{' ' + compactArg}</Text> : null}
        {durationSuffix}
      </Box>
    );

    // ── Output lines with ⎿ prefix (Claude Code style) ───────────────
    const rawOutput = m.toolOutput || '';
    const allOutLines = rawOutput
      ? rawOutput.split('\n').filter((l, i, arr) => !(l === '' && i === arr.length - 1))
      : [];
    // Compact mode caps output at 4 lines per tool — the user sees
    // ENOUGH to know what happened ("1474 .ts files", "Edit ok", etc.)
    // without the screen filling up with 12-line blocks for every find
    // / Read / Glob. Verbose mode (toggle via /verbose) keeps the
    // 30-line preview for deep debugging.
    const MAX_OUT_LINES = verbose ? 30 : 4;
    const shownOutLines = allOutLines.slice(0, MAX_OUT_LINES);
    const hiddenOutCount = allOutLines.length - shownOutLines.length;

    const renderOutLine = (l: string, i: number) => (
      <Box key={i}>
        <Text color={palette.dim}>{'⎿  ' + (l.length > 160 ? l.slice(0, 157) + '\u2026' : l)}</Text>
      </Box>
    );

    const outputBlock = shownOutLines.length > 0 ? (
      <Box flexDirection="column">
        {shownOutLines.map(renderOutLine)}
        {hiddenOutCount > 0 ? (
          <Box>
            <Text color={palette.dim}>{`⎿  \u2026 ${hiddenOutCount} more line${hiddenOutCount === 1 ? '' : 's'}`}</Text>
          </Box>
        ) : null}
      </Box>
    ) : null;

    // ── Edit/Write: diff block ────────────────────────────────────────
    const buildDiffBlock = () => {
      const diffLines: Array<{ text: string; color?: string }> = [];
      if (name === 'Edit' && (inp.old_string !== undefined || inp.new_string !== undefined)) {
        const oldLines = String(inp.old_string ?? '').split('\n').slice(0, 8);
        const newLines = String(inp.new_string ?? '').split('\n').slice(0, 8);
        for (const l of oldLines) diffLines.push({ text: '- ' + l, color: palette.danger || 'red' });
        for (const l of newLines) diffLines.push({ text: '+ ' + l, color: palette.success || 'green' });
      } else if (name === 'Write' && inp.content !== undefined) {
        const contentLines = String(inp.content).split('\n');
        for (const l of contentLines.slice(0, 10)) diffLines.push({ text: '+ ' + l, color: palette.success || 'green' });
        if (contentLines.length > 10)
          diffLines.push({ text: `  \u2026 (${contentLines.length - 10} more lines)`, color: palette.dim });
      } else if (name === 'MultiEdit' && Array.isArray(inp.edits)) {
        const n = inp.edits.length;
        for (const e of (inp.edits as any[]).slice(0, 6)) {
          const fp2 = String(e.file_path || e.filePath || '').replace(process.cwd() + '/', '');
          diffLines.push({ text: `  ${fp2}`, color: palette.primary });
          const ol = String(e.old_string ?? '').split('\n').slice(0, 3);
          const nl = String(e.new_string ?? '').split('\n').slice(0, 3);
          for (const l of ol) diffLines.push({ text: '  - ' + l, color: palette.danger || 'red' });
          for (const l of nl) diffLines.push({ text: '  + ' + l, color: palette.success || 'green' });
        }
        if (n > 6) diffLines.push({ text: `  \u2026 (${n - 6} more edits)`, color: palette.dim });
      }
      return diffLines;
    };

    // ── Render ───────────────────────────────────────────────────────
    if (isEdit) {
      const diffLines = buildDiffBlock();
      return (
        <Box flexDirection="column">
          {headerLine}
          {diffLines.map((d, i) => (
            <Box key={i} marginLeft={2}>
              <Text color={d.color}>{d.text}</Text>
            </Box>
          ))}
        </Box>
      );
    }

    if (isBash) {
      // In verbose mode also show multi-line command body
      const cmdLines = verbose ? String(inp.command || '').trim().split('\n').slice(1) : [];
      return (
        <Box flexDirection="column">
          {headerLine}
          {cmdLines.slice(0, 4).map((l, i) => (
            <Box key={i} marginLeft={2}>
              <Text color={palette.dim}>{l.length > 100 ? l.slice(0, 97) + '\u2026' : l}</Text>
            </Box>
          ))}
          {cmdLines.length > 4 ? (
            <Box marginLeft={2}>
              <Text color={palette.dim}>{`\u2026 (${cmdLines.length - 4} more lines)`}</Text>
            </Box>
          ) : null}
          {outputBlock}
        </Box>
      );
    }

    // Generic tool: header + output lines
    return (
      <Box flexDirection="column">
        {headerLine}
        {outputBlock}
      </Box>
    );
  }

  if (m.role === 'error') {
    return (
      <Box>
        <Text color={palette.danger}>! </Text>
        <Text color={palette.danger}>{m.text}</Text>
      </Box>
    );
  }

  if (m.role === 'info') {
    return (
      <Box>
        <Text>{m.text}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="gray">{m.text}</Text>
    </Box>
  );
}

/**
 * MessageList — all messages rendered as normal dynamic components.
 * Memoized so a parent re-render (e.g. keystroke in InputBox) doesn't walk
 * the message list when nothing changed.
 */
interface MessageListProps {
  messages: TuiMessage[];
  ctx: ReplContext;
  cols: number;
}

function MessageListImpl({ messages }: MessageListProps): React.ReactElement {
  // Split into "finalized" and "live" messages:
  //  - Finalized messages go into Ink's <Static> → printed ONCE to
  //    scrollback and never repainted. This is what stops the flicker.
  //  - Live (streaming) messages stay in the dynamic area and repaint
  //    normally until they complete.
  // Welcome banner is printed directly to stdout before Ink mounts.
  //
  // Pure partition handles the Ink 3 <Static> scrollback-dup race
  // (see messagelist-partition.ts for the why). Append-only finalized
  // buffer means item refs at index i are stable across renders, so
  // even if Static's lagging index re-slices already-printed cards,
  // Ink's child-equality diff skips the write.
  const verbose = loadSettings().verbose ?? false;
  const stateRef = React.useRef<PartitionState>(newPartitionState());
  const { live, finalized } = partitionMessages(messages, stateRef.current, verbose);

  return (
    <>
      <Static items={finalized}>
        {(m, i) => {
          // Top margin: 0 between consecutive tool cards (they're a
          // single logical unit — investigation steps stack visually).
          // 1 line whenever role changes or it's the first item.
          // Stops the screen from feeling air-padded after a 6-tool
          // batch.
          const prev = finalized[i - 1];
          const isToolFollowingTool = i > 0 && prev?.role === 'tool' && m.role === 'tool';
          const mt = i === 0 ? 0 : (isToolFollowingTool ? 0 : 1);
          return (
            <Box key={m.id} flexDirection="column" marginTop={mt}>
              <MessageItem m={m} />
            </Box>
          );
        }}
      </Static>
      {live.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {live.map((m, i) => {
            const prev = live[i - 1];
            const isToolFollowingTool = i > 0 && prev?.role === 'tool' && m.role === 'tool';
            const mt = i === 0 ? 0 : (isToolFollowingTool ? 0 : 1);
            return (
              <Box key={m.id} flexDirection="column" marginTop={mt}>
                <MessageItem m={m} />
              </Box>
            );
          })}
        </Box>
      ) : null}
    </>
  );
}

export const MessageList = React.memo(MessageListImpl, (prev, next) => {
  if (prev.ctx !== next.ctx) return false;
  if (prev.cols !== next.cols) return false;
  if (prev.messages === next.messages) return true;
  if (prev.messages.length !== next.messages.length) return false;
  // Same length — check if any item identity/streaming/liveLines changed
  for (let i = 0; i < prev.messages.length; i++) {
    const a = prev.messages[i];
    const b = next.messages[i];
    if (a.id !== b.id || a.text !== b.text || a.streaming !== b.streaming) return false;
    if (a.liveLines !== b.liveLines) return false;
  }
  return true;
});
