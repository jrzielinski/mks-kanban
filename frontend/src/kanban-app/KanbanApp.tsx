import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { useAuthCheck } from '@/hooks/useAuthCheck';
import { useTheme, applyThemeName, type ThemeName } from '@/hooks/useTheme';
import { useElectronAuthSync } from './useElectronAuthSync';
import { useWebAuthSync } from './useWebAuthSync';
import { isEmbedded } from './webSso';
import { useKanbanNotifications } from './useKanbanNotifications';
import { useDeepLink } from './useDeepLink';
import { UpdateBanner } from './UpdateBanner';
import { ConnectionBadge } from './ConnectionBadge';
import { AgentTerminal } from './AgentTerminal';
import { AgentWindow } from './AgentWindow';

const Login = lazy(() =>
  import('@/pages/auth/Login').then((m) => ({ default: (m as any).Login ?? (m as any).default })),
);
const Register = lazy(() =>
  import('@/pages/auth/Register').then((m) => ({
    default: (m as any).Register ?? (m as any).default,
  })),
);
const KanbanBoardsPage = lazy(() =>
  import('@/pages/KanbanBoardsPage').then((m) => ({
    default: (m as any).KanbanBoardsPage ?? (m as any).default,
  })),
);
const KanbanBoardPage = lazy(() =>
  import('@/pages/KanbanBoardPage').then((m) => ({
    default: (m as any).KanbanBoardPage ?? (m as any).default,
  })),
);
const ProfilePage = lazy(() =>
  import('@/pages/ProfilePage').then((m) => ({
    default: (m as any).ProfilePage ?? (m as any).default,
  })),
);

const Spinner: React.FC = () => (
  <div className="flex h-screen items-center justify-center">
    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
  </div>
);

export const KanbanApp: React.FC = () => {
  const { isAuthenticated } = useAuthStore();
  const { hydrated: hydratedDesktop } = useElectronAuthSync();
  const { hydrated: hydratedWeb } = useWebAuthSync();
  // Render só libera quando AMBOS resolveram: keychain do Electron (desktop)
  // e o handshake SSO do iframe (web). Em cada modo, o outro começa true.
  const hydrated = hydratedDesktop && hydratedWeb;
  useAuthCheck();
  useTheme();
  // Pré-auth (login/register) SEMPRE no tema claude. Declarado DEPOIS do
  // useTheme() de propósito: efeitos do MESMO componente rodam em ordem de
  // declaração, então este vence o tema salvo. (Forçar dentro do Login não
  // funciona: efeito de filho roda ANTES do efeito do pai no mount inicial,
  // e o useTheme() daqui re-aplicava o tema escuro por cima.)
  React.useEffect(() => {
    if (isEmbedded()) return; // embarcado segue o tema do host
    if (!isAuthenticated) {
      applyThemeName('claude');
    } else {
      let saved: ThemeName = 'padrao';
      try {
        const v = localStorage.getItem('makestudio:theme') as ThemeName | null;
        if (v) saved = v;
      } catch { /* localStorage indisponível */ }
      applyThemeName(saved);
    }
  }, [isAuthenticated]);
  useKanbanNotifications();
  useDeepLink();

  // Standalone MakeStudio Code window (desktop shell loads it with ?view=agent).
  // Renders only the agent terminal — no auth/board needed, it talks to the
  // agent over IPC directly.
  const isAgentWindow =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('view') === 'agent';
  if (isAgentWindow) return <AgentWindow />;

  // Block rendering until the OS keychain has been read (Electron only).
  // In the browser, hydrated starts true so there's no delay.
  if (!hydrated) return <Spinner />;

  const home = isAuthenticated ? '/kanban' : '/login';

  return (
    <>
      <UpdateBanner />
      <ConnectionBadge />
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route
            path="/login"
            element={isAuthenticated ? <Navigate to="/kanban" replace /> : <Login />}
          />
          <Route
            path="/register"
            element={isAuthenticated ? <Navigate to="/kanban" replace /> : <Register />}
          />
          <Route
            path="/kanban"
            element={isAuthenticated ? <KanbanBoardsPage /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/kanban/:boardId"
            element={isAuthenticated ? <KanbanBoardPage /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/profile"
            element={isAuthenticated ? <ProfilePage /> : <Navigate to="/login" replace />}
          />
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </Suspense>
      {/* O launcher "MakeStudio Code" só faz sentido no app desktop (kanbanDesktop).
          Embarcado no MakeStudio Code web ele é redundante (e o TUI só roda no
          desktop), então some no iframe. */}
      {isAuthenticated && !isEmbedded() && <AgentTerminal />}
    </>
  );
};
