import { useEffect, useState } from 'react';
import { seedAuth, isEmbeddedInHost, requestHostSession } from './seedAuth';

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
  const isEmbedded = isEmbeddedInHost();
  const [hydrated, setHydrated] = useState(!isEmbedded);

  useEffect(() => {
    if (!isEmbedded) return;
    let cancelled = false;

    // Fail open — an older host build or a page that frames us without
    // implementing the handshake shouldn't hang the spinner forever.
    requestHostSession().then((session) => {
      if (cancelled) return;
      if (session) seedAuth(session);
      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, [isEmbedded]);

  return { hydrated };
}
