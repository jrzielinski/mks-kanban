/**
 * Webview-side primitives for talking to the VSCode extension host.
 *
 * Implements the postMessage protocol that backs `window.makestudio` (see
 * `makestudioBridge.ts`). All communication is async and channel-based:
 *
 *   - `apiInvoke(channel, payload)` — request/response with correlation ID.
 *   - `eventsOn(channel, handler)`  — push subscribe; unsubscribe when last
 *     handler leaves so the host stops sending traffic for the channel.
 *   - `rpcResolve(channel, payload)` — fire-and-forget reply (used for
 *     permission/picker/question prompts initiated by the host).
 *
 * The host side mirrors this with a router in `agent/vscode-extension/src/
 * webview/messageRouter.ts` (Phase 3).
 */

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  getState: <T = unknown>() => T | undefined;
  setState: <T = unknown>(state: T) => void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let cached: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi | null {
  if (cached) return cached;
  if (typeof window === 'undefined') return null;
  if (typeof window.acquireVsCodeApi !== 'function') return null;
  try {
    cached = window.acquireVsCodeApi();
    return cached;
  } catch {
    // acquireVsCodeApi may only be called once per webview — second call throws.
    return null;
  }
}

export function isEmbedded(): boolean {
  return getVsCodeApi() !== null;
}

// ── Message types: webview → host ───────────────────────────────────────

export interface HostLogMessage {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

export interface HostNotifyMessage {
  type: 'notify';
  level?: 'info' | 'warn' | 'error';
  title: string;
  body: string;
}

export interface HostInvokeMessage {
  type: 'agent:invoke';
  reqId: string;
  channel: string;
  payload?: unknown;
}

export interface HostEventsSubscribeMessage {
  type: 'events:subscribe';
  channel: string;
}

export interface HostEventsUnsubscribeMessage {
  type: 'events:unsubscribe';
  channel: string;
}

export interface HostRpcResolveMessage {
  type: 'rpc:resolve';
  channel: string;
  payload?: unknown;
}

export interface HostEmbedReadyMessage {
  type: 'embed:ready';
}

export type WebviewToHostMessage =
  | HostLogMessage
  | HostNotifyMessage
  | HostInvokeMessage
  | HostEventsSubscribeMessage
  | HostEventsUnsubscribeMessage
  | HostRpcResolveMessage
  | HostEmbedReadyMessage;

// ── Message types: host → webview ───────────────────────────────────────

export interface AgentResponseMessage {
  type: 'agent:response';
  reqId: string;
  result?: unknown;
  error?: string;
}

export interface EventsPushMessage {
  type: 'events:push';
  channel: string;
  payload?: unknown;
}

export interface EmbedBootstrapMessage {
  type: 'embed:bootstrap';
  platform: string;
  appVersion: { app: string; node: string };
  theme?: 'light' | 'dark' | 'high-contrast';
  workspaceRoot?: string;
}

export interface ThemeChangedMessage {
  type: 'theme:changed';
  theme: 'light' | 'dark' | 'high-contrast';
}

export type HostToWebviewMessage =
  | AgentResponseMessage
  | EventsPushMessage
  | EmbedBootstrapMessage
  | ThemeChangedMessage;

// ── Outgoing primitive ─────────────────────────────────────────────────

export function postToHost(msg: WebviewToHostMessage): void {
  const api = getVsCodeApi();
  if (!api) return;
  try {
    api.postMessage(msg);
  } catch {
    /* host might be tearing down — ignore */
  }
}

// ── Incoming dispatch ──────────────────────────────────────────────────

interface PendingInvoke {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  channel: string;
}

const pendingInvokes = new Map<string, PendingInvoke>();
const eventSubscribers = new Map<string, Set<(payload: unknown) => void>>();
const bootstrapListeners = new Set<(msg: EmbedBootstrapMessage) => void>();
const themeListeners = new Set<(theme: string) => void>();

let bootstrapCache: EmbedBootstrapMessage | null = null;
let listenerInstalled = false;

function installListenerOnce(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  if (typeof window === 'undefined') return;
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as HostToWebviewMessage | undefined;
    if (!data || typeof data !== 'object' || !('type' in data)) return;

    switch (data.type) {
      case 'agent:response': {
        const pending = pendingInvokes.get(data.reqId);
        if (!pending) return;
        pendingInvokes.delete(data.reqId);
        clearTimeout(pending.timer);
        if (data.error) {
          pending.reject(new Error(data.error));
        } else {
          pending.resolve(data.result);
        }
        return;
      }
      case 'events:push': {
        const subs = eventSubscribers.get(data.channel);
        if (!subs) return;
        for (const handler of subs) {
          try {
            handler(data.payload);
          } catch (err) {
            postToHost({
              type: 'log',
              level: 'error',
              message: `[embed] event handler for '${data.channel}' threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
              data: { stack: err instanceof Error ? err.stack : undefined },
            });
          }
        }
        return;
      }
      case 'embed:bootstrap': {
        bootstrapCache = data;
        for (const l of bootstrapListeners) {
          try {
            l(data);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      case 'theme:changed': {
        for (const l of themeListeners) {
          try {
            l(data.theme);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      default:
        return;
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────────

const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;

function makeReqId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function apiInvoke<TRes = unknown, TReq = unknown>(
  channel: string,
  payload?: TReq,
  timeoutMs = DEFAULT_INVOKE_TIMEOUT_MS,
): Promise<TRes> {
  installListenerOnce();
  const api = getVsCodeApi();
  if (!api) {
    return Promise.reject(
      new Error(`[embed] apiInvoke('${channel}'): not running inside a VSCode webview`),
    );
  }
  const reqId = makeReqId();
  return new Promise<TRes>((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pendingInvokes.get(reqId);
      if (!p) return;
      pendingInvokes.delete(reqId);
      reject(new Error(`[embed] invoke('${channel}') timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingInvokes.set(reqId, {
      resolve: (v: unknown) => resolve(v as TRes),
      reject,
      timer,
      channel,
    });

    postToHost({ type: 'agent:invoke', reqId, channel, payload });
  });
}

export function eventsOn<T = unknown>(
  channel: string,
  handler: (payload: T) => void,
): () => void {
  installListenerOnce();
  let subs = eventSubscribers.get(channel);
  const isFirstSub = !subs;
  if (!subs) {
    subs = new Set();
    eventSubscribers.set(channel, subs);
  }
  subs.add(handler as (payload: unknown) => void);

  if (isFirstSub) {
    postToHost({ type: 'events:subscribe', channel });
  }

  return () => {
    const s = eventSubscribers.get(channel);
    if (!s) return;
    s.delete(handler as (payload: unknown) => void);
    if (s.size === 0) {
      eventSubscribers.delete(channel);
      postToHost({ type: 'events:unsubscribe', channel });
    }
  };
}

export function rpcResolve(channel: string, payload?: unknown): void {
  postToHost({ type: 'rpc:resolve', channel, payload });
}

export function onBootstrap(listener: (msg: EmbedBootstrapMessage) => void): () => void {
  installListenerOnce();
  if (bootstrapCache) {
    try {
      listener(bootstrapCache);
    } catch {
      /* ignore */
    }
  }
  bootstrapListeners.add(listener);
  return () => {
    bootstrapListeners.delete(listener);
  };
}

export function getBootstrap(): EmbedBootstrapMessage | null {
  return bootstrapCache;
}

export function onThemeChange(listener: (theme: string) => void): () => void {
  installListenerOnce();
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}
