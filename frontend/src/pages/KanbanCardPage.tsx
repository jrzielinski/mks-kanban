// @ts-ignore
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import kanbanService, {
  KanbanBoard, KanbanCard, KanbanList, KanbanBoardMember,
} from '@/services/kanban.service';
import { CardDetailModal } from '@/components/kanban/CardDetailModal';

export function KanbanCardPage() {
  const { t } = useTranslation('common');
  const { boardId, cardId } = useParams<{ boardId: string; cardId: string }>();
  const navigate = useNavigate();

  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [card, setCard] = useState<KanbanCard | null>(null);
  const [listTitle, setListTitle] = useState('');
  const [boardMembers, setBoardMembers] = useState<KanbanBoardMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!boardId || !cardId) return;
    (async () => {
      try {
        setIsLoading(true);
        const data = await kanbanService.getBoard(boardId);
        setBoard(data as KanbanBoard);
        setBoardMembers((data as any).members || []);

        let found: KanbanCard | null = null;
        let foundListTitle = '';
        for (const list of (data as any).lists as KanbanList[]) {
          const c = list.cards?.find((c: KanbanCard) => c.id === cardId);
          if (c) {
            found = c as KanbanCard;
            foundListTitle = list.title;
            break;
          }
        }
        if (found) {
          setCard(found);
          setListTitle(foundListTitle);
        } else {
          setNotFound(true);
        }
      } catch {
        toast.error(t('kanbanCardPage.loadError'));
        setNotFound(true);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [boardId, cardId]);

  const handleBack = () => navigate(`/kanban/${boardId}`);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-[#22272b]">
        <Loader2 className="animate-spin text-violet-500" size={28} />
      </div>
    );
  }

  if (notFound || !card) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white dark:bg-[#22272b]">
        <p className="text-lg font-semibold text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardPage.notFound')}</p>
        <button onClick={handleBack} className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm text-white hover:bg-violet-700">
          <ArrowLeft size={14} /> {t('kanbanCardPage.backToBoard')}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f6f8fb] dark:bg-[#161b22]">
      {/* Breadcrumb / Back */}
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 dark:border-[#3b4754] dark:bg-[#22272b]/90 backdrop-blur-sm">
        <div className="flex items-center gap-3 px-6 py-3">
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-[#44546f] hover:bg-[#091e420f] dark:text-[#8c9bab] dark:hover:bg-[#ffffff14] transition-colors"
          >
            <ArrowLeft size={14} />
            {board?.title ?? 'Board'}
          </button>
          <span className="text-[#cdd2d6]">/</span>
          {listTitle && (
            <>
              <span className="text-sm text-[#44546f] dark:text-[#8c9bab]">{listTitle}</span>
              <span className="text-[#cdd2d6]">/</span>
            </>
          )}
          <span className="text-sm font-medium text-[#172b4d] dark:text-[#b6c2cf]">
            {card.title}
          </span>
        </div>
      </div>

      {/* Card content */}
      <div>
        <CardDetailModal
          fullPage
          card={card}
          boardId={boardId!}
          listTitle={listTitle}
          boardMembers={boardMembers}
          customFieldDefs={(board as any)?.customFieldDefs ?? []}
          onClose={handleBack}
          onUpdated={(updated) => setCard(updated)}
          onDeleted={() => handleBack()}
        />
      </div>
    </div>
  );
}
