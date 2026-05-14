import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff } from 'lucide-react';
import kanbanService from '@/services/kanban.service';

interface SnoozeSectionProps {
  cardId: string;
  snoozedUntil: string | null;
  onUpdated: (card: any) => void;
  boardId: string;
}

export default function SnoozeSection({ cardId, snoozedUntil, onUpdated }: SnoozeSectionProps) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const [date, setDate] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSnooze = async () => {
    if (!date) return;
    setLoading(true);
    try {
      const updated = await kanbanService.snoozeCard(cardId, new Date(date).toISOString());
      onUpdated(updated);
      setShow(false);
    } catch {
      // toast handled elsewhere
    }
    setLoading(false);
  };

  const handleClear = async () => {
    setLoading(true);
    try {
      const updated = await kanbanService.unsnoozeCard(cardId);
      onUpdated(updated);
    } catch {
      // toast
    }
    setLoading(false);
  };

  if (snoozedUntil) {
    return (
      <button
        onClick={handleClear}
        disabled={loading}
        className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-amber-600 transition-colors hover:bg-amber-100 dark:bg-[#ffffff1f] dark:text-amber-400 dark:hover:bg-amber-900/30"
      >
        <BellOff className="h-4 w-4" />
        {t('kanbanCardDetailModal.snooze.snoozedUntil', { date: new Date(snoozedUntil).toLocaleDateString() })}
      </button>
    );
  }

  return (
    <>
      <button
        onClick={() => setShow(!show)}
        className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-[#44546f] transition-colors hover:bg-amber-100 hover:text-amber-700 dark:bg-[#ffffff1f] dark:text-[#8c9bab] dark:hover:bg-amber-900/30 dark:hover:text-amber-400"
      >
        <Bell className="h-4 w-4" /> {t('kanbanCardDetailModal.snooze.snoozeCard')}
      </button>
      {show && (
        <div className="rounded-xl bg-[#091e420f] p-3 dark:bg-[#ffffff0a]">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-[#dcdfe4] bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
            />
            <button
              onClick={handleSnooze}
              disabled={!date || loading}
              className="rounded-lg bg-[#579dff] px-3 py-1 text-xs font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-50"
            >
              {t('kanbanCardDetailModal.snooze.snoozeButton')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
