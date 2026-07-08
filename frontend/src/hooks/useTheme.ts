import { useState, useEffect } from 'react';

export type ThemeStyle = 'default' | 'macos' | 'windows' | 'ubuntu' | 'fedora' | 'suse' | 'makestudio';
export type ThemeMode = 'light' | 'dark' | 'system';

export const ALL_STYLES: ThemeStyle[] = ['default', 'macos', 'windows', 'ubuntu', 'fedora', 'suse', 'makestudio'];
export const ALL_MODES: ThemeMode[] = ['light', 'dark', 'system'];


const STYLE_CLASS: Record<ThemeStyle, string | null> = {
  default: null,
  macos: 'theme-macos',
  windows: 'theme-windows',
  ubuntu: 'theme-ubuntu',
  fedora: 'theme-fedora',
  suse: 'theme-suse',
  makestudio: 'theme-makestudio',
};

const ALL_THEME_CLASSES = ['theme-macos', 'theme-windows', 'theme-ubuntu', 'theme-fedora', 'theme-suse', 'theme-makestudio'];

// ── Host sync (embedded in MakeStudio) ──────────────────────────────────────
// When running inside the MakeStudio iframe/BrowserView, the host posts its
// active theme NAME (see KanbanEmbedPage.tsx → hostThemeName()) via
// `mks-kanban:theme`. mks-code's theme names don't match ours 1:1, so we map
// each to the closest {style, mode} pair — MakeStudio's own look ('padrao'/
// 'claro') gets the dedicated 'makestudio' skin; the OS-inspired names
// ('sombrero', 'comunal', 'maple', 'vidraca') map to their matching skin here.
const HOST_THEME_MAP: Record<string, { style: ThemeStyle; mode: ThemeMode }> = {
  padrao:   { style: 'makestudio', mode: 'dark'  },
  claro:    { style: 'makestudio', mode: 'light' },
  claude:   { style: 'default',    mode: 'light' },
  sombrero: { style: 'fedora',     mode: 'dark'  },
  comunal:  { style: 'ubuntu',     mode: 'dark'  },
  maple:    { style: 'macos',      mode: 'dark'  },
  vidraca:  { style: 'windows',    mode: 'dark'  },
  slacker:  { style: 'default',    mode: 'dark'  },
  starwars: { style: 'default',    mode: 'dark'  },
};

// ── Backwards compat: migrate old single-key 'theme' to new two-key format ──
const OLD_THEME_MAP: Record<string, { style: ThemeStyle; mode: ThemeMode }> = {
  'light':         { style: 'default',    mode: 'light'  },
  'dark':          { style: 'default',    mode: 'dark'   },
  'system':        { style: 'default',    mode: 'system' },
  'macos-light':   { style: 'macos',      mode: 'light'  },
  'macos-dark':    { style: 'macos',      mode: 'dark'   },
  'macos':         { style: 'macos',      mode: 'light'  },
  'windows-light': { style: 'windows',    mode: 'light'  },
  'windows-dark':  { style: 'windows',    mode: 'dark'   },
  'windows':       { style: 'windows',    mode: 'light'  },
  'ubuntu':        { style: 'ubuntu',     mode: 'dark'   },
  'fedora':        { style: 'fedora',     mode: 'dark'   },
  'suse':          { style: 'suse',       mode: 'dark'   },
};

function loadSaved(): { style: ThemeStyle; mode: ThemeMode } {
  // New format
  const savedStyle = localStorage.getItem('theme-style') as ThemeStyle | null;
  const savedMode  = localStorage.getItem('theme-mode') as ThemeMode | null;
  if (savedStyle && ALL_STYLES.includes(savedStyle) && savedMode && ALL_MODES.includes(savedMode)) {
    return { style: savedStyle, mode: savedMode };
  }

  // Migrate from old single 'theme' key
  const old = localStorage.getItem('theme');
  if (old && OLD_THEME_MAP[old]) {
    const migrated = OLD_THEME_MAP[old];
    localStorage.removeItem('theme');
    localStorage.setItem('theme-style', migrated.style);
    localStorage.setItem('theme-mode', migrated.mode);
    return migrated;
  }

  return { style: 'default', mode: 'dark' };
}

function applyTheme(style: ThemeStyle, mode: ThemeMode) {
  const root = document.documentElement;

  // Remove all theme classes
  root.classList.remove('dark');
  for (const cls of ALL_THEME_CLASSES) root.classList.remove(cls);

  // Determine dark
  let isDark = false;
  if (mode === 'dark') {
    isDark = true;
  } else if (mode === 'system') {
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  if (isDark) root.classList.add('dark');

  // Apply style class
  const cls = STYLE_CLASS[style];
  if (cls) root.classList.add(cls);
}

export function useTheme() {
  const [style, setStyleState] = useState<ThemeStyle>('default');
  const [mode, setModeState]   = useState<ThemeMode>('dark');

  useEffect(() => {
    const saved = loadSaved();
    setStyleState(saved.style);
    setModeState(saved.mode);
    applyTheme(saved.style, saved.mode);
  }, []);

  // Host sync — only fires when embedded in MakeStudio (iframe posts its
  // active theme name on mount + on every theme change). No-op standalone.
  useEffect(() => {
    const onMessage = (ev: MessageEvent): void => {
      const data = ev.data as { type?: string; theme?: { name?: string } } | null;
      if (data?.type !== 'mks-kanban:theme') return;
      const mapped = HOST_THEME_MAP[data.theme?.name ?? ''];
      if (!mapped) return;
      setStyleState(mapped.style);
      setModeState(mapped.mode);
      localStorage.setItem('theme-style', mapped.style);
      localStorage.setItem('theme-mode', mapped.mode);
      applyTheme(mapped.style, mapped.mode);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // React to system pref changes when mode === 'system'
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme(style, 'system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [style, mode]);

  // Ctrl+Shift+T cycles through styles
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        setStyleState((prev) => {
          const idx = ALL_STYLES.indexOf(prev);
          const next = ALL_STYLES[(idx + 1) % ALL_STYLES.length];
          localStorage.setItem('theme-style', next);
          applyTheme(next, mode);
          return next;
        });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [mode]);

  const setStyle = (newStyle: ThemeStyle) => {
    setStyleState(newStyle);
    localStorage.setItem('theme-style', newStyle);
    applyTheme(newStyle, mode);
  };

  const setMode = (newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem('theme-mode', newMode);
    applyTheme(style, newMode);
  };

  return { style, mode, setStyle, setMode };
}
