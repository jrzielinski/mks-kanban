// flowbuilder/src/components/kanban/TimelineView.tsx
// @ts-ignore
import React, { useState, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { KanbanList, KanbanCard } from '@/services/kanban.service';
import { useTranslation } from 'react-i18next';

interface Props {
  lists: KanbanList[];
  onCardClick: (card: KanbanCard) => void;
}

const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const WEEK_MS = 7 * 86400000;
const DAY_PX = 28; // pixels per day

function toDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export const TimelineView: React.FC<Props> = ({
  lists,
  onCardClick,
}) => {
  const { t } = useTranslation('flow-builder');
  const today = useMemo(() => startOfDay(new Date()), []);

  // Window: 3 months centered around today
  const [windowStart, setWindowStart] = useState(() => {
    const d = new Date(today);
    d.setMonth(d.getMonth() - 1);
    d.setDate(1);
    return startOfDay(d);
  });

  const windowDays = 91; // ~3 months
  const windowEnd = useMemo(() => new Date(windowStart.getTime() + windowDays * 86400000), [windowStart]);

  const scrollBy = (weeks: number) => {
    setWindowStart(d => new Date(d.getTime() + weeks * WEEK_MS));
  };

  // Build day headers
  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < windowDays; i++) {
      arr.push(new Date(windowStart.getTime() + i * 86400000));
    }
    return arr;
  }, [windowStart]);

  // Month groups for header
  const monthGroups = useMemo(() => {
    const groups: { label: string; span: number }[] = [];
    let currentMonth = -1;
    let span = 0;
    for (const d of days) {
      if (d.getMonth() !== currentMonth) {
        if (span > 0) groups.push({ label: `${MONTHS[currentMonth]}`, span });
        currentMonth = d.getMonth();
        span = 1;
      } else { span++; }
    }
    if (span > 0) groups.push({ label: `${MONTHS[currentMonth]}`, span });
    return groups;
  }, [days]);

  const dayOffset = (d: Date): number =>
    Math.round((startOfDay(d).getTime() - windowStart.getTime()) / 86400000);

  // Cards with startDate or dueDate in window
  const rows = useMemo(() => {
    const result: { list: KanbanList; card: KanbanCard; start: number; end: number; width: number }[] = [];
    for (const list of lists) {
      for (const card of list.cards) {
        const startD = toDate(card.startDate) ?? toDate(card.dueDate);
        const endD = toDate(card.dueDate) ?? toDate(card.startDate);
        if (!startD && !endD) continue;
        const s = dayOffset(startD ?? endD!);
        const e = dayOffset(endD ?? startD!);
        // Only show if overlaps window
        if (e < 0 || s >= windowDays) continue;
        const clampedS = Math.max(s, 0);
        const clampedE = Math.min(e, windowDays - 1);
        result.push({ list, card, start: clampedS, end: clampedE, width: Math.max(clampedE - clampedS + 1, 1) });
      }
    }
    return result;
  }, [lists, windowStart]);

  const todayOffset = dayOffset(today);
  const gridWidth = windowDays * DAY_PX;

  const hasSomeCardsWithDates = useMemo(() => {
    return lists.some(list => list.cards.some(card => card.dueDate || card.startDate));
  }, [lists]);

  const listGroups = useMemo(() => {
    const groups: { list: KanbanList; rows: typeof rows }[] = [];
    for (const list of lists) {
      const listRows = rows.filter(r => r.list.id === list.id);
      if (listRows.length > 0) groups.push({ list, rows: listRows });
    }
    return groups;
  }, [lists, rows]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* View header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-[#626f86] dark:text-gray-400" />
          <h2 className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">Timeline</h2>
        </div>
        <span className="text-xs text-[#626f86] dark:text-gray-400">{rows.length} cards com datas</span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-slate-200 dark:border-gray-700 px-4 py-3 flex-shrink-0">
        <button onClick={() => scrollBy(-2)} className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-gray-700 text-slate-600 dark:text-gray-400">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          onClick={() => setWindowStart(() => { const d = new Date(today); d.setMonth(d.getMonth() - 1); d.setDate(1); return startOfDay(d); })}
          className="rounded-lg px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          Hoje
        </button>
        <button onClick={() => scrollBy(2)} className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-gray-700 text-slate-600 dark:text-gray-400">
          <ChevronRight className="h-4 w-4" />
        </button>
        <span className="text-sm text-[#626f86] dark:text-gray-400">
          {windowStart.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })} –{' '}
          {windowEnd.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
        </span>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <div style={{ minWidth: gridWidth + 180 }}>
          {/* Header: months */}
          <div className="sticky top-0 z-20 flex bg-white dark:bg-gray-800 border-b border-slate-200 dark:border-gray-700">
            <div className="w-44 flex-shrink-0 border-r border-slate-200 dark:border-gray-700" />
            <div className="flex">
              {monthGroups.map((g, i) => (
                <div key={i} className="flex items-center border-r border-slate-200/50 dark:border-gray-700/50 px-2 py-1.5 text-xs font-semibold text-[#44546f] dark:text-gray-400" style={{ width: g.span * DAY_PX }}>
                  {g.label}
                </div>
              ))}
            </div>
          </div>

          {/* Header: days */}
          <div className="sticky top-[33px] z-20 flex bg-[#f8fafc] dark:bg-gray-900 border-b border-slate-200 dark:border-gray-700">
            <div className="w-44 flex-shrink-0 border-r border-slate-200 dark:border-gray-700" />
            <div className="flex relative" style={{ width: gridWidth }}>
              {days.map((d, i) => {
                const isToday = d.toDateString() === today.toDateString();
                const isSun = d.getDay() === 0;
                return (
                  <div
                    key={i}
                    className={`flex items-center justify-center border-r text-[10px] font-medium ${
                      isToday ? 'bg-[#e9efff] text-[#0c66e4] dark:bg-[#1c2b41] dark:text-[#579dff]' :
                      isSun ? 'text-[#f87168]' : 'text-[#8590a2] dark:text-gray-500'
                    } border-slate-100 dark:border-gray-800`}
                    style={{ width: DAY_PX, height: 24 }}
                  >
                    {d.getDate()}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Rows per list */}
          {!hasSomeCardsWithDates ? (
            <div className="flex flex-col items-center justify-center py-16 text-[#8590a2] dark:text-gray-500">
              <Clock className="mb-2 h-8 w-8 opacity-40" />
              <p className="text-sm font-medium">Nenhum card com prazo definido</p>
              <p className="mt-1 text-xs">{t('nodes.timelineView.tsx.definaDatasNosCardsParaVeLosNaTimeline')}</p>
            </div>
          ) : hasSomeCardsWithDates && rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-[#8590a2] dark:text-gray-500">
              <Clock className="mb-2 h-8 w-8 opacity-40" />
              <p className="text-sm font-medium">{t('nodes.timelineView.tsx.nenhumCardComPrazoNestePeriodo')}</p>
              <p className="mt-1 text-xs">Navegue para outros meses para ver os demais cards</p>
            </div>
          ) : listGroups.map(({ list, rows: listRows }) => (
            <div key={list.id}>
              {/* List header */}
              <div className="flex items-center border-b border-slate-100 dark:border-gray-800 bg-[#f3f5f8] dark:bg-gray-900/50">
                <div className="w-44 flex-shrink-0 border-r border-slate-200 dark:border-gray-700 px-3 py-2">
                  <span className="text-xs font-semibold text-[#44546f] dark:text-gray-400 truncate block">{list.title}</span>
                </div>
                <div className="relative" style={{ width: gridWidth, height: 28 }}>
                  {/* Weekend stripes */}
                  {days.map((d, i) => d.getDay() === 0 || d.getDay() === 6 ? (
                    <div key={i} className="absolute top-0 bottom-0 bg-[#f87168]/5" style={{ left: i * DAY_PX, width: DAY_PX }} />
                  ) : null)}
                  {/* Today line */}
                  {todayOffset >= 0 && todayOffset < windowDays && (
                    <div className="absolute top-0 bottom-0 w-0.5 bg-[#579dff]/60 z-10" style={{ left: todayOffset * DAY_PX + DAY_PX / 2 }} />
                  )}
                </div>
              </div>

              {/* Card rows */}
              {listRows.map(({ card, start, width }) => {
                const isOverdue = card.dueDate && new Date(card.dueDate) < today;
                return (
                  <div key={card.id} className="flex items-center border-b border-slate-50 dark:border-gray-800/50 hover:bg-[#f8fafc] dark:hover:bg-gray-800/30 group">
                    <div className="w-44 flex-shrink-0 border-r border-slate-200 dark:border-gray-700 px-3 py-1.5 cursor-pointer" onClick={() => onCardClick(card)}>
                      <span className="truncate block text-xs font-medium text-[#172b4d] dark:text-gray-200 group-hover:text-[#0c66e4] dark:group-hover:text-[#85b8ff]">{card.title}</span>
                    </div>
                    <div className="relative" style={{ width: gridWidth, height: 32 }}>
                      {/* Weekend stripes */}
                      {days.map((d, i) => d.getDay() === 0 || d.getDay() === 6 ? (
                        <div key={i} className="absolute top-0 bottom-0 bg-[#f87168]/5" style={{ left: i * DAY_PX, width: DAY_PX }} />
                      ) : null)}
                      {/* Today line */}
                      {todayOffset >= 0 && todayOffset < windowDays && (
                        <div className="absolute top-0 bottom-0 w-0.5 bg-[#579dff]/40 z-10" style={{ left: todayOffset * DAY_PX + DAY_PX / 2 }} />
                      )}
                      {/* Bar */}
                      <button
                        onClick={() => onCardClick(card)}
                        className={`absolute top-2 bottom-2 rounded-md text-[10px] font-medium text-white truncate px-1.5 hover:opacity-90 transition-opacity z-10 shadow-sm ${isOverdue ? 'bg-[#f87168] dark:bg-[#e85d54]' : 'bg-[#579dff] dark:bg-[#4c8ef5]'}`}
                        style={{ left: start * DAY_PX + 2, width: Math.max(width * DAY_PX - 4, 8) }}
                        title={card.title}
                      >
                        {width * DAY_PX > 40 ? card.title : ''}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
