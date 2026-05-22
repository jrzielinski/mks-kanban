import React from 'react';
import { HelpCircle, X } from 'lucide-react';
import { subscribe, resolveRpc } from '../ipc/client';
import * as CH from '@shared/channels';
import type { QuestionRequest } from '@shared/types';

/**
 * Banner inline (não-modal) que indica AskUserQuestion ativo.
 * O usuário responde digitando no InputBox normal — `agent:submit`
 * checa `consumePendingAnswer(text)` antes de rotear pro chat.
 *
 * O banner é só uma sinalização visual + atalho de cancelamento (Esc).
 */
export function QuestionBanner(): React.ReactElement | null {
  const [request, setRequest] = React.useState<QuestionRequest | null>(null);

  React.useEffect(() => {
    const offOpen = subscribe<QuestionRequest>(CH.EVT_QUESTION_REQUEST, (r) =>
      setRequest(r),
    );
    const offClose = subscribe<void>(CH.EVT_QUESTION_CLOSE, () =>
      setRequest(null),
    );
    return () => {
      offOpen();
      offClose();
    };
  }, []);

  // Esc cancela enquanto o banner está visível.
  React.useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Resposta vazia → consumePendingAnswer resolve com '' e o tool
        // decide o que fazer (em geral, trata como "no input" / cancel).
        resolveRpc(CH.AGENT_QUESTION_RESOLVE, '');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  if (!request) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[88px] z-30 flex justify-center px-4">
      <div className="pointer-events-auto flex w-[min(720px,92vw)] items-center gap-3 rounded-xl border border-warning/40 bg-warning/8 px-4 py-2.5 text-[12.5px] shadow-elev backdrop-blur">
        <HelpCircle size={14} strokeWidth={2.2} className="shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-warning">Aguardando sua resposta</div>
          <div className="truncate text-text-soft">
            {request.placeholder
              ? request.placeholder
              : 'Digite a resposta no campo abaixo e pressione Enter.'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => resolveRpc(CH.AGENT_QUESTION_RESOLVE, '')}
          title="Cancelar (Esc)"
          className="flex h-7 w-7 items-center justify-center rounded-full text-warning transition-colors hover:bg-warning/15"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
