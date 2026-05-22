import React from 'react';
import { Info, AlertTriangle, AlertOctagon, X } from 'lucide-react';
import { subscribe } from '../ipc/client';
import * as CH from '@shared/channels';
import { CLIENT_TOAST_EVENT } from '../lib/clientToast';
import type { ToastDTO } from '@shared/types';

interface ActiveToast extends ToastDTO {
  /** Quando o item entra na stack — usado pra animação de saída suave. */
  enteredAt: number;
}

const MAX_STACK = 5;

export function Toasts(): React.ReactElement {
  const [toasts, setToasts] = React.useState<ActiveToast[]>([]);

  // Subscreve ao push do bridge (latest-first).
  React.useEffect(() => {
    const push = (t: ToastDTO): void => {
      setToasts((cur) => {
        if (cur.some((x) => x.id === t.id)) return cur;
        const next = [...cur, { ...t, enteredAt: Date.now() }];
        if (next.length > MAX_STACK) next.shift();
        return next;
      });
    };
    const off = subscribe<ToastDTO>(CH.EVT_TOAST, push);
    // Client-side toasts (page-level mutations) feed the same stack via
    // a CustomEvent — keeps the overlay single-source-of-truth for both
    // IPC-driven and renderer-driven notifications.
    const onClient = (e: Event): void => {
      const detail = (e as CustomEvent<ToastDTO>).detail;
      if (detail) push(detail);
    };
    window.addEventListener(CLIENT_TOAST_EVENT, onClient);
    return () => {
      off();
      window.removeEventListener(CLIENT_TOAST_EVENT, onClient);
    };
  }, []);

  // Cleanup de itens expirados — tick 250ms enquanto houver toasts ativos.
  React.useEffect(() => {
    if (toasts.length === 0) return;
    const t = window.setInterval(() => {
      const now = Date.now();
      setToasts((cur) => cur.filter((x) => x.expiresAt > now));
    }, 250);
    return () => window.clearInterval(t);
  }, [toasts.length]);

  const dismiss = React.useCallback((id: string) => {
    setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  if (toasts.length === 0) return <></>;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Notificações"
      className="pointer-events-none fixed bottom-12 right-6 z-40 flex w-[min(360px,90vw)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

interface ItemProps {
  toast: ActiveToast;
  onDismiss: () => void;
}

const KIND_CLS: Record<ToastDTO['kind'], string> = {
  info: 'border-secondary/40 bg-secondary/8 text-text',
  warn: 'border-warning/40 bg-warning/10 text-text',
  error: 'border-danger/40 bg-danger/10 text-text',
};
const KIND_ICON_CLS: Record<ToastDTO['kind'], string> = {
  info: 'text-secondary',
  warn: 'text-warning',
  error: 'text-danger',
};

function ToastItem({ toast, onDismiss }: ItemProps): React.ReactElement {
  const Icon =
    toast.kind === 'error'
      ? AlertOctagon
      : toast.kind === 'warn'
        ? AlertTriangle
        : Info;
  return (
    <div
      className={
        'pointer-events-auto flex items-start gap-2.5 rounded-md border bg-surface-1/95 px-3 py-2 text-[12.5px] shadow-elev backdrop-blur ' +
        KIND_CLS[toast.kind]
      }
    >
      <Icon size={14} strokeWidth={2.2} className={'mt-[2px] shrink-0 ' + KIND_ICON_CLS[toast.kind]} />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-text-soft">
        {toast.text}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        title="Fechar"
        className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-dim transition-colors hover:bg-surface-3 hover:text-text"
      >
        <X size={11} strokeWidth={2} />
      </button>
    </div>
  );
}
