import { useEffect, useState } from 'react';
import { seedAuth, AuthSession } from './seedAuth';

/**
 * SSO from the MakeStudio host (web mode — see KanbanIframeHost in
 * mks-code). Kanban is bundled with MakeStudio Code, not a standalone
 * product, so it must never show its own login when embedded: the host
 * pushes the account session via postMessage on iframe load, and again
 * whenever we ask for it (`mks-kanban:sso-ready`) to close the race where
 * the iframe finishes loading before the host's listener is attached.
 *
 * No-op outside an iframe (own tab, Electron) — hydrated starts true.
 */
export function useHostAuthSync(): { hydrated: boolean } {
  const isEmbedded = typeof window !== 'undefined' && window.self !== window.top;
  const [hydrated, setHydrated] = useState(!isEmbedded);

  useEffect(() => {
    if (!isEmbedded) return;

    // The host's origin, derived from document.referrer — used to reject
    // session messages from anywhere else. Falls back to accepting any
    // origin only when the referrer is unavailable (e.g. stripped by a
    // strict Referrer-Policy upstream).
    let hostOrigin: string | null = null;
    try {
      hostOrigin = document.referrer ? new URL(document.referrer).origin : null;
    } catch {
      hostOrigin = null;
    }

    const onMessage = (ev: MessageEvent): void => {
      if (hostOrigin && ev.origin !== hostOrigin) return;
      const data = ev.data as { type?: string; session?: AuthSession | null } | null;
      if (data?.type !== 'mks-kanban:sso-session') return;
      if (data.session) seedAuth(data.session);
      window.clearTimeout(timeout);
      setHydrated(true);
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'mks-kanban:sso-ready' }, hostOrigin ?? '*');

    // Fail open — an older host build or a page that frames us without
    // implementing the handshake shouldn't hang the spinner forever.
    const timeout = window.setTimeout(() => setHydrated(true), 4000);

    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeout);
    };
  }, [isEmbedded]);

  return { hydrated };
}
