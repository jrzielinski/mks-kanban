// src/kanban/power-ups/types.ts
export type KanbanEventKey =
  | 'card.created'
  | 'card.moved'
  | 'card.commented'
  | 'card.edited'
  | 'card.assigned'
  | 'card.due_changed';

export interface KanbanCardEventPayload {
  eventType: KanbanEventKey;
  tenantId: string;
  boardId: string;
  cardId: string;
  card: {
    id: string;
    title: string;
    description: string | null;
    listId: string;
    boardId: string;
    memberIds: string[];
    labels: { text: string; color: string }[];
    dueDate: string | null;
    position: number;
  };
  actor: { id: string; name: string };
  timestamp: string;
  extra?: Record<string, unknown>;
}
