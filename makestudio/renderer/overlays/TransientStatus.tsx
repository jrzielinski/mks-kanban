import React from 'react';
import { subscribe } from '../ipc/client';
import * as CH from '@shared/channels';
import type { TransientStatusDTO } from '@shared/types';

/**
 * Linha discreta acima da StatusBar pra eventos de housekeeping
 * ("microCompact freed 97k chars", "auto-sync: pulled 3 topics", etc).
 *
 * Cada novo evento substitui o anterior. Auto-fade após `ttlMs` (default
 * 4s já vem no DTO via electron-bridge.ts).
 */
export function TransientStatus(): React.ReactElement | null {
  const [item, setItem] = React.useState<TransientStatusDTO | null>(null);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const off = subscribe<TransientStatusDTO | null>(
      CH.EVT_TRANSIENT_STATUS,
      (payload) => {
        if (payload && payload.text) {
          setItem(payload);
          setVisible(true);
        } else {
          setVisible(false);
        }
      },
    );
    return off;
  }, []);

  React.useEffect(() => {
    if (!visible || !item) return;
    const ttl = item.ttlMs > 0 ? item.ttlMs : 4000;
    const elapsed = Date.now() - item.setAt;
    const remain = Math.max(0, ttl - elapsed);
    const t = window.setTimeout(() => setVisible(false), remain);
    return () => window.clearTimeout(t);
  }, [visible, item]);

  if (!item || !visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[44px] z-20 flex justify-center">
      <div className="pointer-events-auto rounded-md border border-border-subtle/60 bg-surface-1/90 px-3 py-1 text-[11.5px] text-dim-soft shadow-card backdrop-blur">
        {item.text}
      </div>
    </div>
  );
}
