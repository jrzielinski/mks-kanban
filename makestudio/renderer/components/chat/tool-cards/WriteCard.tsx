import React from 'react';
import { FilePlus } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader, shortPath } from './ToolHeader';
import { DiffView } from './DiffView';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface Props {
  message: TuiMessageDTO;
}

export function WriteCard({ message }: Props): React.ReactElement {
  const inp = (message.toolInput ?? {}) as Record<string, unknown>;
  const filePath = String(inp.file_path ?? inp.filePath ?? '');
  const content = String(inp.content ?? '');
  const lineCount = content ? content.split('\n').length : 0;

  const header = (
    <ToolHeader
      icon={FilePlus}
      name="Write"
      tone="warning"
      arg={
        <span className="font-mono text-primary">
          {shortPath(filePath)}{' '}
          <span className="text-dim">
            ({lineCount} linha{lineCount === 1 ? '' : 's'})
          </span>
        </span>
      }
      durationMs={message.toolDurationMs}
      status={message.streaming ? 'running' : 'success'}
    />
  );

  const body = (
    <div className="overflow-hidden">
      <DiffView oldValue="" newValue={content} />
    </div>
  );

  return <CollapsibleToolShell header={header} body={body} />;
}
