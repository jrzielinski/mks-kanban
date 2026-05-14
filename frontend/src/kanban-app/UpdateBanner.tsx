import React, { useEffect, useState } from 'react';

type UpdateStatus = 'idle' | 'available' | 'ready';

export const UpdateBanner: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatus>('idle');

  useEffect(() => {
    const desktop = (window as any).kanbanDesktop;
    if (!desktop?.onUpdate) return;

    const cleanup = desktop.onUpdate((s: 'available' | 'ready') => setStatus(s));
    return cleanup;
  }, []);

  if (status === 'idle') return null;

  const isReady = status === 'ready';

  return (
    <div className="flex items-center justify-between gap-3 bg-indigo-600 px-4 py-2 text-sm text-white">
      <span>
        {isReady
          ? 'Nova versão baixada e pronta para instalar.'
          : 'Nova versão disponível — baixando em segundo plano…'}
      </span>
      {isReady && (
        <button
          onClick={() => (window as any).kanbanDesktop?.installUpdate?.()}
          className="shrink-0 rounded bg-white px-3 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 transition-colors"
        >
          Instalar e reiniciar
        </button>
      )}
    </div>
  );
};
