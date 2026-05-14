// flowbuilder/src/components/kanban/CalendarView.tsx
import React, { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { KanbanList, KanbanCard } from '@/services/kanban.service';
import { useTranslation } from 'react-i18next';

interface Props {
  lists: KanbanList[];
  onCardClick: (card: KanbanCard) => void;
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTHS = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro',
];

export const CalendarView: React.FC<Props> = ({
  lists,
  onCardClick,
}) => {
  const { t } = useTranslation('flow-builder');
  const [current, setCurrent] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const allCards = useMemo(() => lists.flatMap(l => l.cards.filter(c => c.dueDate)), [lists]);

  const hasCardsThisMonth = useMemo(() => {
    return allCards.some(card => {
      if (!card.dueDate) return false;
      const d = new Date(card.dueDate);
      return d.getFullYear() === current.year && d.getMonth() === current.month;
    });
  }, [allCards, current]);

  const cardsByDay = useMemo(() => {
    const map = new Map<string, KanbanCard[]>();
    for (const card of allCards) {
      if (!card.dueDate) continue;
      const d = new Date(card.dueDate);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(card);
    }
    return map;
  }, [allCards]);

  const days = useMemo(() => {
    const firstDay = new Date(current.year, current.month, 1).getDay();
    const daysInMonth = new Date(current.year, current.month + 1, 0).getDate();
    const daysInPrevMonth = new Date(current.year, current.month, 0).getDate();

    const cells: Array<{ date: Date; isCurrentMonth: boolean }> = [];

    // Previous month days
    for (let i = firstDay - 1; i >= 0; i--) {
      cells.push({
        date: new Date(current.year, current.month - 1, daysInPrevMonth - i),
        isCurrentMonth: false,
      });
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(current.year, current.month, d), isCurrentMonth: true });
    }

    // Next month days to fill grid
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      cells.push({ date: new Date(current.year, current.month + 1, d), isCurrentMonth: false });
    }

    return cells;
  }, [current]);

  const prevMonth = () => {
    setCurrent(c => c.month === 0
      ? { year: c.year - 1, month: 11 }
      : { year: c.year, month: c.month - 1 });
  };

  const nextMonth = () => {
    setCurrent(c => c.month === 11
      ? { year: c.year + 1, month: 0 }
      : { year: c.year, month: c.month + 1 });
  };

  const today = new Date();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* View header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-[#626f86] dark:text-gray-400" />
          <h2 className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">{t('nodes.calendarView.tsx.calendario')}</h2>
        </div>
        <span className="text-xs text-[#626f86] dark:text-gray-400">{allCards.length} cards</span>
      </div>

      {/* Month navigation */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={prevMonth} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-gray-700 text-slate-600 dark:text-gray-400">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="text-base font-semibold text-slate-900 dark:text-white min-w-[180px] text-center">
            {MONTHS[current.month]} {current.year}
          </h2>
          <button onClick={nextMonth} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-gray-700 text-slate-600 dark:text-gray-400">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <button
          onClick={() => { const d = new Date(); setCurrent({ year: d.getFullYear(), month: d.getMonth() }); }}
          className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          Hoje
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto p-4">
        {/* Weekday headers */}
        <div className="mb-2 grid grid-cols-7 gap-1">
          {WEEKDAYS.map(d => (
            <div key={d} className="py-1 text-center text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400 dark:text-gray-500">
              {d}
            </div>
          ))}
        </div>

        {/* Cells or empty state */}
        {hasCardsThisMonth ? (
        <div className="grid grid-cols-7 gap-1">
          {days.map(({ date, isCurrentMonth }, i) => {
            const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
            const cards = cardsByDay.get(key) ?? [];
            const isToday = date.toDateString() === today.toDateString();
            const isPast = date < today && !isToday;

            return (
              <div
                key={i}
                className={`min-h-[96px] rounded-xl border p-1.5 ${
                  isToday
                    ? 'border-[#579dff] bg-[#e9efff] dark:border-[#579dff] dark:bg-[#1c2b41]'
                    : isCurrentMonth
                    ? 'border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-800'
                    : 'border-slate-100 bg-slate-50 dark:border-gray-800 dark:bg-gray-900'
                }`}
              >
                <div className={`mb-1 text-right text-[11px] font-semibold ${
                  isToday ? 'text-[#0c66e4] dark:text-[#579dff]'
                  : isCurrentMonth ? (isPast ? 'text-slate-400' : 'text-slate-700 dark:text-gray-300')
                  : 'text-slate-300 dark:text-gray-600'
                }`}>
                  {date.getDate()}
                </div>

                <div className="space-y-1">
                  {cards.slice(0, 3).map(card => {
                    const isOverdue = isPast && isCurrentMonth;
                    return (
                      <button
                        key={card.id}
                        onClick={() => onCardClick(card)}
                        title={card.title}
                        className={`w-full truncate rounded-md px-1.5 py-0.5 text-left text-[10px] font-medium text-white leading-tight transition-opacity hover:opacity-80 ${
                          isOverdue ? 'bg-[#f87168]' : 'bg-[#579dff]'
                        }`}
                      >
                        {card.labels[0] && (
                          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: card.labels[0].color }} />
                        )}
                        {card.title}
                      </button>
                    );
                  })}
                  {cards.length > 3 && (
                    <div className="px-1 text-[10px] text-slate-400 dark:text-gray-500">
                      +{cards.length - 3} mais
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-[#8590a2] dark:text-gray-500">
            <Calendar className="mb-2 h-8 w-8 opacity-40" />
            <p className="text-sm font-medium">{t('nodes.calendarView.tsx.nenhumCardComPrazoNesteMes')}</p>
            <p className="mt-1 text-xs">{t('nodes.calendarView.tsx.definaDatasDeVencimentoNosCardsParaVeLosAqui')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
