import { app, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULTS: WindowState = { width: 1440, height: 960, maximized: false };

function stateFile(): string {
  return path.join(app.getPath('userData'), 'kanban-window.json');
}

/**
 * Returns true if the saved top-left corner falls within any connected display.
 * If the monitor that hosted the window was disconnected, the position is invalid.
 */
function isOnScreen(x: number, y: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    return x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
  });
}

/**
 * Read persisted window state from userData.
 * Must be called after app.whenReady() so `screen` is available.
 */
export function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf-8');
    const saved: Partial<WindowState> = JSON.parse(raw);
    const state: WindowState = {
      width: Math.max(saved.width ?? DEFAULTS.width, 800),
      height: Math.max(saved.height ?? DEFAULTS.height, 600),
      maximized: saved.maximized ?? false,
    };
    // Only restore position if the point is still on a connected display.
    if (
      typeof saved.x === 'number' &&
      typeof saved.y === 'number' &&
      isOnScreen(saved.x, saved.y)
    ) {
      state.x = saved.x;
      state.y = saved.y;
    }
    return state;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveWindowState(state: WindowState): void {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Non-fatal — next session just uses defaults.
  }
}
