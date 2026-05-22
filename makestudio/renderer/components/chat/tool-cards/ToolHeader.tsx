import React from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export type ToolStatus = 'running' | 'success' | 'error';

interface Props {
  icon: LucideIcon;
  name: string;
  arg?: React.ReactNode;
  durationMs?: number;
  status?: ToolStatus;
  /** Tinta do nome (ex: warning para Edit, accent para Bash). */
  tone?: 'primary' | 'warning' | 'accent' | 'dim';
  rightSlot?: React.ReactNode;
}

const TONE_CLASS: Record<NonNullable<Props['tone']>, string> = {
  primary: 'text-primary',
  warning: 'text-warning',
  accent: 'text-secondary',
  dim: 'text-text-soft',
};

export function ToolHeader({
  icon: Icon,
  name,
  arg,
  durationMs,
  status,
  tone = 'primary',
  rightSlot,
}: Props): React.ReactElement {
  return (
    <div className="flex items-center gap-2 text-[12.5px]">
      <Icon size={12} strokeWidth={2} className="shrink-0 text-dim" />
      <span className={clsx('font-medium', TONE_CLASS[tone])}>{name}</span>
      {arg != null && (
        <span className="min-w-0 flex-1 truncate font-mono text-dim-soft">{arg}</span>
      )}
      {status === 'running' && (
        <span className="inline-flex items-center gap-1 text-primary/80">
          <span className="h-1.5 w-1.5 animate-pulse-fade rounded-full bg-primary" />
          <span>executando</span>
        </span>
      )}
      {status === 'success' && (
        <span className="inline-flex items-center gap-1 text-success/80">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          <span>ok</span>
        </span>
      )}
      {status === 'error' && (
        <span className="inline-flex items-center gap-1 text-danger">
          <span className="h-1.5 w-1.5 rounded-full bg-danger" />
          <span>erro</span>
        </span>
      )}
      {typeof durationMs === 'number' && (
        <span className="font-mono text-[11px] text-dim/70">
          {formatDuration(durationMs)}
        </span>
      )}
      {rightSlot}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m${rs}s`;
}

export function shortPath(p: string, cwd?: string): string {
  if (!p) return '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}
