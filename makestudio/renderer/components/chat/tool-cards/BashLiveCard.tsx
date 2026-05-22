import React from 'react';
import { Terminal } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader, type ToolStatus } from './ToolHeader';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface Props {
  message: TuiMessageDTO;
}

const MAX_LIVE_LINES = 8;

export function BashLiveCard({ message }: Props): React.ReactElement {
  const command = pickStr(message.toolInput, 'command');
  const firstLine = command.split('\n')[0] ?? '';
  const truncatedCmd =
    firstLine.length > 100 ? firstLine.slice(0, 97) + '…' : firstLine;

  const status: ToolStatus = message.streaming ? 'running' : 'success';

  const [now, setNow] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    if (!message.streaming || !message.startedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [message.streaming, message.startedAt]);

  const elapsedMs =
    message.streaming && message.startedAt
      ? now - message.startedAt
      : message.toolDurationMs;

  const liveLines = message.liveLines ?? [];
  const totalLive = message.totalLiveLines ?? liveLines.length;
  const doneOutput = !message.streaming ? splitOutput(message.toolOutput ?? '') : [];
  const lines = message.streaming
    ? liveLines.slice(-MAX_LIVE_LINES)
    : doneOutput;
  const hiddenAbove =
    message.streaming && totalLive > lines.length ? totalLive - lines.length : 0;

  const hasBody = lines.length > 0 || hiddenAbove > 0;
  // While streaming, default expanded so user can watch the live output.
  const defaultOpen = message.streaming === true;

  const header = (
    <ToolHeader
      icon={Terminal}
      name="$"
      tone="accent"
      arg={<span className="font-mono text-text-soft">{truncatedCmd}</span>}
      durationMs={elapsedMs}
      status={status}
    />
  );

  const body = hasBody ? (
    <pre className="max-h-72 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-snug text-dim-soft">
      {hiddenAbove > 0 && (
        <div className="text-dim/70">
          … {hiddenAbove} linha{hiddenAbove === 1 ? '' : 's'} acima
        </div>
      )}
      {lines.map((l, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">
          {l || ' '}
        </div>
      ))}
    </pre>
  ) : null;

  return (
    <CollapsibleToolShell
      header={header}
      body={body}
      hasBody={hasBody}
      defaultOpen={defaultOpen}
    />
  );
}

function pickStr(input: unknown, key: string): string {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return '';
}

function splitOutput(out: string): string[] {
  if (!out) return [];
  const lines = out.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
