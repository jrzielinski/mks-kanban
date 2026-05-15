import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface BoardLibraryEntry {
  id: string;
  name: string;
  filePath: string;
  lastOpened: string | null;
  createdAt: string;
}

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
  onNavigate: (cb: (path: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, path: string) => cb(path);
    ipcRenderer.on('kanban:navigate', handler);
    return () => ipcRenderer.removeListener('kanban:navigate', handler);
  },

  // ── Phase 5 — auto-updater ───────────────────────────────────────────────
  onUpdate: (cb: (status: 'available' | 'ready') => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, status: string) =>
      cb(status as 'available' | 'ready');
    ipcRenderer.on('kanban:update', handler);
    return () => ipcRenderer.removeListener('kanban:update', handler);
  },
  installUpdate: (): Promise<void> => ipcRenderer.invoke('kanban:update:install'),

  // ── Board library — file-per-board model ────────────────────────────────
  // Each board is a standalone .sqlite file. Switching boards restarts the
  // embedded backend pointed at the new file and returns a fresh session.
  boardLibrary: {
    list: (): Promise<BoardLibraryEntry[]> => ipcRenderer.invoke('boardLibrary:list'),
    active: (): Promise<BoardLibraryEntry | null> =>
      ipcRenderer.invoke('boardLibrary:active'),
    create: (name: string): Promise<BoardLibraryEntry> =>
      ipcRenderer.invoke('boardLibrary:create', name),
    rename: (id: string, name: string): Promise<BoardLibraryEntry | null> =>
      ipcRenderer.invoke('boardLibrary:rename', id, name),
    remove: (id: string, deleteFile?: boolean): Promise<boolean> =>
      ipcRenderer.invoke('boardLibrary:remove', id, deleteFile),
    open: (id: string): Promise<{ entry: BoardLibraryEntry; session: unknown } | null> =>
      ipcRenderer.invoke('boardLibrary:open', id),
    import: (): Promise<BoardLibraryEntry | null> =>
      ipcRenderer.invoke('boardLibrary:import'),
  },
});
