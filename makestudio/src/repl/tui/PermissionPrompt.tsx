import * as React from 'react';
import { Box, Text, useInput } from 'ink';
import { consumePermissionResult, type PermissionPromptSpec } from './bridge';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { colors: themeColors } = require('../theme');

type Choice = { label: string; key: string; value: 'allow' | 'allow-session' | 'allow-rule' | 'deny' };

const OPTIONS: Choice[] = [
  { label: 'Allow once',          key: 'y', value: 'allow' },
  { label: 'Allow for session',   key: 's', value: 'allow-session' },
  { label: 'Always allow',        key: 'r', value: 'allow-rule' },
  { label: 'No, deny',            key: 'n', value: 'deny' },
];

export function PermissionPrompt({
  spec,
}: {
  spec: PermissionPromptSpec;
}): React.ReactElement {
  const palette = themeColors();
  const [idx, setIdx] = React.useState(0);

  useInput((input, key) => {
    if (key.upArrow) { setIdx((i) => (i - 1 + OPTIONS.length) % OPTIONS.length); return; }
    if (key.downArrow) { setIdx((i) => (i + 1) % OPTIONS.length); return; }
    if (key.return) { consumePermissionResult(OPTIONS[idx].value); return; }
    const k = (input || '').toLowerCase();
    if (key.escape || k === 'd') { consumePermissionResult('deny'); return; }
    const direct = OPTIONS.find((o) => o.key === k);
    if (direct) { consumePermissionResult(direct.value); return; }
  });

  const riskColor = (() => {
    const dangerous = ['Bash', 'shell_run', 'NotebookEdit'];
    const mutating = ['Edit', 'Write', 'MultiEdit', 'write_file', 'edit_file'];
    if (dangerous.includes(spec.toolName)) return palette.danger || 'red';
    if (mutating.includes(spec.toolName)) return palette.warning || 'yellow';
    return palette.primary || 'blue';
  })();

  const cols = process.stdout.columns || 80;
  const maxDiffLines = Math.max(12, (process.stdout.rows || 40) - 14);
  const diffLines = spec.diff ? spec.diff.split('\n').slice(0, maxDiffLines) : [];

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {/* Colored top rule */}
      <Text color={riskColor}>{'─'.repeat(Math.max(cols - 2, 10))}</Text>

      {/* Tool name + preview */}
      <Box marginTop={1}>
        <Text color={riskColor} bold>{spec.toolName}</Text>
        {spec.preview ? (
          <Text color={palette.primary}>{`  ${spec.preview}`}</Text>
        ) : null}
      </Box>

      {/* Destructive warning */}
      {spec.warning ? (
        <Box marginTop={1} paddingLeft={2}>
          <Text color={palette.warning || 'yellow'}>{`(!) ${spec.warning}`}</Text>
        </Box>
      ) : null}

      {/* Diff preview */}
      {diffLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {diffLines.map((ln, i) => {
            let color: string | undefined;
            if (ln.startsWith('+')) color = palette.success || 'green';
            else if (ln.startsWith('-')) color = palette.danger || 'red';
            else if (ln.startsWith('@')) color = palette.accent;
            return <Text key={i} color={color}>{ln}</Text>;
          })}
          {spec.diff && spec.diff.split('\n').length > maxDiffLines ? (
            <Text color={palette.dim}>{`… (${spec.diff.split('\n').length - maxDiffLines} more lines)`}</Text>
          ) : null}
        </Box>
      ) : null}

      {/* Arrow-navigable select — CC style */}
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const focused = i === idx;
          const isNo = opt.value === 'deny';
          const labelColor = focused
            ? (isNo ? palette.danger || 'red' : palette.primary || 'blue')
            : palette.text || 'white';
          return (
            <Box key={opt.value}>
              <Text color={focused ? riskColor : palette.dim}>{focused ? '❯ ' : '  '}</Text>
              <Text color={labelColor} bold={focused}>{opt.label}</Text>
              <Text color={palette.dim}>{`  ${opt.key}`}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
