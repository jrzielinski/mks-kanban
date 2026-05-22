/**
 * Kanban auto-updater — Phase 5.
 *
 * Wraps electron-updater to check for new releases on GitHub and notify
 * the renderer when an update is available / downloaded.
 *
 * NOTE: requires `electron-updater` to be installed:
 *   npm install electron-updater --save   (run in agent/desktop/)
 *
 * The publish target is configured in electron-builder.kanban.json:
 *   { "publish": { "provider": "github", "owner": "guizielinski", "repo": "kanban-api" } }
 */

import { ipcMain, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

export function setupUpdater(win: BrowserWindow): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`);
    if (!win.isDestroyed()) {
      win.webContents.send('kanban:update', 'available');
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date');
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] update downloaded: ${info.version}`);
    if (!win.isDestroyed()) {
      win.webContents.send('kanban:update', 'ready');
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
  });

  ipcMain.handle('kanban:update:install', () => {
    autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[updater] checkForUpdatesAndNotify failed:', err.message);
  });
}
