import { seedAuth, AuthSession } from './seedAuth';

/**
 * webSso.ts — SSO quando o kanban roda DENTRO de um <iframe> no MakeStudio
 * web (modo "Kanban" da plataforma). Não existe o bridge Electron
 * (window.kanbanDesktop), então a sessão da conta chega via postMessage do
 * parent: postamos `sso-ready`, o parent responde `sso-session` com o JWT da
 * conta MakeStudio (gptapi), e semeamos como se fosse login local. O backend
 * do kanban valida esse JWT (HS256, LOCAL_JWT_SECRET alinhado ao gptapi) e
 * confia nos claims (tenantId/role) — sem segundo login.
 */
export const SSO_READY = 'mks-kanban:sso-ready';
export const SSO_SESSION = 'mks-kanban:sso-session';

/** Embarcado por iframe (web) e SEM o bridge Electron. */
export function isEmbedded(): boolean {
  return (
    typeof window !== 'undefined' &&
    !(window as { kanbanDesktop?: unknown }).kanbanDesktop &&
    window.parent !== window
  );
}

/** Semeia a sessão recebida do parent. Retorna true se veio token. */
export function applySession(session: AuthSession | null): boolean {
  if (!session?.token) return false;
  seedAuth(session);
  // O tenant vem do token (claim), não do hostname (kanban.*) — senão o
  // X-Tenant-ID divergiria do escopo real dos boards. Ver getTenantIdFromDomain.
  try {
    const t = (session.user as { tenantId?: unknown })?.tenantId;
    if (t) localStorage.setItem('mks-sso-tenant', String(t));
  } catch {
    /* localStorage indisponível */
  }
  return true;
}

/**
 * Pede a sessão ao parent (MakeStudio) e aplica. Usado na carga inicial e de
 * novo quando um 401 indica que o token expirou — o parent devolve o token
 * atual (já renovado pelo fluxo de refresh DELE). Resolve false se não veio
 * nada (timeout / não-embarcado) → o app cai pro login normal.
 */
export function requestSsoFromParent(timeoutMs = 4000): Promise<boolean> {
  if (!isEmbedded()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      resolve(ok);
    };
    const onMsg = (ev: MessageEvent): void => {
      const data = ev.data as { type?: string; session?: AuthSession | null } | null;
      if (!data || data.type !== SSO_SESSION) return;
      finish(applySession(data.session ?? null));
    };
    window.addEventListener('message', onMsg);
    try {
      window.parent.postMessage({ type: SSO_READY }, '*');
    } catch {
      /* sandbox */
    }
    window.setTimeout(() => finish(false), timeoutMs);
  });
}
