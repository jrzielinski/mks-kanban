import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Timer, Plus } from 'lucide-react';
import kanbanService from '@/services/kanban.service';

interface TimeLogEntry {
  id: string;
  hours: number;
  date: string;
  description?: string;
  userId: string;
  userName?: string;
}

interface TimeLogsSectionProps {
  cardId: string;
  timeLogs: TimeLogEntry[];
  maxHours?: number | null;
  onUpdated: (card: any) => void;
  boardId: string;
}

export default function TimeLogsSection({ cardId, timeLogs, maxHours, onUpdated }: TimeLogsSectionProps) {
  const { t, i18n } = useTranslation();
  const [showForm, setShowForm] = useState(false);
  const [hours, setHours] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);

  const totalLogged = timeLogs.reduce((s, l) => s + l.hours, 0);
  const pct = maxHours && maxHours > 0 ? Math.min(100, (totalLogged / maxHours) * 100) : 0;
  const isOver = maxHours != null && totalLogged > maxHours;

  const handleSubmit = async () => {
    const h = parseFloat(hours);
    if (!h || h <= 0) return;
    setSubmitting(true);
    try {
      const updated = await kanbanService.addTimeLog(cardId, { hours: h, loggedDate: new Date(date).toISOString() });
      onUpdated(updated);
      setHours('');
      setShowForm(false);
    } catch {
      // toast handled externally
    }
    setSubmitting(false);
  };

  return (
    <section className="mb-4 rounded-[22px] border border-[#e2e6ea] bg-white p-5 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">
          <Timer className="h-4 w-4 text-[#44546f] dark:text-[#8c9bab]" /> {t('kanbanCardDetailModal.timeLog.title')}
          {timeLogs.length > 0 && (
            <span className="ml-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
              {totalLogged.toFixed(1)}h{maxHours != null ? ` / ${maxHours}h` : ` ${t('kanbanCardDetailModal.timeLog.total')}`}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-1 rounded-xl bg-[#091e420f] px-2.5 py-1 text-xs font-medium text-[#44546f] hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:text-[#8c9bab]"
        >
          <Plus className="w-3 h-3" /> {t('kanbanCardDetailModal.timeLog.registerButton')}
        </button>
      </div>

      {maxHours != null && maxHours > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-[#626f86] dark:text-[#8c9bab]">
            <span>{t('kanbanCardDetailModal.timeLog.consumed', { logged: totalLogged.toFixed(1), max: maxHours })}</span>
            <span className={isOver ? 'font-bold text-red-500' : ''}>
              {isOver ? t('kanbanCardDetailModal.timeLog.overLimit', { hours: (totalLogged - maxHours).toFixed(1) }) : t('kanbanCardDetailModal.timeLog.remaining', { hours: (maxHours - totalLogged).toFixed(1) })}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#e2e6ea] dark:bg-[#3b4754]">
            <div className={`h-full rounded-full transition-all ${isOver ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-violet-500'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {showForm && (
        <div className="mb-4 rounded-xl border border-[#d8dee6] bg-[#f8fafc] p-3 dark:border-[#3b4754] dark:bg-[#22272b]">
          {maxHours != null && totalLogged + (parseFloat(hours) || 0) > maxHours && (
            <div className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 dark:bg-amber-900/20 dark:border-amber-800">
              <p className="text-[11px] text-amber-700 dark:text-amber-300">{t('kanbanCardDetailModal.timeLog.budgetWarning', { max: maxHours })}</p>
            </div>
          )}
          <div className="mb-2 flex flex-wrap gap-2">
            <div className="flex flex-col gap-1 flex-1 min-w-[80px]">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-[#44546f] dark:text-[#8c9bab]">
                {t('kanbanCardDetailModal.timeLog.hoursLabel')} <span className="normal-case font-normal text-[#8590a2]">{t('kanbanCardDetailModal.timeLog.hoursHint')}</span>
              </label>
              <input type="number" min="0.25" step="0.25" value={hours} onChange={e => setHours(e.target.value)}
                className="rounded-lg border border-[#d8dee6] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-violet-400 dark:border-[#3b4754] dark:bg-[#1b2024] dark:text-[#b6c2cf]" />
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[120px]">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.timeLog.dateLabel')}</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="rounded-lg border border-[#d8dee6] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-violet-400 dark:border-[#3b4754] dark:bg-[#1b2024] dark:text-[#b6c2cf]" />
            </div>
          </div>
          <button onClick={handleSubmit} disabled={submitting || !hours}
            className="w-full rounded-lg bg-violet-600 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
            {submitting ? t('common.saving') : t('kanbanCardDetailModal.timeLog.registerButton')}
          </button>
        </div>
      )}

      {timeLogs.length > 0 && (
        <div className="space-y-1.5">
          {timeLogs.map(log => (
            <div key={log.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-xs text-[#44546f] dark:text-[#8c9bab]">
              <span className="font-medium">{log.hours.toFixed(1)}h</span>
              <span className="text-[#626f86] dark:text-[#596773]">{log.description || new Date(log.date).toLocaleDateString(i18n.language)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
