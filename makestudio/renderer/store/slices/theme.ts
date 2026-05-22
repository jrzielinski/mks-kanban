import { create } from 'zustand';

export type ThemeName =
  | 'padrao'
  | 'claro'
  | 'sombrero'
  | 'slacker'
  | 'comunal'
  | 'maple'
  | 'vidraca'
  | 'starwars';

export interface ThemeMeta {
  id: ThemeName;
  label: string;
  inspired: string;
  swatch: string[];
  /** When true, the AppearanceSettingsPage hides this card. The theme
   *  still applies normally if it gets selected programmatically (e.g.
   *  by the /order66 easter egg) and survives reloads via localStorage. */
  hidden?: boolean;
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'padrao',
    label: 'Padrão',
    inspired: 'MakeStudio',
    swatch: ['#212121', '#E85D27', '#2E7DD7'],
  },
  {
    id: 'claro',
    label: 'Claro',
    inspired: 'Tema branco',
    swatch: ['#FFFFFF', '#E85D27', '#2E7DD7'],
  },
  {
    id: 'sombrero',
    label: 'Sombrero',
    inspired: '≈ Fedora',
    swatch: ['#1A2740', '#E33A6E', '#3C6EB4'],
  },
  {
    id: 'slacker',
    label: 'Slacker',
    inspired: '≈ Slackware',
    swatch: ['#1C1C1C', '#B89BFF', '#FFD93D'],
  },
  {
    id: 'comunal',
    label: 'Comunal',
    inspired: '≈ Ubuntu',
    swatch: ['#2C001E', '#E95420', '#AEA79F'],
  },
  {
    id: 'maple',
    label: 'Maple',
    inspired: '≈ macOS',
    swatch: ['#1E1E1E', '#0A84FF', '#FF9F0A'],
  },
  {
    id: 'vidraca',
    label: 'Vidraça',
    inspired: '≈ Windows',
    swatch: ['#1F1F1F', '#4CC2FF', '#92C5F9'],
  },
  {
    id: 'starwars',
    label: 'Star Wars',
    inspired: 'A galaxy far, far away',
    swatch: ['#050608', '#FFE81F', '#FF2A1C'],
    hidden: true,
  },
];

const STORAGE_KEY = 'makestudio:theme';

function applyTheme(name: ThemeName): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (name === 'padrao') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = name;
  }
}

function loadTheme(): ThemeName {
  if (typeof localStorage === 'undefined') return 'padrao';
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && THEMES.some((t) => t.id === v)) return v as ThemeName;
  } catch {
    /* */
  }
  return 'padrao';
}

interface ThemeStore {
  theme: ThemeName;
  setTheme: (name: ThemeName) => void;
  hydrate: () => void;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: 'padrao',
  setTheme: (name) => {
    applyTheme(name);
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      /* */
    }
    set({ theme: name });
  },
  hydrate: () => {
    const t = loadTheme();
    applyTheme(t);
    set({ theme: t });
  },
}));
