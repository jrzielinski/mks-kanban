/**
 * Real `window.makestudio` bridge backed by postMessage.
 *
 * Replaces the Phase 1 stub. Same surface as `agent/desktop/preload.ts`, so the
 * 32 pages of the renderer + the entire `ipc/client.ts` continue working
 * unchanged — the renderer never knows it left Electron.
 *
 * Surface:
 *   - `agent.invoke(channel, payload)` → `apiInvoke` (request/response).
 *   - `events.on(channel, handler)`    → `eventsOn` (push subscribe).
 *   - `rpc.resolve(channel, payload)`  → `rpcResolve` (fire-and-forget).
 *   - `window.{minimize,maximize,close}` → no-op (VSCode owns the chrome).
 *   - `app.version()`  → cached from `embed:bootstrap`, or stub fallback.
 *   - `zoom.{set,get}` → no-op for now (CSS transform is Phase 9 polish).
 *   - `notify(title, body)` → forwards to host (showInformationMessage).
 *   - `platform` → cached from `embed:bootstrap`, fallback `'webview'`.
 *
 * Auto-installs on import — must be loaded BEFORE any module that touches
 * `window.makestudio` at module-init time (e.g. `App.tsx` → pages → ipc).
 */

import {
  apiInvoke,
  eventsOn,
  rpcResolve,
  postToHost,
  onBootstrap,
  getBootstrap,
} from './vscodeApi';

type Unsubscribe = () => void;

interface MakestudioApi {
  agent: {
    invoke<TReq = unknown, TRes = unknown>(channel: string, payload?: TReq): Promise<TRes>;
  };
  events: {
    on<T = unknown>(channel: string, handler: (payload: T) => void): Unsubscribe;
  };
  rpc: {
    resolve(channel: string, payload?: unknown): void;
  };
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };
  app: {
    version: () => Promise<{ app: string; electron: string; node: string }>;
  };
  zoom: {
    set: (factor: number) => void;
    get: () => number;
  };
  notify: (title: string, body: string) => void;
  platform: string;
}

declare global {
  interface Window {
    makestudio?: MakestudioApi;
  }
}

let cachedPlatform = 'webview';
let cachedAppVersion: { app: string; electron: string; node: string } = {
  app: 'embed',
  electron: 'n/a',
  node: 'n/a',
};

// Pull initial values from bootstrap if it already arrived; otherwise wait.
{
  const bs = getBootstrap();
  if (bs) {
    cachedPlatform = bs.platform || cachedPlatform;
    cachedAppVersion = {
      app: bs.appVersion?.app || cachedAppVersion.app,
      electron: 'n/a',
      node: bs.appVersion?.node || cachedAppVersion.node,
    };
  } else {
    onBootstrap((msg) => {
      cachedPlatform = msg.platform || cachedPlatform;
      cachedAppVersion = {
        app: msg.appVersion?.app || cachedAppVersion.app,
        electron: 'n/a',
        node: msg.appVersion?.node || cachedAppVersion.node,
      };
      // platform is a property — patch it if anyone caches MakestudioApi reference.
      if (window.makestudio) {
        Object.assign(window.makestudio, { platform: cachedPlatform });
      }
    });
  }
}

export function installMakestudioBridge(): void {
  if (typeof window === 'undefined') return;
  if (window.makestudio && (window.makestudio as { __isBridge?: boolean }).__isBridge) return;

  const bridge: MakestudioApi & { __isBridge: boolean } = {
    __isBridge: true,
    agent: {
      invoke<TReq = unknown, TRes = unknown>(channel: string, payload?: TReq): Promise<TRes> {
        return apiInvoke<TRes, TReq>(channel, payload);
      },
    },
    events: {
      on<T = unknown>(channel: string, handler: (payload: T) => void): Unsubscribe {
        return eventsOn<T>(channel, handler);
      },
    },
    rpc: {
      resolve(channel: string, payload?: unknown): void {
        rpcResolve(channel, payload);
      },
    },
    window: {
      minimize: async () => {
        /* No-op: VSCode owns the host chrome. */
      },
      maximize: async () => {
        /* No-op: VSCode owns the host chrome. */
      },
      close: async () => {
        /* No-op: closing the panel is a host-level action. */
      },
    },
    app: {
      version: async () => cachedAppVersion,
    },
    zoom: {
      set: (_factor: number) => {
        /* No-op for MVP. CSS transform is Phase 9 polish. */
      },
      get: () => 1,
    },
    notify: (title: string, body: string) => {
      postToHost({ type: 'notify', title, body });
    },
    get platform() {
      return cachedPlatform;
    },
  };

  Object.defineProperty(window, 'makestudio', {
    value: bridge,
    writable: true,
    configurable: true,
  });
}

// Auto-install on import — order of imports matters: this file MUST load
// before App.tsx (which imports pages → ipc/client.ts).
installMakestudioBridge();
