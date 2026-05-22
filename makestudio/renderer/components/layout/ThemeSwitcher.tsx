import React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Palette, Check } from 'lucide-react';
import clsx from 'clsx';
import { useThemeStore, THEMES, type ThemeName } from '../../store';

export function ThemeSwitcher(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title="Tema"
          className="flex h-7 w-7 items-center justify-center rounded-md text-dim-soft transition-colors hover:bg-surface-2 hover:text-text data-[state=open]:bg-surface-2 data-[state=open]:text-text"
        >
          <Palette size={13} strokeWidth={1.8} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 min-w-[220px] overflow-hidden rounded-xl border border-border-soft bg-surface-1 p-1.5 shadow-elev"
        >
          <div className="px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim/70">
            Tema
          </div>
          {THEMES.map((t) => {
            const active = theme === t.id;
            return (
              <DropdownMenu.Item
                key={t.id}
                onSelect={() => setTheme(t.id as ThemeName)}
                className={clsx(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors',
                  active
                    ? 'bg-surface-2 text-text'
                    : 'text-text-soft data-[highlighted]:bg-surface-2/60 data-[highlighted]:text-text',
                )}
              >
                {/* Swatch — 3 cores do tema */}
                <div className="flex shrink-0 overflow-hidden rounded-md border border-border-subtle">
                  {t.swatch.map((c, i) => (
                    <div
                      key={i}
                      className="h-4 w-2"
                      style={{ background: c }}
                    />
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium leading-tight">
                    {t.label}
                  </div>
                  <div className="truncate text-[10.5px] text-dim">
                    {t.inspired}
                  </div>
                </div>
                {active && (
                  <Check size={12} strokeWidth={2.2} className="text-primary" />
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
