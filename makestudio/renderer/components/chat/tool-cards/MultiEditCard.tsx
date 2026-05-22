import React from 'react';
import { Layers } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader, shortPath } from './ToolHeader';
import { DiffView } from './DiffView';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface EditOp {
  file_path?: string;
  filePath?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

interface Props {
  message: TuiMessageDTO;
}

export function MultiEditCard({ message }: Props): React.ReactElement {
  const inp = (message.toolInput ?? {}) as Record<string, unknown>;
  const sharedPath = String(inp.file_path ?? inp.filePath ?? '');
  const edits = Array.isArray(inp.edits) ? (inp.edits as EditOp[]) : [];

  const header = (
    <ToolHeader
      icon={Layers}
      name="MultiEdit"
      tone="warning"
      arg={
        <span className="font-mono text-primary">
          {sharedPath ? shortPath(sharedPath) : `${edits.length} arquivos`}
          <span className="ml-2 text-dim">
            ({edits.length} edição{edits.length === 1 ? '' : 'es'})
          </span>
        </span>
      }
      durationMs={message.toolDurationMs}
      status={message.streaming ? 'running' : 'success'}
    />
  );

  const body = (
    <div className="space-y-2 px-3 py-2">
      {edits.map((e, i) => {
        const path = String(e.file_path ?? e.filePath ?? sharedPath);
        return (
          <div
            key={i}
            className="rounded border border-border-subtle/60 bg-surface-1/40"
          >
            <div className="border-b border-border-subtle/60 bg-surface-2/40 px-2.5 py-1 font-mono text-[11.5px] text-primary">
              {shortPath(path) || `edit ${i + 1}`}
            </div>
            <DiffView
              oldValue={String(e.old_string ?? '')}
              newValue={String(e.new_string ?? '')}
            />
          </div>
        );
      })}
    </div>
  );

  return (
    <CollapsibleToolShell
      header={header}
      body={body}
      hasBody={edits.length > 0}
    />
  );
}
