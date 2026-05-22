import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('kanbanDesktop', {
  // ── Phase 1 — auth bridge ────────────────────────────────────────────────
  getAuthSession: (): Promise<unknown> => ipcRenderer.invoke('kanban:auth:get'),
  setAuthSession: (session: unknown): Promise<void> =>
    ipcRenderer.invoke('kanban:auth:set', session),
  clearAuthSession: (): Promise<void> => ipcRenderer.invoke('kanban:auth:clear'),
  platform: process.platform,

  // ── Phase 3 — native notifications ──────────────────────────────────────
  notify: (title: string, body: string): Promise<void> =>
    ipcRenderer.invoke('kanban:notify', { title, body }),
  setBadge: (count: number): Promise<void> =>
    ipcRenderer.invoke('kanban:badge', count),

  // ── Phase 4 — deep-link navigation ──────────────────────────────────────
  // Registers a callback that fires when the main process sends a
  // 'kanban:navigate' event (e.g., via a makestudio-kanban:// URL).
  // Returns a cleanup function that removes the listener.
  onNavigate: (cb: (path: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, path: string) => cb(path);
    ipcRenderer.on('kanban:navigate', handler);
    return () => ipcRenderer.removeListener('kanban:navigate', handler);
  },

  // ── Phase 5 — auto-updater ───────────────────────────────────────────────
  // status: 'available' (downloading) | 'ready' (downloaded, can install now)
  onUpdate: (cb: (status: 'available' | 'ready') => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, status: string) =>
      cb(status as 'available' | 'ready');
    ipcRenderer.on('kanban:update', handler);
    return () => ipcRenderer.removeListener('kanban:update', handler);
  },
  installUpdate: (): Promise<void> => ipcRenderer.invoke('kanban:update:install'),
});
