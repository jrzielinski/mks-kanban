import React, { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { THEMES, setTheme, getSavedTheme, type ThemeName } from '@/hooks/useTheme';

/**
 * Seletor de temas do header (Boards). Mesmos temas/labels/swatches do
 * MakeStudio Code (mks-code). Persiste em localStorage (makestudio:theme)
 * via setTheme — o mesmo storage que o ciclo Ctrl+Shift+T usa.
 */
export const ThemeMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ThemeName>(() => getSavedTheme());
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape (mesmo padrão do UserMenu).
  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id: ThemeName) => {
    setTheme(id);
    setCurrent(id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Tema"
        aria-label="Tema"
        className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium transition-colors"
      >
        <Palette className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          <div className="border-b border-gray-100 px-4 py-2.5 dark:border-gray-700">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Tema
            </p>
          </div>
          {THEMES.filter((t) => !t.hidden).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/60"
            >
              <span className="flex shrink-0 -space-x-1">
                {t.swatch.map((c) => (
                  <span
                    key={c}
                    className="inline-block h-3.5 w-3.5 rounded-full border border-black/10 dark:border-white/20"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate font-medium">{t.label}</span>
                <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{t.inspired}</span>
              </span>
              {current === t.id && <Check className="h-4 w-4 shrink-0 text-green-500" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
