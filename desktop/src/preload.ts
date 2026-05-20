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
  login: (credentials: { email: string; password: string }): Promise<unknown> =>
    ipcRenderer.invoke('kanban:auth:login', credentials),
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

  // ── Phase 6 — embedded MKS-CODE agent ──────────────────────────────────
  /** Send a prompt/command to the CLI agent (returns response ID). */
  agent: {
    send: (input: string): Promise<string> =>
      ipcRenderer.invoke('agent:send', input),
    onResponse: (cb: (data: { id: string; text: string }) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, data: { id: string; text: string }) =>
        cb(data);
      ipcRenderer.on('agent:response', handler);
      return () => ipcRenderer.removeListener('agent:response', handler);
    },
    onError: (cb: (err: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, err: string) => cb(err);
      ipcRenderer.on('agent:error', handler);
      return () => ipcRenderer.removeListener('agent:error', handler);
    },
    restart: (): Promise<void> => ipcRenderer.invoke('agent:restart'),
    isRunning: (): Promise<boolean> => ipcRenderer.invoke('agent:isRunning'),
    /** Open (or focus) MakeStudio Code in its own standalone window. */
    openWindow: (): Promise<boolean> => ipcRenderer.invoke('agent:open-window'),
  },

  // ── MakeStudio Code TUI over a pseudo-terminal (xterm.js ↔ node-pty) ─────
  pty: {
    /** Spawn a TUI session bound to this window; resolves to its session id. */
    start: (opts: { cols?: number; rows?: number }): Promise<string> =>
      ipcRenderer.invoke('agent:pty:start', opts),
    write: (id: string, data: string): void =>
      ipcRenderer.send('agent:pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('agent:pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('agent:pty:kill', id),
    /** Stream output for a session. Returns an unsubscribe fn. */
    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, p: { id: string; data: string }) => {
        if (p.id === id) cb(p.data);
      };
      ipcRenderer.on('agent:pty:data', handler);
      return () => ipcRenderer.removeListener('agent:pty:data', handler);
    },
    /** Notified when a session's process exits. Returns an unsubscribe fn. */
    onExit: (id: string, cb: (exitCode: number) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, p: { id: string; exitCode: number }) => {
        if (p.id === id) cb(p.exitCode);
      };
      ipcRenderer.on('agent:pty:exit', handler);
      return () => ipcRenderer.removeListener('agent:pty:exit', handler);
    },
  },

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

  license: {
    getState: (): Promise<import('./licenseStore').LicenseState> =>
      ipcRenderer.invoke('license:getState'),
    install: (jwt: string): Promise<import('./licenseStore').LicenseState> =>
      ipcRenderer.invoke('license:install', jwt),
    clear: (): Promise<boolean> => ipcRenderer.invoke('license:clear'),
    getMachineId: (): Promise<string> => ipcRenderer.invoke('license:getMachineId'),
    refresh: (): Promise<import('./licenseStore').LicenseState> =>
      ipcRenderer.invoke('license:refresh'),
  },
});
