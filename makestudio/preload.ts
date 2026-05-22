/**
 * preload.ts — contextBridge gateway between renderer and main.
 *
 * Exposes `window.makestudio` with three namespaces:
 *   - `agent`  — request/response calls (ipcRenderer.invoke).
 *   - `events` — pub/sub for main-pushed events (ipcRenderer.on).
 *   - `rpc`    — one-shot resolve channels (renderer replies to main-
 *                initiated prompts like permission / picker / question).
 *
 * Fase 1a: shape genérico. O cliente renderer usa as constantes de
 * `@shared/channels` pra escolher canais, então o preload não precisa
 * repetir cada um nomeadamente.
 */

import { contextBridge, ipcRenderer, webFrame, IpcRendererEvent } from 'electron';

type Unsubscribe = () => void;

const makestudio = {
  agent: {
    invoke<TReq = unknown, TRes = unknown>(
      channel: string,
      payload?: TReq,
    ): Promise<TRes> {
      return ipcRenderer.invoke(channel, payload) as Promise<TRes>;
    },
  },

  events: {
    on<T = unknown>(
      channel: string,
      handler: (payload: T) => void,
    ): Unsubscribe {
      const listener = (_e: IpcRendererEvent, payload: T) => handler(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },

  rpc: {
    resolve(channel: string, payload?: unknown): void {
      ipcRenderer.send(channel, payload);
    },
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },

  app: {
    version: () =>
      ipcRenderer.invoke('app:version') as Promise<{
        app: string;
        electron: string;
        node: string;
      }>,
  },

  zoom: {
    set: (factor: number): void => webFrame.setZoomFactor(factor),
    get: (): number => webFrame.getZoomFactor(),
  },

  notify(title: string, body: string): void {
    ipcRenderer.send('notification', { title, body });
  },

  platform: process.platform,
} as const;

contextBridge.exposeInMainWorld('makestudio', makestudio);

export type MakeStudioAPI = typeof makestudio;
