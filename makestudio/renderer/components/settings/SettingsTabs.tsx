import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Palette,
  Keyboard,
  ListOrdered,
  Edit3,
  Flag,
  Shield,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';

interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}

const TABS: Tab[] = [
  { to: '/settings/appearance', label: 'Aparência', icon: Palette },
  { to: '/settings/input', label: 'Entrada', icon: Edit3 },
  { to: '/settings/keybindings', label: 'Atalhos', icon: Keyboard },
  { to: '/settings/statusline', label: 'Status line', icon: ListOrdered },
  { to: '/settings/permissions', label: 'Permissões', icon: Lock },
  { to: '/settings/flags', label: 'Flags', icon: Flag },
  { to: '/settings/security', label: 'Segurança', icon: Shield, disabled: true },
];

export function SettingsTabs(): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="flex items-center gap-1 overflow-x-auto border-b border-border-subtle bg-surface-1/40 px-6 py-1.5">
      {TABS.map((t) => {
        const active = location.pathname === t.to;
        const Icon = t.icon;
        return (
          <button
            key={t.to}
            type="button"
            onClick={() => !t.disabled && navigate(t.to)}
            disabled={t.disabled}
            title={t.disabled ? 'Em breve (Fase 8)' : t.label}
            className={clsx(
              'flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
              active
                ? 'bg-primary/15 text-primary'
                : 'text-text-soft hover:bg-surface-2 hover:text-text',
              t.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-text-soft',
            )}
          >
            <Icon size={12} strokeWidth={2} />
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
