import { useEffect, useState } from 'react';
import { isEmbedded, requestSsoFromParent } from './webSso';

/**
 * Espelho web do useElectronAuthSync: dentro do iframe do MakeStudio, segura
 * o render até a sessão chegar do parent (sem flash de tela de login). Fora do
 * iframe (browser normal) ou já autenticado, começa hidratado — sem atraso.
 */
export function useWebAuthSync(): { hydrated: boolean } {
  const embedded = isEmbedded();
  const already = (() => {
    try {
      return !!localStorage.getItem('token');
    } catch {
      return false;
    }
  })();
  const [hydrated, setHydrated] = useState(!embedded || already);

  useEffect(() => {
    if (!embedded || already) return;
    let alive = true;
    requestSsoFromParent().finally(() => {
      if (alive) setHydrated(true);
    });
    return () => {
      alive = false;
    };
  }, [embedded, already]);

  return { hydrated };
}
