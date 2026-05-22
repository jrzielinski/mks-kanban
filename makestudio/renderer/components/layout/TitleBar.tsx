import React from 'react';
import { useNavigate, useLocation, useNavigationType } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';

/**
 * TitleBar minimalista ao estilo claude.ai: invisível no conteúdo, só
 * reserva espaço pros traffic lights do macOS e mantém a região draggable.
 *
 * Inclui controles de back/forward globais — disponíveis em qualquer página
 * sem precisar de cada page implementar o seu próprio.
 */
export function TitleBar(): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType(); // 'PUSH' | 'POP' | 'REPLACE'

  // React Router v6 não expõe canGoBack/canGoForward, então mantemos um
  // ponteiro próprio sobre o stack:
  //   - PUSH: incrementa pos, descarta forward (maxPos = pos)
  //   - POP: pos foi atualizado pelo back/forward do browser; reconstruímos
  //          a partir de window.history.state.idx (preservado pelo HashRouter)
  //   - REPLACE: nada muda no stack
  const stateIdx = (window.history.state as { idx?: number } | null)?.idx;
  const [pos, setPos] = React.useState(stateIdx ?? 0);
  const [maxPos, setMaxPos] = React.useState(stateIdx ?? 0);

  React.useEffect(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (navType === 'PUSH') {
      setPos(idx);
      setMaxPos(idx);
    } else if (navType === 'POP') {
      setPos(idx);
    }
    // REPLACE: nada muda
  }, [location.key, navType]);

  const canGoBack = pos > 0;
  const canGoForward = pos < maxPos;

  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

  return (
    <div
      className="flex h-10 shrink-0 items-center bg-surface-0 px-2"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* macOS reserva ~80px à esquerda pros traffic lights. */}
      <div
        className="flex items-center gap-0.5"
        style={{ marginLeft: isMac ? 76 : 4 }}
      >
        <NavButton
          icon={ChevronLeft}
          label="Voltar"
          disabled={!canGoBack}
          onClick={() => navigate(-1)}
        />
        <NavButton
          icon={ChevronRight}
          label="Avançar"
          disabled={!canGoForward}
          onClick={() => navigate(1)}
        />
      </div>
    </div>
  );
}

function NavButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  disabled: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={clsx(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        disabled
          ? 'cursor-default text-text-soft/30'
          : 'text-text-soft hover:bg-surface-2 hover:text-text',
      )}
    >
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}
