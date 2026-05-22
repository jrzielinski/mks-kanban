import React from 'react';
import { Wrench } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader } from './ToolHeader';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface Props {
  message: TuiMessageDTO;
}

export function GenericToolCard({ message }: Props): React.ReactElement {
  const compact = formatInputCompact(message.toolInput);
  const outputLines = (message.toolOutput ?? '')
    .split('\n')
    .filter((l, i, arr) => !(l === '' && i === arr.length - 1));

  const header = (
    <ToolHeader
      icon={Wrench}
      name={message.toolName ?? 'tool'}
      tone="dim"
      arg={
        compact ? (
          <span className="font-mono text-text-soft">{compact}</span>
        ) : undefined
      }
      durationMs={message.toolDurationMs}
      status={message.streaming ? 'running' : 'success'}
    />
  );

  const body =
    outputLines.length > 0 ? (
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-snug text-dim-soft">
        {outputLines.slice(0, 200).map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {l || ' '}
          </div>
        ))}
        {outputLines.length > 200 && (
          <div className="mt-1 text-dim/70">
            … {outputLines.length - 200} linhas adicionais
          </div>
        )}
      </pre>
    ) : null;

  return (
    <CollapsibleToolShell
      header={header}
      body={body}
      hasBody={outputLines.length > 0}
    />
  );
}

function formatInputCompact(input: unknown): string {
  if (typeof input === 'string') return truncate(input, 100);
  if (!input || typeof input !== 'object') return '';
  try {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return '';
    const firstStr = keys
      .map((k) => obj[k])
      .find((v) => typeof v === 'string' && (v as string).length > 0) as
      | string
      | undefined;
    if (firstStr) return truncate(firstStr, 100);
    return truncate(JSON.stringify(obj), 100);
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
