import { useState } from 'react';
import type { KanbanCard, KanbanCardSearchResult } from '@/services/kanban.service';
import { useTranslation } from 'react-i18next';
import { Link, Unlink, Search, ExternalLink } from 'lucide-react';
import kanbanService from '@/services/kanban.service';

interface LinkedCardsSectionProps {
  cardId: string;
  linkedCards: KanbanCard[];
  onUpdated: (card: any) => void;
  boardId: string;
}

export default function LinkedCardsSection({ cardId, linkedCards, onUpdated }: LinkedCardsSectionProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<KanbanCardSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!search.trim()) return;
    setLoading(true);
    try {
      const cards = await kanbanService.searchCards(search.trim());
      setResults(cards.filter(c => c.id !== cardId));
    } catch { /* toast */ }
    setLoading(false);
  };

  const handleLink = async (targetId: string) => {
    try {
      await kanbanService.linkCards(cardId, targetId);
      onUpdated({ _refresh: true });
    } catch { /* toast */ }
  };

  const handleUnlink = async (targetId: string) => {
    try {
      await kanbanService.unlinkCard(cardId, targetId);
      onUpdated({ _refresh: true });
    } catch { /* toast */ }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf] mb-2">
        <Link className="h-4 w-4 text-[#44546f] dark:text-[#8c9bab]" />
        {t('kanbanCardDetailModal.linkedCards.title')} ({linkedCards.length})
      </div>

      {linkedCards.map(card => (
        <div key={card.id} className="flex items-center justify-between rounded-xl bg-[#091e420f] px-3 py-2 dark:bg-[#ffffff1f]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: '#aaa' }} />
            <span className="text-xs text-[#172b4d] dark:text-[#b6c2cf] truncate">{card.title}</span>
          </div>
          <div className="flex items-center gap-1">
            <a href={`/board/${card.boardId}/card/${card.id}`} className="rounded p-1 text-[#626f86] hover:bg-[#091e4224] dark:hover:bg-[#ffffff1f]">
              <ExternalLink className="h-3 w-3" />
            </a>
            <button onClick={() => handleUnlink(card.id)} className="rounded p-1 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
              <Unlink className="h-3 w-3" />
            </button>
          </div>
        </div>
      ))}

      <div className="flex gap-2">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder={t('kanbanCardDetailModal.placeholders.searchCard')}
          className="min-w-0 flex-1 rounded-lg border border-[#dcdfe4] bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
        <button onClick={handleSearch} disabled={loading}
          className="rounded-lg bg-[#579dff] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-50">
          <Search className="h-3.5 w-3.5" />
        </button>
      </div>

      {results.length > 0 && (
        <div className="max-h-40 overflow-y-auto space-y-1 rounded-xl bg-[#091e420f] p-2 dark:bg-[#ffffff0a]">
          {results.map(card => (
            <button key={card.id} onClick={() => handleLink(card.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-[#deebff] dark:hover:bg-[#1c2b41]">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: '#aaa' }} />
              <span className="truncate text-[#172b4d] dark:text-gray-300">{card.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
