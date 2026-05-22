import React from 'react';
import { FileText } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader, shortPath } from './ToolHeader';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface Props {
  message: TuiMessageDTO;
}

export function ReadCard({ message }: Props): React.ReactElement {
  const inp = (message.toolInput ?? {}) as Record<string, unknown>;
  const filePath = String(inp.file_path ?? inp.filePath ?? '');
  const offset = typeof inp.offset === 'number' ? (inp.offset as number) : undefined;
  const limit = typeof inp.limit === 'number' ? (inp.limit as number) : undefined;
  const range =
    offset != null
      ? ` L${offset + 1}-${offset + (limit ?? 0)}`
      : limit != null
        ? ` (limite ${limit})`
        : '';

  const allLines = (message.toolOutput ?? '').split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

  const hasOutput = allLines.length > 0;

  const header = (
    <ToolHeader
      icon={FileText}
      name="Read"
      tone="primary"
      arg={
        <span className="font-mono text-text-soft">
          {shortPath(filePath)}
          {range && <span className="text-dim">{range}</span>}
        </span>
      }
      durationMs={message.toolDurationMs}
      status={message.streaming ? 'running' : 'success'}
    />
  );

  const body = hasOutput ? (
    <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-snug text-dim-soft">
      {allLines.map((l, i) => (
        <div key={i} className="whitespace-pre">
          {l || ' '}
        </div>
      ))}
    </pre>
  ) : null;

  return (
    <CollapsibleToolShell
      header={header}
      body={body}
      hasBody={hasOutput}
    />
  );
}
