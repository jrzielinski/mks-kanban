import React from 'react';
import { Search } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader, shortPath } from './ToolHeader';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface Props {
  message: TuiMessageDTO;
}

export function GrepCard({ message }: Props): React.ReactElement {
  const inp = (message.toolInput ?? {}) as Record<string, unknown>;
  const pattern = String(inp.pattern ?? '');
  const path = String(inp.path ?? '');
  const glob = String(inp.glob ?? '');

  const matches = parseGrepOutput(message.toolOutput ?? '');

  const header = (
    <ToolHeader
      icon={Search}
      name="Grep"
      tone="primary"
      arg={
        <span className="font-mono">
          <span className="text-primary">/{pattern}/</span>
          {path && <span className="ml-2 text-dim">in {shortPath(path)}</span>}
          {glob && <span className="ml-2 text-dim">·· {glob}</span>}
        </span>
      }
      durationMs={message.toolDurationMs}
      status={message.streaming ? 'running' : 'success'}
    />
  );

  const body =
    matches.length > 0 ? (
      <ul className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-snug">
        {matches.slice(0, 60).map((m, i) => (
          <li key={i} className="flex gap-2">
            <span className="shrink-0 text-secondary">{shortPath(m.path)}</span>
            {m.line != null && (
              <span className="shrink-0 text-dim/70">:{m.line}</span>
            )}
            {m.text && <span className="truncate text-dim-soft">{m.text}</span>}
          </li>
        ))}
        {matches.length > 60 && (
          <li className="mt-1 text-dim/70">
            … {matches.length - 60} matches adicionais
          </li>
        )}
      </ul>
    ) : null;

  return (
    <CollapsibleToolShell
      header={header}
      body={body}
      hasBody={matches.length > 0}
    />
  );
}

interface GrepMatch {
  path: string;
  line?: number;
  text?: string;
}

function parseGrepOutput(out: string): GrepMatch[] {
  if (!out) return [];
  const lines = out.split('\n').filter((l) => l.length > 0);
  const matches: GrepMatch[] = [];
  for (const l of lines) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    if (m) {
      matches.push({ path: m[1], line: Number(m[2]), text: m[3] });
    } else {
      matches.push({ path: l });
    }
  }
  return matches;
}
