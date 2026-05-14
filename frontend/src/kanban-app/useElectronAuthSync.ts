import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth';
import { seedAuth, AuthSession } from './seedAuth';

declare global {
  interface Window {
    kanbanDesktop?: {
      // Phase 1 — auth bridge
      getAuthSession(): Promise<AuthSession | null>;
      setAuthSession(session: AuthSession): Promise<void>;
      clearAuthSession(): Promise<void>;
      platform: string;
      // Phase 3 — native notifications
      notify(title: string, body: string): Promise<void>;
      setBadge(count: number): Promise<void>;
      // Phase 4 — deep links
      onNavigate(cb: (path: string) => void): () => void;
    };
  }
}

export function useElectronAuthSync(): { hydrated: boolean } {
  // If no Electron bridge, auth lives entirely in localStorage — start hydrated.
  const [hydrated, setHydrated] = useState(!window.kanbanDesktop);

  useEffect(() => {
    if (!window.kanbanDesktop) return;

    // Seed the auth store from the OS keychain on mount, then unlock rendering.
    window.kanbanDesktop
      .getAuthSession()
      .then((session) => {
        if (session) seedAuth(session);
      })
      .finally(() => {
        setHydrated(true);
      });

    // Keep keychain in sync as the user logs in/out inside the renderer.
    const unsubscribe = useAuthStore.subscribe((state, prev) => {
      if (!window.kanbanDesktop) return;
      if (state.isAuthenticated && !prev.isAuthenticated) {
        const session: AuthSession = {
          token: state.token!,
          refreshToken: localStorage.getItem('refreshToken') ?? undefined,
          user: state.user as AuthSession['user'],
        };
        window.kanbanDesktop.setAuthSession(session).catch(console.error);
      } else if (!state.isAuthenticated && prev.isAuthenticated) {
        window.kanbanDesktop.clearAuthSession().catch(console.error);
      }
    });

    return unsubscribe;
  }, []);

  return { hydrated };
}
