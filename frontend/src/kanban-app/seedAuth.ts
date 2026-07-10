import { useAuthStore } from '@/store/auth';

export interface KanbanAuthUser {
  id?: string | number;
  email?: string;
  firstName?: string;
  lastName?: string;
  tenantId?: string;
  [key: string]: unknown;
}

export interface AuthSession {
  token: string;
  refreshToken?: string;
  user: KanbanAuthUser;
}

export function seedAuth(auth: AuthSession): void {
  try {
    localStorage.setItem('token', auth.token);
    if (auth.refreshToken) localStorage.setItem('refreshToken', auth.refreshToken);
    localStorage.setItem('user', JSON.stringify(auth.user));
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({
        state: { user: auth.user, token: auth.token, isAuthenticated: true },
        version: 0,
      }),
    );
    useAuthStore.setState({
      user: auth.user as never,
      token: auth.token,
      isAuthenticated: true,
    });
  } catch {
    // localStorage unavailable (sandboxed context)
  }
}

/** True when running inside the MakeStudio host iframe (web embed). */
export function isEmbeddedInHost(): boolean {
  return typeof window !== 'undefined' && window.self !== window.top;
}

let cachedHostOrigin: string | null | undefined;
function hostOrigin(): string | null {
  if (cachedHostOrigin !== undefined) return cachedHostOrigin;
  try {
    cachedHostOrigin = document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    cachedHostOrigin = null;
  }
  return cachedHostOrigin;
}

/**
 * Asks the MakeStudio host for a fresh account session via the same
 * `mks-kanban:sso-ready` / `mks-kanban:sso-session` postMessage handshake
 * used on initial load (see useHostAuthSync). Reusable for re-sync: the
 * axios 401 interceptor calls this instead of kanban's own /auth/refresh,
 * since the refreshToken relayed via SSO belongs to the host account and
 * kanban's refresh endpoint can never redeem it. No-op (resolves null)
 * when not embedded. Pings a couple times inside the window in case the
 * first postMessage lands before the host's listener is fully attached.
 */
export function requestHostSession(timeoutMs = 4000): Promise<AuthSession | null> {
  if (!isEmbeddedInHost()) return Promise.resolve(null);
  const origin = hostOrigin();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (session: AuthSession | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(ping);
      window.clearTimeout(timeout);
      resolve(session);
    };

    const onMessage = (ev: MessageEvent): void => {
      if (origin && ev.origin !== origin) return;
      const data = ev.data as { type?: string; session?: AuthSession | null } | null;
      if (data?.type !== 'mks-kanban:sso-session') return;
      finish(data.session ?? null);
    };
    window.addEventListener('message', onMessage);

    const ask = (): void => window.parent.postMessage({ type: 'mks-kanban:sso-ready' }, origin ?? '*');
    ask();
    const ping = window.setInterval(ask, 1200);
    const timeout = window.setTimeout(() => finish(null), timeoutMs);
  });
}
