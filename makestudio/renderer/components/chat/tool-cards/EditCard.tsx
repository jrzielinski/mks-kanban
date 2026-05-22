import React from 'react';
import { Pencil } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader, shortPath } from './ToolHeader';
import { DiffView } from './DiffView';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface Props {
  message: TuiMessageDTO;
}

export function EditCard({ message }: Props): React.ReactElement {
  const inp = (message.toolInput ?? {}) as Record<string, unknown>;
  const filePath = String(inp.file_path ?? inp.filePath ?? '');
  const oldStr = String(inp.old_string ?? '');
  const newStr = String(inp.new_string ?? '');
  const replaceAll = Boolean(inp.replace_all);

  const header = (
    <ToolHeader
      icon={Pencil}
      name="Edit"
      tone="warning"
      arg={
        <span className="font-mono text-primary">
          {shortPath(filePath)}
          {replaceAll && <span className="ml-2 text-dim">replace_all</span>}
        </span>
      }
      durationMs={message.toolDurationMs}
      status={message.streaming ? 'running' : 'success'}
    />
  );

  const body = (
    <div className="overflow-hidden">
      <DiffView oldValue={oldStr} newValue={newStr} />
    </div>
  );

  return <CollapsibleToolShell header={header} body={body} />;
}
