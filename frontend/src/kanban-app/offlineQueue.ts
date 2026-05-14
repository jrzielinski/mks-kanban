/**
 * Mutation queue for offline support — Phase 6.
 *
 * Stores failed non-GET requests in localStorage so they can be replayed
 * when the connection is restored. Uses a custom DOM event to notify
 * subscribers (e.g. ConnectionBadge) whenever the queue length changes.
 */

const QUEUE_KEY = 'kanban-offline-queue';
const QUEUE_CHANGE_EVENT = 'kanban-queue-change';

export interface QueuedMutation {
  id: string;
  method: string;
  url: string;
  data?: unknown;
  timestamp: number;
}

function readQueue(): QueuedMutation[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedMutation[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    // localStorage full — drop oldest entry and retry once
    const trimmed = q.slice(-50);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed));
  }
  window.dispatchEvent(new CustomEvent(QUEUE_CHANGE_EVENT, { detail: q.length }));
}

export function enqueue(mutation: Omit<QueuedMutation, 'id' | 'timestamp'>): void {
  const q = readQueue();
  q.push({ ...mutation, id: crypto.randomUUID(), timestamp: Date.now() });
  writeQueue(q);
}

export function dequeue(): QueuedMutation | null {
  const q = readQueue();
  if (q.length === 0) return null;
  const [first, ...rest] = q;
  writeQueue(rest);
  return first;
}

export function getQueueLength(): number {
  return readQueue().length;
}

export function clearQueue(): void {
  writeQueue([]);
}

export function onQueueChange(cb: (count: number) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<number>).detail);
  window.addEventListener(QUEUE_CHANGE_EVENT, handler);
  return () => window.removeEventListener(QUEUE_CHANGE_EVENT, handler);
}
