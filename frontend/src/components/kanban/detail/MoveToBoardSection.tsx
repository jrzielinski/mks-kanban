import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import type { KanbanBoard } from '@/services/kanban.service';

interface MoveToBoardSectionProps {
  boardId: string;
  boards: KanbanBoard[];
  kanbanService: {
    getBoardLists: (boardId: string) => Promise<Array<{ id: string; title: string }>>;
    moveCard: (cardId: string, targetBoardId: string, targetListId: string) => Promise<void>;
  };
  cardId: string;
  onMoved: () => void;
  onClose: () => void;
}

interface MoveState {
  targetBoardId: string;
  targetListId: string;
  loading: boolean;
  lists: Array<{ id: string; title: string }>;
}

export function MoveToBoardSection({ boardId, boards, kanbanService, cardId, onMoved, onClose }: MoveToBoardSectionProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<MoveState>({ targetBoardId: '', targetListId: '', loading: false, lists: [] });

  const otherBoards = useMemo(
    () => boards.filter(b => b.id !== boardId),
    [boards, boardId],
  );

  const handleBoardChange = useCallback(async (newBoardId: string) => {
    setState(prev => ({ ...prev, targetBoardId: newBoardId, targetListId: '', lists: [] }));
    try {
      const lists = await kanbanService.getBoardLists(newBoardId);
      setState(prev => ({ ...prev, lists: lists.map(l => ({ id: l.id, title: l.title })) }));
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.loadListsError'));
    }
  }, [kanbanService, t]);

  const handleMove = useCallback(async () => {
    if (!state.targetBoardId || !state.targetListId || state.loading) return;
    setState(prev => ({ ...prev, loading: true }));
    try {
      await kanbanService.moveCard(cardId, state.targetBoardId, state.targetListId);
      toast.success(t('kanbanCardDetailModal.toasts.cardMoved'));
      onMoved();
      onClose();
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.moveCardError'));
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  }, [state, cardId, kanbanService, t, onMoved, onClose]);

  return (
    <div className="space-y-3">
      {otherBoards.length === 0 ? (
        <p className="text-sm text-[#44546f] dark:text-[#8c9bab]">
          {t('kanbanCardDetailModal.toasts.noOtherBoards')}
        </p>
      ) : (
        <>
          <p className="text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">
            {t('kanbanCardDetailModal.sections.selectBoard')}
          </p>
          {otherBoards.map(b => (
            <button
              key={b.id}
              onClick={() => void handleBoardChange(b.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                state.targetBoardId === b.id
                  ? 'border-[#579dff] bg-[#e9efff] text-[#0c66e4] dark:bg-[#1c2b41] dark:text-[#85b8ff]'
                  : 'border-[#e2e6ea] text-[#172b4d] hover:bg-[#f6f8fb] dark:border-[#3b4754] dark:text-[#b6c2cf] dark:hover:bg-[#2b3137]'
              }`}
            >
              <span className="font-medium">{b.title}</span>
            </button>
          ))}

          {state.lists.length > 0 && (
            <>
              <p className="text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">
                {t('kanbanCardDetailModal.sections.selectList')}
              </p>
              <div className="space-y-1">
                {state.lists.map(list => (
                  <button
                    key={list.id}
                    onClick={() => setState(prev => ({ ...prev, targetListId: list.id }))}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      state.targetListId === list.id
                        ? 'border-[#579dff] bg-[#e9efff] text-[#0c66e4] dark:bg-[#1c2b41] dark:text-[#85b8ff]'
                        : 'border-[#e2e6ea] text-[#172b4d] hover:bg-[#f6f8fb] dark:border-[#3b4754] dark:text-[#b6c2cf] dark:hover:bg-[#2b3137]'
                    }`}
                  >
                    {list.title}
                  </button>
                ))}
              </div>
            </>
          )}

          {state.targetBoardId && state.targetListId && (
            <button
              onClick={handleMove}
              disabled={state.loading}
              className="w-full rounded-lg bg-[#579dff] py-2 text-sm font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-50"
            >
              {state.loading ? '...' : t('kanbanCardDetailModal.actions.move')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
