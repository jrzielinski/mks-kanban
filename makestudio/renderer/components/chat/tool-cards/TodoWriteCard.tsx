import React from 'react';
import clsx from 'clsx';
import { ListChecks, Circle, CircleDot, CheckCircle2 } from 'lucide-react';
import type { TuiMessageDTO } from '@shared/types';
import { ToolHeader } from './ToolHeader';
import { CollapsibleToolShell } from './CollapsibleToolShell';

interface TodoItem {
  content: string;
  status?: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface Props {
  message: TuiMessageDTO;
}

export function TodoWriteCard({ message }: Props): React.ReactElement {
  const inp = (message.toolInput ?? {}) as Record<string, unknown>;
  const todos = Array.isArray(inp.todos) ? (inp.todos as TodoItem[]) : [];
  const done = todos.filter((t) => t.status === 'completed').length;

  const header = (
    <ToolHeader
      icon={ListChecks}
      name="TodoWrite"
      tone="primary"
      arg={
        <span className="text-dim-soft">
          {done}/{todos.length} concluídos
        </span>
      }
      durationMs={message.toolDurationMs}
      status={message.streaming ? 'running' : 'success'}
    />
  );

  const body =
    todos.length > 0 ? (
      <ul className="space-y-1 px-3 py-2">
        {todos.map((t, i) => {
          const status = t.status ?? 'pending';
          const Icon =
            status === 'completed'
              ? CheckCircle2
              : status === 'in_progress'
                ? CircleDot
                : Circle;
          const tone =
            status === 'completed'
              ? 'text-success'
              : status === 'in_progress'
                ? 'text-primary'
                : 'text-dim';
          const label =
            status === 'in_progress' && t.activeForm
              ? t.activeForm
              : t.content;
          return (
            <li
              key={i}
              className="flex items-start gap-2 text-[13px] leading-snug"
            >
              <Icon
                size={14}
                strokeWidth={2}
                className={clsx('mt-[2px] shrink-0', tone)}
              />
              <span
                className={clsx(
                  status === 'completed'
                    ? 'text-dim line-through'
                    : status === 'in_progress'
                      ? 'text-text'
                      : 'text-text-soft',
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    ) : null;

  return (
    <CollapsibleToolShell
      header={header}
      body={body}
      hasBody={todos.length > 0}
    />
  );
}
