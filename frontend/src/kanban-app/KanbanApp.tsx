import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { useAuthCheck } from '@/hooks/useAuthCheck';
import { useTheme } from '@/hooks/useTheme';
import { useElectronAuthSync } from './useElectronAuthSync';
import { useKanbanNotifications } from './useKanbanNotifications';
import { useDeepLink } from './useDeepLink';
import { UpdateBanner } from './UpdateBanner';
import { ConnectionBadge } from './ConnectionBadge';

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

const Spinner: React.FC = () => (
  <div className="flex h-screen items-center justify-center">
    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
  </div>
);

export const KanbanApp: React.FC = () => {
  const { isAuthenticated } = useAuthStore();
  const { hydrated } = useElectronAuthSync();
  useAuthCheck();
  useTheme();
  useKanbanNotifications();
  useDeepLink();

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
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </Suspense>
    </>
  );
};
