import React from 'react';
import { Map } from 'lucide-react';
import { subscribe } from '../ipc/client';
import * as CH from '@shared/channels';
import type { PlanModeDTO } from '@shared/types';

/**
 * Banner top quando plan-mode está ativo.
 *
 * Server-side: bridge.setPlanModeState chamado por enterPlanModeImpl /
 * exitPlanModeImpl em `advanced-tools.ts`; electron-bridge.ts subscreve
 * via onPlanModeChange e dispara EVT_PLAN_MODE com PlanModeDTO.
 */
export function PlanModeBanner(): React.ReactElement | null {
  const [info, setInfo] = React.useState<PlanModeDTO | null>(null);

  React.useEffect(() => {
    const off = subscribe<PlanModeDTO>(CH.EVT_PLAN_MODE, (payload) => {
      setInfo(payload && payload.active ? payload : null);
    });
    return off;
  }, []);

  if (!info || !info.active) return null;

  return (
    <div className="border-b border-tertiary/40 bg-tertiary/8 px-4 py-2">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <Map size={14} strokeWidth={2.2} className="shrink-0 text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-tertiary">
            Plan mode — editor do plano
          </div>
          {info.planFilePath && (
            <div className="truncate font-mono text-[11px] text-dim-soft">
              {info.planFilePath}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
