// TUI disabled — using simple terminal output instead
// Future: implement with Electron desktop app for rich UI

export async function startTUI(options: { repo?: string; cli?: string }): Promise<void> {
  // Force fallback to simple mode
  throw new Error('TUI_DISABLED');
}
