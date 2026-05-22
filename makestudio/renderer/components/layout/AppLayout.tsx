import React from 'react';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { StudioTabBar } from './StudioTabBar';
import { PickerModal } from '../../overlays/PickerModal';
import { PermissionModal } from '../../overlays/PermissionModal';
import { QuestionBanner } from '../../overlays/QuestionBanner';
import { Toasts } from '../../overlays/Toasts';
import { TransientStatus } from '../../overlays/TransientStatus';
import { PlanModeBanner } from '../../overlays/PlanModeBanner';
import { WorktreeBanner } from '../../overlays/WorktreeBanner';

interface Props {
  children: React.ReactNode;
}

export function AppLayout({ children }: Props): React.ReactElement {
  return (
    <div className="flex h-full w-full flex-col bg-surface-0">

      {/* Tab bar (40px fixo no topo) — fica ACIMA da BrowserView do kanban */}
      <StudioTabBar />

      {/* Conteúdo MakeStudio — ocupa o resto da altura */}
      <div className="flex min-h-0 flex-1 w-full">
        <nav aria-label="Navegação principal" className="flex h-full flex-col">
          <Sidebar />
        </nav>
        <div className="flex min-h-0 flex-1 flex-col">
          <TitleBar />
          <PlanModeBanner />
          <WorktreeBanner />
          <main
            id="main-content"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            aria-live="polite"
            aria-atomic="false"
          >
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="route-in h-full">{children}</div>
            </div>
            <StatusBar />
          </main>
        </div>
      </div>

      {/* Overlays globais — fora do flex para não afetar layout */}
      <PickerModal />
      <PermissionModal />
      <QuestionBanner />
      <TransientStatus />
      <Toasts />
    </div>
  );
}
