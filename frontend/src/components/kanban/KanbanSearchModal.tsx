// flowbuilder/src/components/kanban/KanbanSearchModal.tsx
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Search, X, Calendar, Layout, SlidersHorizontal, ChevronDown } from 'lucide-react';
import kanbanService, { KanbanCardSearchResult, KanbanBoardMember, KanbanWorkspace } from '@/services/kanban.service';

const LABEL_COLORS = [
  '#4bce97', '#f5cd47', '#fea362', '#f87168',
  '#9f8fef', '#579dff', '#6cc3e0', '#94c748',
  '#e774bb', '#8590a2',
];

interface Props {
  onClose: () => void;
  onCardClick: (card: KanbanCardSearchResult) => void;
  boardMembers?: KanbanBoardMember[];
  boardId?: string;
}

export const KanbanSearchModal: React.FC<Props> = ({ onClose, onCardClick, boardMembers = [], boardId }) => {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KanbanCardSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [workspaces, setWorkspaces] = useState<KanbanWorkspace[]>([]);
  // Filters
  const [filterMemberId, setFilterMemberId] = useState('');
  const [filterLabelColor, setFilterLabelColor] = useState('');
  const [filterDueBefore, setFilterDueBefore] = useState('');
  const [filterDueAfter, setFilterDueAfter] = useState('');
  const [filterHasAttachment, setFilterHasAttachment] = useState(false);
  const [filterIsOverdue, setFilterIsOverdue] = useState(false);
  const [filterWorkspaceId, setFilterWorkspaceId] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasActiveFilters = !!(filterMemberId || filterLabelColor || filterDueBefore || filterDueAfter || filterHasAttachment || filterIsOverdue || filterWorkspaceId);
  const isAdvanced = hasActiveFilters;

  useEffect(() => {
    inputRef.current?.focus();
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    kanbanService.listWorkspaces().then(setWorkspaces).catch(() => {});
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const hasQuery = query.trim().length > 0;
    if (!hasQuery && !hasActiveFilters) { setResults([]); return; }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        let r: KanbanCardSearchResult[];
        if (isAdvanced || (hasActiveFilters && !hasQuery)) {
          r = await kanbanService.advancedSearch({
            q: query.trim() || undefined,
            boardId: boardId || undefined,
            memberId: filterMemberId || undefined,
            labelColor: filterLabelColor || undefined,
            dueBefore: filterDueBefore || undefined,
            dueAfter: filterDueAfter || undefined,
            hasAttachment: filterHasAttachment || undefined,
            isOverdue: filterIsOverdue || undefined,
            workspaceId: filterWorkspaceId || undefined,
          });
        } else {
          r = await kanbanService.searchCards(query.trim());
        }
        setResults(r);
      } catch { /* silent */ }
      finally { setLoading(false); }
    }, 350);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filterMemberId, filterLabelColor, filterDueBefore, filterDueAfter, filterHasAttachment, filterIsOverdue, filterWorkspaceId]);

  const clearFilters = () => {
    setFilterMemberId('');
    setFilterLabelColor('');
    setFilterDueBefore('');
    setFilterDueAfter('');
    setFilterHasAttachment(false);
    setFilterIsOverdue(false);
    setFilterWorkspaceId('');
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center pt-16"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-[680px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800 mx-4">
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-gray-700 px-4 py-3">
          <Search className="h-5 w-5 flex-shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('kanbanSearchModal.searchPlaceholder')}
            className="flex-1 bg-transparent text-[15px] text-slate-900 outline-none placeholder-slate-400 dark:text-white dark:placeholder-gray-500"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-400 hover:text-slate-600 dark:hover:text-gray-300">
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => setShowFilters(f => !f)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              showFilters || hasActiveFilters
                ? 'bg-[#e9efff] text-[#0c66e4] dark:bg-[#1c2b41] dark:text-[#85b8ff]'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-400'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t('kanbanSearchModal.filtersButton')}
            {hasActiveFilters && <span className="rounded-full bg-[#0c66e4] px-1.5 text-[10px] text-white">{[filterMemberId, filterLabelColor, filterDueBefore, filterDueAfter, filterHasAttachment, filterIsOverdue, filterWorkspaceId].filter(Boolean).length}</span>}
            <ChevronDown className={`h-3 w-3 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>
          <button onClick={onClose} className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-500 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-400">
            Esc
          </button>
        </div>

        {/* Advanced Filters Panel */}
        {showFilters && (
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-850">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-gray-400">{t('kanbanSearchModal.advancedFilters')}</p>
              {hasActiveFilters && (
                <button onClick={clearFilters} className="text-[11px] text-[#0c66e4] hover:underline dark:text-[#85b8ff]">{t('kanbanSearchModal.clearFilters')}</button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {/* Member filter */}
              {boardMembers.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold text-slate-500 dark:text-gray-400">{t('kanbanSearchModal.memberLabel')}</p>
                  <select
                    value={filterMemberId}
                    onChange={e => setFilterMemberId(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  >
                    <option value="">{t('kanbanSearchModal.anyMember')}</option>
                    {boardMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              )}

              {/* Label color filter */}
              <div>
                <p className="mb-1 text-[11px] font-semibold text-slate-500 dark:text-gray-400">{t('kanbanSearchModal.labelLabel')}</p>
                <div className="flex flex-wrap gap-1">
                  {LABEL_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setFilterLabelColor(filterLabelColor === c ? '' : c)}
                      className="h-5 w-5 rounded transition-all hover:scale-110"
                      style={{ background: c, outline: filterLabelColor === c ? `3px solid ${c}` : 'none', outlineOffset: '2px', opacity: filterLabelColor && filterLabelColor !== c ? 0.4 : 1 }}
                    />
                  ))}
                </div>
              </div>

              {/* Due before */}
              <div>
                <p className="mb-1 text-[11px] font-semibold text-slate-500 dark:text-gray-400">{t('kanbanSearchModal.dueBefore')}</p>
                <input
                  type="date"
                  value={filterDueBefore}
                  onChange={e => setFilterDueBefore(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                />
              </div>

              {/* Due after */}
              <div>
                <p className="mb-1 text-[11px] font-semibold text-slate-500 dark:text-gray-400">{t('kanbanSearchModal.dueAfter')}</p>
                <input
                  type="date"
                  value={filterDueAfter}
                  onChange={e => setFilterDueAfter(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                />
              </div>

              {/* Workspace filter (B3) */}
              {workspaces.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold text-slate-500 dark:text-gray-400">{t('kanbanSearchModal.workspaceLabel')}</p>
                  <select
                    value={filterWorkspaceId}
                    onChange={e => setFilterWorkspaceId(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                  >
                    <option value="">{t('kanbanSearchModal.allWorkspaces')}</option>
                    {workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
                  </select>
                </div>
              )}

              {/* Checkboxes */}
              <div className="col-span-2 flex items-center gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-gray-300">
                  <input type="checkbox" checked={filterHasAttachment} onChange={e => setFilterHasAttachment(e.target.checked)} className="h-3.5 w-3.5 accent-[#579dff]" />
                  {t('kanbanSearchModal.hasAttachment')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-gray-300">
                  <input type="checkbox" checked={filterIsOverdue} onChange={e => setFilterIsOverdue(e.target.checked)} className="h-3.5 w-3.5 accent-red-500" />
                  {t('kanbanSearchModal.isOverdue')}
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Results */}
        <div className="max-h-[460px] overflow-y-auto">
          {loading ? (
            <div className="py-8 text-center text-sm text-slate-400 dark:text-gray-500">{t('kanbanSearchModal.searching')}</div>
          ) : results.length === 0 && (query.trim() || hasActiveFilters) ? (
            <div className="py-8 text-center text-sm text-slate-400 dark:text-gray-500">{t('kanbanSearchModal.noResults')}</div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400 dark:text-gray-500">
              {t('kanbanSearchModal.typeToSearch')}
            </div>
          ) : (
            <div className="p-2">
              <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-gray-500">
                {t('kanbanSearchModal.resultsCount', { count: results.length })}
              </p>
              {results.map(card => {
                const isOverdue = !!card.dueDate && new Date(card.dueDate) < new Date();
                const totalChecklist = (card.checklists ?? []).reduce((acc, g) => acc + (g.items?.length ?? 0), 0);
                const doneChecklist = (card.checklists ?? []).reduce((acc, g) => acc + (g.items?.filter(i => i.done)?.length ?? 0), 0);
                return (
                  <button
                    key={card.id}
                    onClick={() => { onCardClick(card); onClose(); }}
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-slate-100 dark:hover:bg-gray-700"
                  >
                    <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[#e9efff] text-[#0c66e4] dark:bg-[#1c2b41] dark:text-[#85b8ff]">
                      <Layout className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900 dark:text-white">{card.title}</p>
                      {/* Board + List breadcrumb */}
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="truncate max-w-[120px] rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-gray-700 dark:text-gray-400">{card.boardTitle}</span>
                        <span className="text-[10px] text-slate-300 dark:text-gray-600">›</span>
                        <span className="truncate max-w-[120px] text-[11px] text-slate-400 dark:text-gray-500">{card.listTitle}</span>
                      </div>
                      {card.description && (
                        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-gray-400">{card.description}</p>
                      )}
                      {/* Meta row: labels, checklist, attachments */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {card.labels.length > 0 && (
                          <div className="flex gap-0.5">
                            {card.labels.slice(0, 4).map((lbl, i) => (
                              <span key={i} className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: lbl.color }}>
                                {lbl.text || ''}
                              </span>
                            ))}
                          </div>
                        )}
                        {totalChecklist > 0 && (
                          <span className={`flex items-center gap-0.5 text-[10px] font-medium ${doneChecklist === totalChecklist ? 'text-green-500' : 'text-slate-400 dark:text-gray-500'}`}>
                            ☑ {doneChecklist}/{totalChecklist}
                          </span>
                        )}
                        {(card.attachments?.length ?? 0) > 0 && (
                          <span className="text-[10px] text-slate-400 dark:text-gray-500">📎 {card.attachments.length}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 flex-col items-end gap-1.5 ml-2">
                      {card.dueDate && (
                        <div className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${isOverdue ? 'bg-red-50 text-red-500 dark:bg-red-900/20 dark:text-red-400' : 'bg-slate-100 text-slate-500 dark:bg-gray-700 dark:text-gray-400'}`}>
                          <Calendar className="h-3 w-3" />
                          {new Date(card.dueDate).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                          {isOverdue && <span className="ml-0.5 text-[9px] font-bold uppercase">{t('kanbanSearchModal.overdueTag')}</span>}
                        </div>
                      )}
                      {/* Assignee avatars */}
                      {card.memberIds && card.memberIds.length > 0 && boardMembers.length > 0 && (
                        <div className="flex -space-x-1">
                          {card.memberIds.slice(0, 3).map(mId => {
                            const m = boardMembers.find(bm => bm.id === mId);
                            if (!m) return null;
                            return (
                              <div
                                key={mId}
                                title={m.name}
                                className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white text-[9px] font-bold text-white dark:border-gray-800"
                                style={{ background: (m as any).avatarColor || '#579dff' }}
                              >
                                {m.name[0].toUpperCase()}
                              </div>
                            );
                          })}
                          {card.memberIds.length > 3 && (
                            <div className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-slate-300 text-[9px] font-bold text-slate-600 dark:border-gray-800 dark:bg-gray-600 dark:text-gray-300">
                              +{card.memberIds.length - 3}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
