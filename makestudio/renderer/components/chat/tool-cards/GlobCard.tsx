import React from 'react';
import { FolderSearch } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader, shortPath } from './ToolHeader';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface Props {
  message: TuiMessageDTO;
}

export function GlobCard({ message }: Props): React.ReactElement {
  const inp = (message.toolInput ?? {}) as Record<string, unknown>;
  const pattern = String(inp.pattern ?? '');
  const path = String(inp.path ?? '');

  const paths = (message.toolOutput ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const header = (
    <ToolHeader
      icon={FolderSearch}
      name="Glob"
      tone="primary"
      arg={
        <span className="font-mono">
          <span className="text-primary">{pattern}</span>
          {path && (
            <span className="ml-2 text-dim">in {shortPath(path)}</span>
          )}
          <span className="ml-2 text-dim">
            ({paths.length} arquivo{paths.length === 1 ? '' : 's'})
          </span>
        </span>
      }
      durationMs={message.toolDurationMs}
      status={message.streaming ? 'running' : 'success'}
    />
  );

  const body =
    paths.length > 0 ? (
      <ul className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-snug text-dim-soft">
        {paths.slice(0, 80).map((p, i) => (
          <li key={i} className="truncate">
            {shortPath(p)}
          </li>
        ))}
        {paths.length > 80 && (
          <li className="mt-1 text-dim/70">
            … {paths.length - 80} arquivos adicionais
          </li>
        )}
      </ul>
    ) : null;

  return (
    <CollapsibleToolShell
      header={header}
      body={body}
      hasBody={paths.length > 0}
    />
  );
}
