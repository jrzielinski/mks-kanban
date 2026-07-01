import { useEffect } from 'react';
import { isEmbedded, installEmbedThemeListener } from '../kanban-app/webSso';

/**
 * Tema do kanban = MESMA paleta do MakeStudio Code (mks-code). Cada tema é uma
 * paleta `[data-theme="X"]` no <html> (definida em index.css, idêntica ao
 * tokens.css do mks-code). NÃO há toggle claro/escuro à parte: o tema já é claro
 * (claro/claude) ou escuro (resto) — quem decide é o próprio tema, via a classe
 * `.dark` que ligamos para os temas escuros (ativa as variantes `dark:` do
 * Tailwind, que a ponte do index.css remapeia pros tokens).
 */
export type ThemeName =
  | 'padrao'
  | 'claro'
  | 'claude'
  | 'sombrero'
  | 'slacker'
  | 'comunal'
  | 'maple'
  | 'vidraca'
  | 'starwars';

/** Temas claros (texto escuro / superfícies claras). O restante é escuro. */
export const LIGHT_THEMES: ReadonlySet<ThemeName> = new Set<ThemeName>(['claro', 'claude']);

/** Ordem do ciclo Ctrl+Shift+T (standalone). starwars fica fora — easter egg. */
export const CYCLE: ThemeName[] = [
  'padrao', 'claro', 'claude', 'sombrero', 'slacker', 'comunal', 'maple', 'vidraca',
];
const ALL: ThemeName[] = [...CYCLE, 'starwars'];

const STORAGE_KEY = 'makestudio:theme';

/** Aplica um tema pelo NOME: data-theme no <html> + `.dark` p/ temas escuros. */
export function applyThemeName(name: ThemeName): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (name === 'padrao') delete root.dataset.theme;
  else root.dataset.theme = name;
  root.classList.toggle('dark', !LIGHT_THEMES.has(name));
}

function loadSaved(): ThemeName {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
    if (v && ALL.includes(v)) return v;
  } catch {
    /* localStorage indisponível */
  }
  return 'padrao';
}

/** Metadata p/ UI de seleção — espelha renderer/store/slices/theme.ts do mks-code. */
export interface ThemeMeta {
  id: ThemeName;
  label: string;
  inspired: string;
  swatch: string[];
  /** Oculto na UI (easter egg); aplica normalmente se selecionado programaticamente. */
  hidden?: boolean;
}

export const THEMES: ThemeMeta[] = [
  { id: 'padrao',   label: 'Padrão',    inspired: 'MakeStudio',             swatch: ['#212121', '#E85D27', '#2E7DD7'] },
  { id: 'claro',    label: 'Claro',     inspired: 'Tema branco',            swatch: ['#FFFFFF', '#E85D27', '#2E7DD7'] },
  { id: 'claude',   label: 'Claude',    inspired: '≈ claude.ai',            swatch: ['#FAF9F5', '#C15F3C', '#6E8CA8'] },
  { id: 'sombrero', label: 'Sombrero',  inspired: '≈ Fedora',               swatch: ['#1A2740', '#E33A6E', '#3C6EB4'] },
  { id: 'slacker',  label: 'Slacker',   inspired: '≈ Slackware',            swatch: ['#1C1C1C', '#B89BFF', '#FFD93D'] },
  { id: 'comunal',  label: 'Comunal',   inspired: '≈ Ubuntu',               swatch: ['#2C001E', '#E95420', '#AEA79F'] },
  { id: 'maple',    label: 'Maple',     inspired: '≈ macOS',                swatch: ['#1E1E1E', '#0A84FF', '#FF9F0A'] },
  { id: 'vidraca',  label: 'Vidraça',   inspired: '≈ Windows',              swatch: ['#1F1F1F', '#4CC2FF', '#92C5F9'] },
  { id: 'starwars', label: 'Star Wars', inspired: 'A galaxy far, far away', swatch: ['#050608', '#FFE81F', '#FF2A1C'], hidden: true },
];

/** Aplica E persiste (a escolha da UI). */
export function setTheme(name: ThemeName): void {
  applyThemeName(name);
  try { localStorage.setItem(STORAGE_KEY, name); } catch { /* */ }
}

/** Tema salvo atual (ou 'padrao'). */
export function getSavedTheme(): ThemeName {
  return loadSaved();
}

export function useTheme() {
  useEffect(() => {
    // Embarcado no MakeStudio Code: NÃO tem tema próprio — segue o tema do host,
    // que chega no handshake SSO e via `mks-kanban:theme` ao vivo. Pré-aplica o
    // último tema sincronizado (instantâneo no reload) ou 'claude' como default.
    if (isEmbedded()) {
      let cached: ThemeName | null = null;
      try {
        const v = localStorage.getItem('mks-embed-theme') as ThemeName | null;
        if (v && ALL.includes(v)) cached = v;
      } catch {
        /* */
      }
      applyThemeName(cached ?? 'claude');
      return installEmbedThemeListener();
    }
    // Standalone: tema salvo (ou padrão).
    applyThemeName(loadSaved());
  }, []);

  // Ctrl+Shift+T cicla os temas (só standalone — embarcado segue o host).
  useEffect(() => {
    if (isEmbedded()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        const next = CYCLE[(CYCLE.indexOf(loadSaved()) + 1) % CYCLE.length];
        applyThemeName(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* */
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
