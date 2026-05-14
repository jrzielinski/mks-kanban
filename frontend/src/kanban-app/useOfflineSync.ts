/**
 * Hook for offline state tracking and mutation queue draining — Phase 6.
 *
 * Returns { isOnline, pendingCount }.
 * Automatically drains the queued mutations when the connection is restored.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { dequeue, getQueueLength, onQueueChange, QueuedMutation } from './offlineQueue';

async function replayMutation(mutation: QueuedMutation): Promise<void> {
  await api.request({
    method: mutation.method,
    url: mutation.url,
    data: mutation.data,
  });
}

export function useOfflineSync(): { isOnline: boolean; pendingCount: number } {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(getQueueLength);
  const drainingRef = useRef(false);

  const drainQueue = useCallback(async () => {
    if (drainingRef.current || getQueueLength() === 0) return;
    drainingRef.current = true;

    const count = getQueueLength();
    const toastId = toast.loading(`Sincronizando ${count} alteração(ões)…`);
    let failed = 0;

    while (getQueueLength() > 0) {
      const mutation = dequeue();
      if (!mutation) break;
      try {
        await replayMutation(mutation);
      } catch {
        failed++;
      }
    }

    drainingRef.current = false;

    if (failed > 0) {
      toast.error(`${failed} alteração(ões) não puderam ser sincronizadas.`, { id: toastId });
    } else {
      toast.success('Sincronização concluída!', { id: toastId });
    }
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      drainQueue();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const removeQueueListener = onQueueChange(setPendingCount);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      removeQueueListener();
    };
  }, [drainQueue]);

  return { isOnline, pendingCount };
}
