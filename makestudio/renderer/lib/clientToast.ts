/**
 * Client-side toast helper. Bridges page-level success/error notifications
 * (form saved, mutation failed) into the same Toasts overlay that the IPC
 * EVT_TOAST events feed — without adding a new external dependency.
 *
 * Usage mimics react-hot-toast on purpose:
 *   import { toast } from '../../lib/clientToast';
 *   toast.success('Salvo');
 *   toast.error('Falhou: ...');
 *
 * Mechanism: dispatches a CustomEvent on `window`. The Toasts component
 * listens to it and appends to its existing stack. Same expiry/dedupe
 * machinery as IPC-pushed toasts.
 */

import type { ToastDTO } from '@shared/types';

export const CLIENT_TOAST_EVENT = 'makestudio:client-toast';

let __counter = 0;

function emit(kind: ToastDTO['kind'], text: string, ttlMs = 4_000): void {
  if (typeof window === 'undefined') return;
  const detail: ToastDTO = {
    id: `client-${Date.now()}-${++__counter}`,
    kind,
    text,
    expiresAt: Date.now() + ttlMs,
  };
  try {
    window.dispatchEvent(new CustomEvent(CLIENT_TOAST_EVENT, { detail }));
  } catch {
    /* */
  }
}

export const toast = {
  // success maps to 'info' kind in Toasts (no dedicated success kind there
  // — the visual is the secondary blue, which fits "saved" feedback).
  success(text: string): void {
    emit('info', text);
  },
  error(text: string): void {
    emit('error', text, 6_000);
  },
  info(text: string): void {
    emit('info', text);
  },
  warn(text: string): void {
    emit('warn', text);
  },
};
