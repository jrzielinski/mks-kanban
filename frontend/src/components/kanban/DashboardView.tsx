// flowbuilder/src/components/kanban/DashboardView.tsx
import React, { useMemo } from 'react';
import { KanbanList, KanbanBoardMember, KanbanCard } from '@/services/kanban.service';
import { CheckSquare, Calendar, Users, AlertTriangle, TrendingUp, BarChart2, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  lists: KanbanList[];
  boardMembers: KanbanBoardMember[];
  onCardClick?: (card: KanbanCard) => void;
}

function StatCard({ label, value, sub, icon, color }: { label: string; value: number | string; sub?: string; icon: React.ReactNode; color: string }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold text-[#172b4d] dark:text-white">{value}</p>
        <p className="text-xs text-[#626f86] dark:text-gray-400">{label}</p>
        {sub && <p className="text-[10px] text-[#8590a2] dark:text-gray-500">{sub}</p>}
      </div>
    </div>
  );
}

export const DashboardView: React.FC<Props> = ({
  lists,
  boardMembers,
  onCardClick,
}) => {
  const { t } = useTranslation('flow-builder');
  const stats = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 86400000);

    let totalCards = 0;
    let overdueCards = 0;
    let dueToday = 0;
    let doneChecklists = 0;
    let totalChecklistItems = 0;
    const byList: { title: string; count: number; color: string }[] = [];
    const byMember: Record<string, number> = {};
    let recentCards = 0;

    for (const list of lists) {
      byList.push({ title: list.title, count: list.cards.length, color: `hsl(${(lists.indexOf(list) * 47) % 360}, 65%, 55%)` });
      for (const card of list.cards) {
        totalCards++;
        if (card.dueDate) {
          const d = new Date(card.dueDate);
          if (d < today) overdueCards++;
          const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
          if (dDay.getTime() === today.getTime()) dueToday++;
        }
        const allItems = card.checklists?.flatMap(g => g.items) ?? card.checklist ?? [];
        doneChecklists += allItems.filter(i => i.done).length;
        totalChecklistItems += allItems.length;
        for (const mId of card.memberIds ?? []) {
          byMember[mId] = (byMember[mId] || 0) + 1;
        }
        if (card.createdAt && new Date(card.createdAt) >= weekAgo) recentCards++;
      }
    }

    const checklistPct = totalChecklistItems > 0 ? Math.round(doneChecklists / totalChecklistItems * 100) : 0;
    const maxListCount = Math.max(...byList.map(l => l.count), 1);

    const topMembers = Object.entries(byMember)
      .sort(([,a],[,b]) => b - a)
      .slice(0, 5)
      .map(([id, count]) => ({ member: boardMembers.find(m => m.id === id), count }));

    const overdueCardList: KanbanCard[] = [];
    const dueTodayCardList: KanbanCard[] = [];
    for (const list of lists) {
      for (const card of list.cards) {
        if (!card.dueDate) continue;
        const d = new Date(card.dueDate);
        const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (dDay < today) overdueCardList.push(card);
        else if (dDay.getTime() === today.getTime()) dueTodayCardList.push(card);
      }
    }

    return { totalCards, overdueCards, dueToday, checklistPct, doneChecklists, totalChecklistItems, byList, topMembers, recentCards, maxListCount, overdueCardList, dueTodayCardList };
  }, [lists, boardMembers]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* View header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-[#626f86] dark:text-gray-400" />
          <h2 className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">Dashboard</h2>
        </div>
        <span className="text-xs text-[#626f86] dark:text-gray-400">{stats.totalCards} cards</span>
      </div>

      <div className="flex-1 overflow-auto p-5 space-y-5">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total de cards" value={stats.totalCards} icon={<BarChart2 className="h-5 w-5 text-white" />} color="bg-[#579dff]" />
        <StatCard label="Atrasados" value={stats.overdueCards} sub={stats.totalCards > 0 ? `${Math.round(stats.overdueCards/stats.totalCards*100)}% do total` : undefined} icon={<AlertTriangle className="h-5 w-5 text-white" />} color="bg-[#f87168]" />
        <StatCard label="Vencem hoje" value={stats.dueToday} icon={<Calendar className="h-5 w-5 text-white" />} color="bg-[#f5cd47]" />
        <StatCard label="Criados (7 dias)" value={stats.recentCards} icon={<TrendingUp className="h-5 w-5 text-white" />} color="bg-[#4bce97]" />
      </div>

      {/* Overdue and due-today card lists */}
      {(stats.overdueCardList.length > 0 || stats.dueTodayCardList.length > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {stats.overdueCardList.length > 0 && (
            <div className="rounded-2xl border border-[#f87168]/30 bg-white p-4 dark:border-[#f87168]/20 dark:bg-gray-800">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#ae2a19] dark:text-[#f87168]">
                <AlertTriangle className="h-4 w-4" />
                Atrasados ({stats.overdueCardList.length})
              </h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {stats.overdueCardList.map(card => (
                  <div
                    key={card.id}
                    onClick={() => onCardClick?.(card)}
                    className="cursor-pointer rounded-lg px-3 py-2 text-sm text-[#172b4d] hover:bg-[#fff0ee] dark:text-gray-200 dark:hover:bg-[#f87168]/10 transition-colors"
                  >
                    {card.title}
                  </div>
                ))}
              </div>
            </div>
          )}
          {stats.dueTodayCardList.length > 0 && (
            <div className="rounded-2xl border border-[#f5cd47]/40 bg-white p-4 dark:border-[#f5cd47]/20 dark:bg-gray-800">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#7f5f01] dark:text-[#f5cd47]">
                <Calendar className="h-4 w-4" />
                Vencem hoje ({stats.dueTodayCardList.length})
              </h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {stats.dueTodayCardList.map(card => (
                  <div
                    key={card.id}
                    onClick={() => onCardClick?.(card)}
                    className="cursor-pointer rounded-lg px-3 py-2 text-sm text-[#172b4d] hover:bg-[#fffae6] dark:text-gray-200 dark:hover:bg-[#f5cd47]/10 transition-colors"
                  >
                    {card.title}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Cards por lista (bar chart) */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-3 text-sm font-semibold text-[#172b4d] dark:text-gray-100">Cards por lista</h3>
          <div className="space-y-2">
            {stats.byList.map(({ title, count, color }) => (
              <div key={title}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="truncate font-medium text-[#44546f] dark:text-gray-400">{title}</span>
                  <span className="ml-2 flex-shrink-0 font-bold text-[#172b4d] dark:text-white">{count}</span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#f1f2f4] dark:bg-gray-700">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${(count / stats.maxListCount) * 100}%`, background: color }}
                  />
                </div>
              </div>
            ))}
            {stats.byList.length === 0 && (
              <div className="flex flex-col items-center justify-center py-6 text-[#8590a2] dark:text-gray-500">
                <LayoutGrid className="mb-1.5 h-6 w-6 opacity-40" />
                <p className="text-xs">Nenhuma lista encontrada</p>
              </div>
            )}
          </div>
        </div>

        {/* Progresso de checklists */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-3 text-sm font-semibold text-[#172b4d] dark:text-gray-100">Progresso de checklists</h3>
          {stats.totalChecklistItems === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-[#8590a2] dark:text-gray-500">
              <CheckSquare className="mb-1.5 h-6 w-6 opacity-40" />
              <p className="text-xs">Nenhum item de checklist</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-4">
              <div className="relative mb-4 h-28 w-28">
                <svg viewBox="0 0 36 36" className="h-28 w-28 -rotate-90">
                  <circle cx="18" cy="18" r="15.9" fill="none" stroke="#f1f2f4" strokeWidth="3" className="dark:stroke-gray-700" />
                  <circle
                    cx="18" cy="18" r="15.9" fill="none"
                    stroke={stats.checklistPct === 100 ? '#1f845a' : '#579dff'}
                    strokeWidth="3"
                    strokeDasharray={`${stats.checklistPct} 100`}
                    strokeLinecap="round"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-2xl font-bold text-[#172b4d] dark:text-white">{stats.checklistPct}%</span>
                </div>
              </div>
              <p className="text-sm text-[#626f86] dark:text-gray-400">
                {stats.doneChecklists} de {stats.totalChecklistItems} itens concluídos
              </p>
            </div>
          )}
        </div>

        {/* Top membros */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-3 text-sm font-semibold text-[#172b4d] dark:text-gray-100">Cards por membro</h3>
          <div className="space-y-2.5">
            {stats.topMembers.length === 0 && (
              <div className="flex flex-col items-center py-4 text-[#8590a2] dark:text-gray-500">
                <Users className="mb-1 h-6 w-6 opacity-40" />
                <p className="text-xs">{t('nodes.dashboardView.tsx.nenhumMembroAtribuido')}</p>
              </div>
            )}
            {stats.topMembers.map(({ member, count }, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: member?.avatarColor || '#579dff' }}>
                  {member ? member.name.slice(0,2).toUpperCase() : '?'}
                </span>
                <span className="flex-1 truncate text-sm text-[#44546f] dark:text-gray-300">{member?.name ?? 'Membro removido'}</span>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[#f1f2f4] dark:bg-gray-700">
                    <div className="h-full rounded-full bg-[#579dff]" style={{ width: `${(count / (stats.topMembers[0]?.count || 1)) * 100}%` }} />
                  </div>
                  <span className="w-4 text-right text-xs font-bold text-[#172b4d] dark:text-white">{count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Distribuição de vencimentos */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="mb-3 text-sm font-semibold text-[#172b4d] dark:text-gray-100">Status de vencimentos</h3>
          {(() => {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const weekEnd = new Date(today.getTime() + 7 * 86400000);
            let noDate = 0, overdue = 0, dueToday = 0, thisWeek = 0, future = 0;
            for (const list of lists) {
              for (const card of list.cards) {
                if (!card.dueDate) { noDate++; continue; }
                const d = new Date(card.dueDate);
                const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                if (dDay < today) overdue++;
                else if (dDay.getTime() === today.getTime()) dueToday++;
                else if (d < weekEnd) thisWeek++;
                else future++;
              }
            }
            const items = [
              { label: 'Sem data', count: noDate, color: '#8590a2' },
              { label: 'Atrasados', count: overdue, color: '#f87168' },
              { label: 'Hoje', count: dueToday, color: '#f5cd47' },
              { label: 'Essa semana', count: thisWeek, color: '#4bce97' },
              { label: 'Futuro', count: future, color: '#579dff' },
            ];
            const maxCount = Math.max(...items.map(i => i.count), 1);
            return (
              <div className="space-y-2">
                {items.map(item => (
                  <div key={item.label} className="flex items-center gap-2">
                    <span className="w-20 flex-shrink-0 text-xs text-[#626f86] dark:text-gray-400">{item.label}</span>
                    <div className="flex-1 overflow-hidden rounded-full bg-[#f1f2f4] dark:bg-gray-700" style={{ height: '8px' }}>
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(item.count / maxCount) * 100}%`, background: item.color }} />
                    </div>
                    <span className="w-6 text-right text-xs font-bold text-[#172b4d] dark:text-white">{item.count}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>
      </div>
    </div>
  );
};
