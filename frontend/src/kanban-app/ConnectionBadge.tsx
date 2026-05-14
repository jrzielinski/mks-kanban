import React from 'react';
import { useOfflineSync } from './useOfflineSync';

export const ConnectionBadge: React.FC = () => {
  const { isOnline, pendingCount } = useOfflineSync();

  if (isOnline && pendingCount === 0) return null;

  const label = isOnline
    ? `Sincronizando ${pendingCount} alteração(ões)…`
    : pendingCount > 0
      ? `Offline — ${pendingCount} alteração(ões) pendente(s)`
      : 'Offline';

  return (
    <div className="flex items-center gap-2 bg-amber-500 px-4 py-1.5 text-xs font-medium text-white">
      <span
        className={`h-2 w-2 rounded-full ${isOnline ? 'animate-pulse bg-white' : 'bg-white/70'}`}
      />
      {label}
    </div>
  );
};
