import { useTranslation } from 'react-i18next';

interface KanbanRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  dayOfWeek?: number;
  dayOfMonth?: number;
}

interface RecurrenceSectionProps {
  recurrence: KanbanRecurrence | null;
  onSave: (rec: KanbanRecurrence | null) => Promise<void>;
}

export function RecurrenceSection({ recurrence, onSave }: RecurrenceSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">
          {t('kanbanCardDetailModal.sidebar.recurrenceFrequency')}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {[
            { value: null, label: t('kanbanCardDetailModal.sidebar.recurrenceNone') },
            { value: 'daily', label: t('kanbanCardDetailModal.sidebar.recurrenceDaily') },
            { value: 'weekly', label: t('kanbanCardDetailModal.sidebar.recurrenceWeekly') },
            { value: 'monthly', label: t('kanbanCardDetailModal.sidebar.recurrenceMonthly') },
          ].map(opt => (
            <button
              key={String(opt.value)}
              onClick={() => void onSave(opt.value ? { frequency: opt.value as KanbanRecurrence['frequency'] } : null)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                (recurrence?.frequency ?? null) === opt.value
                  ? 'bg-[#0c66e4] text-white'
                  : 'bg-[#f1f2f4] text-[#44546f] hover:bg-[#e0e2e5] dark:bg-[#2c333a] dark:text-[#8c9bab]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {recurrence?.frequency === 'weekly' && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">
            {t('kanbanCardDetailModal.sidebar.dayOfWeek')}
          </p>
          <div className="flex gap-1">
            {['D','S','T','Q','Q','S','S'].map((d, i) => (
              <button
                key={i}
                onClick={() => void onSave({ ...recurrence, dayOfWeek: i })}
                className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold ${
                  recurrence.dayOfWeek === i
                    ? 'bg-[#0c66e4] text-white'
                    : 'bg-[#f1f2f4] text-[#44546f] hover:bg-[#e0e2e5] dark:bg-[#2c333a] dark:text-[#8c9bab]'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      {recurrence?.frequency === 'monthly' && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">
            {t('kanbanCardDetailModal.sidebar.dayOfMonth')}
          </p>
          <input
            type="number" min={1} max={31}
            value={recurrence.dayOfMonth ?? 1}
            onChange={e => void onSave({ ...recurrence, dayOfMonth: parseInt(e.target.value) || 1 })}
            className="w-20 rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
          />
        </div>
      )}

      {recurrence && (
        <p className="text-[10px] text-[#8590a2] dark:text-[#6c7a89]">
          {t('kanbanCardDetailModal.sidebar.recurrenceAutoCreate')}
        </p>
      )}
    </div>
  );
}
