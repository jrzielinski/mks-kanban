import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Listens for deep-link navigation events sent by the Electron main process
 * via `mainWindow.webContents.send('kanban:navigate', path)` and navigates
 * the React Router to the given path.
 *
 * Deep links arrive when the user opens a `makestudio-kanban://` URL
 * while the app is already running. If the app was closed and the URL
 * launches a new instance, the main process processes the URL on startup
 * and sends the event once the renderer is ready.
 *
 * No-op when `window.kanbanDesktop` is absent (plain browser).
 */
export function useDeepLink(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!window.kanbanDesktop?.onNavigate) return;
    const cleanup = window.kanbanDesktop.onNavigate((path) => {
      navigate(path, { replace: false });
    });
    return cleanup;
  }, [navigate]);
}
