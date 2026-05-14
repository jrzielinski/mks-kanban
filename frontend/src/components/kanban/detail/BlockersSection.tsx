
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import type { KanbanCard } from '@/services/kanban.service';

interface BlockersSectionProps {
  blockedBy: KanbanCard[];
  blockers: KanbanCard[];
  cardId: string;
}

export default function BlockersSection({ blockedBy, blockers }: BlockersSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      {blockedBy.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-[#44546f] dark:text-[#8c9bab]">
            <AlertTriangle className="h-3 w-3 text-red-500" />
            {t('kanbanCardDetailModal.blockers.blockedBy')}
          </div>
          {blockedBy.map(card => (
            <div key={card.id} className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs dark:bg-red-900/20">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              <span className="flex-1 truncate text-[#172b4d] dark:text-[#b6c2cf]">{card.title}</span>
              <a href={`/board/${card.boardId}/card/${card.id}`} className="rounded p-0.5 text-[#626f86] hover:bg-red-100 dark:hover:bg-red-900/30">
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          ))}
        </div>
      )}

      {blockers.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-[#44546f] dark:text-[#8c9bab]">
            <AlertTriangle className="h-3 w-3 text-amber-500" />
            {t('kanbanCardDetailModal.blockers.blocking')}
          </div>
          {blockers.map(card => (
            <div key={card.id} className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs dark:bg-amber-900/20">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              <span className="flex-1 truncate text-[#172b4d] dark:text-[#b6c2cf]">{card.title}</span>
              <a href={`/board/${card.boardId}/card/${card.id}`} className="rounded p-0.5 text-[#626f86] hover:bg-amber-100 dark:hover:bg-amber-900/30">
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          ))}
        </div>
      )}

      {blockedBy.length === 0 && blockers.length === 0 && (
        <p className="py-2 text-center text-xs text-[#626f86] dark:text-[#8c9bab]">
          {t('kanbanCardDetailModal.blockers.none')}
        </p>
      )}
    </div>
  );
}
