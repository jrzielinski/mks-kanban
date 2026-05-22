import React from 'react';
import { GitBranch } from 'lucide-react';
import { subscribe } from '../ipc/client';
import * as CH from '@shared/channels';
import type { WorktreeDTO } from '@shared/types';

/**
 * Banner top quando o agent entrou num git worktree.
 *
 * Server-side: bridge.setWorktreeState chamado por enterWorktreeImpl /
 * exitWorktreeImpl em `advanced-tools.ts`; electron-bridge.ts subscreve
 * via onWorktreeChange e dispara EVT_WORKTREE com WorktreeDTO.
 */
export function WorktreeBanner(): React.ReactElement | null {
  const [info, setInfo] = React.useState<WorktreeDTO | null>(null);

  React.useEffect(() => {
    const off = subscribe<WorktreeDTO>(CH.EVT_WORKTREE, (payload) => {
      setInfo(payload && payload.active ? payload : null);
    });
    return off;
  }, []);

  if (!info || !info.active) return null;

  return (
    <div className="border-b border-success/40 bg-success/8 px-4 py-2">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <GitBranch size={14} strokeWidth={2.2} className="shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-success">
            Worktree ativo
            {info.branch && (
              <span className="ml-2 font-mono text-[11.5px] text-text-soft">
                {info.branch}
              </span>
            )}
          </div>
          {info.path && (
            <div className="truncate font-mono text-[11px] text-dim-soft">
              {info.path}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
