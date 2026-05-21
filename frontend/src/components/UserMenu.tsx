import React, { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/auth';

/**
 * Profile avatar + dropdown for the Boards header. Shows the logged-in user
 * (name/email) and a "Sair" (logout) action. Logout clears auth state via the
 * store, which flips `isAuthenticated` and lets KanbanApp's route guard
 * redirect to /login.
 */
export const UserMenu: React.FC = () => {
  const { t } = useTranslation('common');
  const { user, logout } = useAuthStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
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

  const displayName = user?.firstName
    ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
    : user?.email ?? '—';
  const initial = (user?.firstName || user?.email || '?').charAt(0).toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={displayName}
        aria-label={displayName}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
      >
        {initial}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-700">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
              {initial}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                {displayName}
              </p>
              {user?.email && (
                <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {user.email}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-red-600 transition-colors hover:bg-gray-50 dark:text-red-400 dark:hover:bg-gray-700/60"
          >
            <LogOut className="h-4 w-4" /> {t('userMenu.logout', 'Sair')}
          </button>
        </div>
      )}
    </div>
  );
};
