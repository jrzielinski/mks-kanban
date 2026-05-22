import { flushQueue, pendingCount } from '../core/offline-queue';
import { logInfo, logSuccess } from '../ui/terminal';

export async function syncCommand(): Promise<void> {
  const count = pendingCount();
  if (count === 0) {
    logInfo('Fila offline vazia — nada para sincronizar.');
    return;
  }

  logInfo(`${count} item(ns) pendente(s) na fila offline.`);
  const result = await flushQueue();
  logSuccess(`Sincronização concluída: ${result.sent} enviado(s), ${result.failed} falha(s).`);
}
