import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { io, Socket } from 'socket.io-client';

interface CardCreatedPayload {
  title?: string;
  cardTitle?: string;
  userId?: string;
  createdBy?: string;
}

interface ActivityPayload {
  cardTitle?: string;
  userId?: string;
  authorId?: string;
}

/**
 * Subscribes to the current board's realtime socket and fires native OS
 * notifications for events from other users. Only active when
 * `window.kanbanDesktop` is present (Electron shell).
 *
 * Creates a lightweight dedicated socket so `KanbanBoardPage` does not
 * need to be modified.
 */
export function useKanbanNotifications(): void {
  const { token, user } = useAuthStore();
  const location = useLocation();

  useEffect(() => {
    if (!window.kanbanDesktop || !token) return;

    // Only connect when inside a specific board route (/kanban/:boardId).
    const match = location.pathname.match(/^\/kanban\/([^/]+)$/);
    const boardId = match?.[1];
    if (!boardId) return;

    const socket: Socket = io('/kanban-rt', {
      auth: { token },
      autoConnect: true,
      transports: ['websocket'],
      reconnectionAttempts: 3,
      reconnectionDelay: 5_000,
    });

    socket.on('connect', () => {
      socket.emit('joinBoard', { boardId });
    });

    socket.on('card:created', (data: CardCreatedPayload) => {
      // Skip events the current user originated.
      const creator = data.createdBy ?? data.userId;
      if (creator && creator === String(user?.id)) return;

      const title = data.title ?? data.cardTitle ?? 'Novo card';
      window.kanbanDesktop!.notify('Card criado', title).catch(() => {});
    });

    socket.on('activity:added', (data: ActivityPayload) => {
      const author = data.authorId ?? data.userId;
      if (author && author === String(user?.id)) return;

      const body = data.cardTitle ? `Comentário em: ${data.cardTitle}` : 'Novo comentário no quadro';
      window.kanbanDesktop!.notify('Atividade no quadro', body).catch(() => {});
    });

    return () => {
      socket.emit('leaveBoard', { boardId });
      socket.disconnect();
    };
  }, [token, location.pathname, user?.id]);
}
