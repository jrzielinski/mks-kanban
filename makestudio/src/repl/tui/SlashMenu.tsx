import * as React from 'react';
import { Box, Text } from 'ink';
import type { SlashCompletion } from './completions';

interface Props {
  items: SlashCompletion[];
  selectedIdx: number;
}

const SOURCE_LABEL: Record<SlashCompletion['source'], string> = {
  builtin: '',
  plugin: 'plugin',
  skill: 'skill',
  agent: 'agent',
};

const SOURCE_COLOR: Record<SlashCompletion['source'], string> = {
  builtin: '#64748B',
  plugin: '#a78bfa',
  skill: '#34d399',
  agent: '#f59e0b',
};

export function SlashMenu({ items, selectedIdx }: Props): React.ReactElement | null {
  if (items.length === 0) return null;

  const maxNameLen = Math.max(...items.map((i) => i.name.length));
  const namePad = Math.min(maxNameLen + 2, 28);

  return (
    <Box flexDirection="column" paddingX={1} marginTop={0}>
      {items.map((item, i) => {
        const selected = i === selectedIdx;
        const padded = item.name.padEnd(namePad, ' ');
        const tag = SOURCE_LABEL[item.source];
        return (
          <Box key={item.name}>
            <Text color={selected ? '#22D3EE' : '#9CA3AF'} bold={selected}>
              {selected ? '› ' : '  '}
            </Text>
            <Text color={selected ? '#22D3EE' : '#E5E7EB'} bold={selected}>
              {padded}
            </Text>
            <Text color={selected ? '#94A3B8' : '#6B7280'}>
              {item.description}
            </Text>
            {tag ? (
              <Text color={SOURCE_COLOR[item.source]}>{'  ' + tag}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
