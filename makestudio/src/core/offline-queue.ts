import * as fs from 'fs';
import * as path from 'path';
import { ensureConfigDir, getConfigDir } from '../config/config';
import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logSuccess, logError, logWarning } from '../ui/terminal';
import chalk from 'chalk';

const QUEUE_FILE = path.join(getConfigDir(), 'offline-queue.json');

interface QueueItem {
  id: string;
  type: 'import' | 'audit' | 'analysis-update';
  method: 'POST' | 'PUT';
  url: string;
  body: any;
  createdAt: string;
  retries: number;
  description: string;
}

function loadQueue(): QueueItem[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveQueue(queue: QueueItem[]): void {
  ensureConfigDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

/**
 * Pure: wrap a partial queue item with the runtime-generated id/createdAt/
 * retries fields. Extracted so the construction is deterministic for tests.
 */
export function buildQueueItem(
  input: Omit<QueueItem, 'id' | 'createdAt' | 'retries'>,
  now: Date = new Date(),
  randomFn: () => number = Math.random,
): QueueItem {
  return {
    ...input,
    id: `${now.getTime()}-${randomFn().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    retries: 0,
  };
}

/** Add an item to the offline queue */
export function enqueue(item: Omit<QueueItem, 'id' | 'createdAt' | 'retries'>): void {
  const queue = loadQueue();
  queue.push({
    ...item,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    retries: 0,
  });
  saveQueue(queue);
  logWarning(`Sem conexão — salvo na fila offline (${queue.length} pendente${queue.length > 1 ? 's' : ''})`);
  logInfo(`Arquivo: ${chalk.hex('#64748B')(QUEUE_FILE)}`);
  logInfo(`Reenviar com: ${chalk.hex('#22D3EE')('makestudio sync')}`);
}

/** Get pending items count */
export function pendingCount(): number {
  return loadQueue().length;
}

/** Try to flush all pending items */
export async function flushQueue(): Promise<{ sent: number; failed: number }> {
  const queue = loadQueue();
  if (queue.length === 0) {
    logInfo('Fila offline vazia — nada para sincronizar.');
    return { sent: 0, failed: 0 };
  }

  logInfo(`Sincronizando ${queue.length} item(ns) pendente(s)...`);

  let sent = 0;
  let failed = 0;
  const remaining: QueueItem[] = [];

  try {
    await ensureAuthenticated();
  } catch {
    logError('Sem autenticação. Execute: makestudio login');
    return { sent: 0, failed: queue.length };
  }

  const api = getApiClient();

  for (const item of queue) {
    try {
      if (item.method === 'POST') {
        await api.post(item.url, item.body);
      } else {
        await api.put(item.url, item.body);
      }
      sent++;
      logSuccess(`Enviado: ${item.description}`);
    } catch (err: any) {
      item.retries++;
      if (item.retries >= 5) {
        logError(`Descartado após 5 tentativas: ${item.description}`);
        failed++;
      } else {
        remaining.push(item);
        failed++;
        const msg = err.response?.data?.message || err.message;
        logWarning(`Falha (tentativa ${item.retries}/5): ${item.description} — ${msg}`);
      }
    }
  }

  saveQueue(remaining);

  if (remaining.length > 0) {
    logWarning(`${remaining.length} item(ns) ainda pendente(s). Tente novamente com: makestudio sync`);
  } else {
    logSuccess('Fila offline esvaziada com sucesso!');
  }

  return { sent, failed };
}

/** Check if there's a network connection by pinging the API */
export async function isOnline(): Promise<boolean> {
  try {
    const api = getApiClient();
    await api.get('/health', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
