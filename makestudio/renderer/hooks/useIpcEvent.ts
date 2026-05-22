import { useEffect } from 'react';
import { subscribe } from '../ipc/client';

/**
 * Subscribes to an IPC push event for the lifetime of the component.
 * Handler ref is not captured — pass a memoized handler if identity matters.
 */
export function useIpcEvent<T = unknown>(
  channel: string,
  handler: (payload: T) => void,
): void {
  useEffect(() => {
    const unsubscribe = subscribe<T>(channel, handler);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);
}
