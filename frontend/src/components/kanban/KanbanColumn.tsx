// flowbuilder/src/components/kanban/KanbanColumn.tsx
// @ts-ignore
import React, { useState, memo, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, MoreHorizontal, Trash2, X, Check, Archive, Copy, CheckSquare, AlertTriangle, Minus, LayoutTemplate, ChevronDown, GripVertical, Palette, Bot, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { KanbanList, KanbanCard, KanbanBoardMember } from '@/services/kanban.service';
import { ExecType } from '@/services/kanbanAgent.service';
import { KanbanCardItem } from './KanbanCardItem';
import kanbanService from '@/services/kanban.service';
import { CARD_TEMPLATES } from './kanban-card-templates';
import { useConfirm } from '@/hooks/useConfirm';
import kanbanAgentService, { KanbanListAgentConfig, KanbanBoardRepo } from '@/services/kanbanAgent.service';
import { useQuery, useQueryClient } from '@tanstack/react-query';


interface Props {
  list: KanbanList;
  boardMembers?: KanbanBoardMember[];
  onCardAdded: (card: KanbanCard) => void;
  onCardUpdated?: (card: KanbanCard) => void;
  onCardClick: (card: KanbanCard) => void;
  onListDeleted: (listId: string) => void;
  onListUpdated: (list: KanbanList) => void;
  onListCopied?: (list: KanbanList & { cards: KanbanCard[] }) => void;
  visibleFields?: string[];
  cardEditors?: { cardId: string; userId: string; field: string }[];
  matchingCardIds?: Set<string> | null; // null = no filter, Set = ghost cards not in set
  readOnly?: boolean;
  focusedCardId?: string | null;
}

function AgentColumnConfigModal({
  listId,
  boardId,
  onClose,
}: {
  listId: string;
  boardId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const { data: repos = [] } = useQuery<KanbanBoardRepo[]>({
    queryKey: ['kanban-board-repos', boardId],
    queryFn: () => kanbanAgentService.listBoardRepos(boardId),
  });
  const { data: config } = useQuery<KanbanListAgentConfig | null>({
    queryKey: ['kanban-list-agent-config', listId],
    queryFn: () => kanbanAgentService.getListAgentConfig(listId),
  });

  const [form, setForm] = React.useState<{
    enabled: boolean;
    defaultExecType: ExecType;
    defaultRepoId: string;
    defaultBranch: string;
    promptPrefix: string;
    moveOnCompleteListId: string;
    moveOnFailListId: string;
  }>({
    enabled: false,
    defaultExecType: 'analysis',
    defaultRepoId: '',
    defaultBranch: '',
    promptPrefix: '',
    moveOnCompleteListId: '',
    moveOnFailListId: '',
  });

  React.useEffect(() => {
    if (config) {
      setForm({
        enabled: config.enabled,
        defaultExecType: config.defaultExecType || 'analysis',
        defaultRepoId: config.defaultRepoId || '',
        defaultBranch: config.defaultBranch || '',
        promptPrefix: config.promptPrefix || '',
        moveOnCompleteListId: config.moveOnCompleteListId || '',
        moveOnFailListId: config.moveOnFailListId || '',
      });
    }
  }, [config]);

  const [saving, setSaving] = React.useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await kanbanAgentService.upsertListAgentConfig(listId, boardId, {
        enabled: form.enabled,
        defaultExecType: form.defaultExecType,
        defaultRepoId: form.defaultRepoId || null,
        defaultBranch: form.defaultBranch || null,
        promptPrefix: form.promptPrefix || null,
        moveOnCompleteListId: form.moveOnCompleteListId || null,
        moveOnFailListId: form.moveOnFailListId || null,
      });
      await queryClient.invalidateQueries({ queryKey: ['kanban-list-agent-config', listId] });
      toast.success(t('kanbanColumn.toasts.configSaved'));
      onClose();
    } catch {
      toast.error(t('kanbanColumn.toasts.errorSaveConfig'));
    } finally {
      setSaving(false);
    }
  };

  const EXEC_TYPES = ['code', 'analysis', 'mockup', 'tests', 'review', 'custom'];

  return (
    <div className="mt-2 rounded-xl border border-[#dcdfe4] bg-white p-4 shadow-lg dark:border-[#2e3541] dark:bg-[#1e2433]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-white">
          <Bot className="h-4 w-4" />
          {t('kanbanColumn.labels.agentConfig')}
        </div>
        <button onClick={onClose} className="rounded p-0.5 text-[#8590a2] hover:bg-[#f1f2f4] dark:hover:bg-[#2e3541]">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-sm text-[#172b4d] dark:text-gray-200">{t('kanbanColumn.labels.autoExecution')}</span>
          <button
            onClick={() => setForm(f => ({ ...f, enabled: !f.enabled }))}
            className={`relative h-5 w-9 rounded-full transition-colors ${form.enabled ? 'bg-[#579dff]' : 'bg-[#d0d3d8] dark:bg-gray-600'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${form.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </label>

        {form.enabled && (
          <>
            <div>
              <label className="mb-1 block text-xs text-[#626f86] dark:text-gray-400">{t('kanbanColumn.labels.defaultType')}</label>
              <select
                value={form.defaultExecType}
                onChange={e => setForm(f => ({ ...f, defaultExecType: e.target.value as ExecType }))}
                className="w-full rounded-lg border border-[#dcdfe4] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#2e3541] dark:bg-[#161b27] dark:text-white"
              >
                {EXEC_TYPES.map(t => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-[#626f86] dark:text-gray-400">{t('kanbanColumn.labels.defaultRepo')}</label>
              <select
                value={form.defaultRepoId}
                onChange={e => setForm(f => ({ ...f, defaultRepoId: e.target.value }))}
                className="w-full rounded-lg border border-[#dcdfe4] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#2e3541] dark:bg-[#161b27] dark:text-white"
              >
                <option value="">{t('kanbanColumn.labels.noRepo')}</option>
                {repos.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-[#626f86] dark:text-gray-400">{t('kanbanColumn.labels.promptContext')}</label>
              <textarea
                value={form.promptPrefix}
                onChange={e => setForm(f => ({ ...f, promptPrefix: e.target.value }))}
                rows={3}
                placeholder={t('kanbanColumn.placeholders.promptPrefix')}
                className="w-full resize-none rounded-lg border border-[#dcdfe4] bg-white px-2.5 py-1.5 text-xs text-[#172b4d] outline-none dark:border-[#2e3541] dark:bg-[#161b27] dark:text-white"
              />
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-[#44546f] hover:bg-[#f1f2f4] dark:text-gray-400 dark:hover:bg-[#2e3541]">
            {t('kanbanColumn.labels.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-[#0c66e4] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#0055cc] disabled:opacity-60"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('kanbanColumn.labels.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Returns '#ffffff' or '#1e293b' depending on which gives better contrast against `hex`. */
function getContrastColor(hex: string): '#ffffff' | '#1e293b' {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  // Perceived luminance (WCAG formula)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#1e293b' : '#ffffff';
}

export const KanbanColumn = memo(function KanbanColumn({ list, boardMembers, onCardAdded, onCardUpdated, onCardClick, onListDeleted, onListUpdated, onListCopied, visibleFields, cardEditors, matchingCardIds, readOnly, focusedCardId }: Props) {
  const { t } = useTranslation('common');
  const {
    attributes: columnAttributes,
    listeners: columnListeners,
    setNodeRef: setColumnNodeRef,
    transform: columnTransform,
    transition: columnTransition,
    isDragging: columnIsDragging,
  } = useSortable({ id: list.id, data: { type: 'column', listId: list.id } });

  const columnStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(columnTransform),
    transition: columnTransition,
    opacity: columnIsDragging ? 0.6 : undefined,
    pointerEvents: columnIsDragging ? 'none' : undefined,
  };

  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({ id: `list-droppable-${list.id}`, data: { type: 'list', listId: list.id } });
  const { confirm } = useConfirm();
  const [addingCard, setAddingCard] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(list.title);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmValue, setDeleteConfirmValue] = useState('');
  const [copyingList, setCopyingList] = useState(false);
  const [editingWip, setEditingWip] = useState(false);
  const [wipValue, setWipValue] = useState(String(list.wipLimit ?? 0));
  const [showTemplates, setShowTemplates] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showAgentConfig, setShowAgentConfig] = useState(false);

  const HEADER_COLORS = [
    { label: t('kanbanColumn.labels.colors.default'), value: '' },
    { label: t('kanbanColumn.labels.colors.blue'), value: '#0c66e4' },
    { label: t('kanbanColumn.labels.colors.purple'), value: '#8b5cf6' },
    { label: t('kanbanColumn.labels.colors.green'), value: '#22c55e' },
    { label: t('kanbanColumn.labels.colors.yellow'), value: '#f59e0b' },
    { label: t('kanbanColumn.labels.colors.orange'), value: '#f97316' },
    { label: t('kanbanColumn.labels.colors.red'), value: '#ef4444' },
    { label: t('kanbanColumn.labels.colors.pink'), value: '#ec4899' },
    { label: t('kanbanColumn.labels.colors.cyan'), value: '#06b6d4' },
    { label: t('kanbanColumn.labels.colors.gray'), value: '#6b7280' },
    { label: t('kanbanColumn.labels.colors.dark'), value: '#1e293b' },
  ];

  const handleSetHeaderColor = async (color: string) => {
    try {
      const updated = await kanbanService.updateList(list.id, { color });
      onListUpdated(updated);
      setShowColorPicker(false);
      setShowMenu(false);
    } catch { toast.error(t('kanbanColumn.toasts.errorSetColor')); }
  };

  const applyTemplate = async (tpl: typeof CARD_TEMPLATES[0]) => {
    const cardTitle = newCardTitle.trim() || tpl.title;
    if (!cardTitle) { setShowTemplates(false); return; }
    try {
      const card = await kanbanService.createCard(list.id, { title: cardTitle });
      // Apply template data
      const withData = await kanbanService.updateCard(card.id, {
        labels: tpl.labels,
        checklists: tpl.checklist.length > 0 ? tpl.checklist : [],
      });
      onCardAdded({ ...card, ...withData });
      setNewCardTitle('');
      setAddingCard(false);
      setShowTemplates(false);
    } catch { toast.error(t('kanbanColumn.toasts.errorCreateCardTemplate')); }
  };

  const cardIds = useMemo(() => list.cards.map((c) => c.id), [list.cards]);
  const wipLimit = list.wipLimit ?? 0;
  const cardCount = list.cards.length;
  const wipExceeded = wipLimit > 0 && cardCount > wipLimit;
  const wipAtLimit = wipLimit > 0 && cardCount === wipLimit;

  // Memoize editors grouped by cardId so KanbanCardItem.memo is not broken
  // by an inline .filter() that creates a new array reference every render.
  const editorsByCardId = useMemo(() => {
    if (!cardEditors || cardEditors.length === 0) return {} as Record<string, typeof cardEditors>;
    const map: Record<string, typeof cardEditors> = {};
    for (const e of cardEditors) {
      if (!map[e.cardId]) map[e.cardId] = [];
      map[e.cardId].push(e);
    }
    return map;
  }, [cardEditors]);

  const handleAddCard = async () => {
    if (!newCardTitle.trim()) { setAddingCard(false); return; }
    try {
      const card = await kanbanService.createCard(list.id, { title: newCardTitle.trim() });
      onCardAdded(card);
      setNewCardTitle('');
      setAddingCard(false);
    } catch { toast.error(t('kanbanColumn.toasts.errorCreateCard')); }
  };

  const handleRenameList = async () => {
    if (!titleValue.trim() || titleValue === list.title) { setEditingTitle(false); return; }
    try {
      const updated = await kanbanService.updateList(list.id, { title: titleValue.trim() });
      onListUpdated(updated);
      setEditingTitle(false);
    } catch { toast.error(t('kanbanColumn.toasts.errorRenameList')); }
  };

  const handleDeleteList = () => {
    setShowMenu(false);
    setDeleteConfirmValue('');
    setShowDeleteConfirm(true);
  };

  const handleDeleteListConfirmed = async () => {
    setShowDeleteConfirm(false);
    try {
      await kanbanService.deleteList(list.id);
      onListDeleted(list.id);
      toast.success(t('kanbanColumn.toasts.listRemoved'));
    } catch { toast.error(t('kanbanColumn.toasts.errorRemoveList')); }
  };

  const handleArchiveList = async () => {
    setShowMenu(false);
    const ok = await confirm({ title: t('kanbanColumn.actions.archiveListTitle'), message: t('kanbanColumn.actions.archiveListMessage', { title: list.title }) });
    if (!ok) return;
    try {
      await kanbanService.updateList(list.id, { isArchived: true });
      onListDeleted(list.id);
      toast.success(t('kanbanColumn.toasts.listArchived'));
    } catch { toast.error(t('kanbanColumn.toasts.errorArchiveList')); }
  };

  const handleCopyList = async () => {
    setShowMenu(false);
    setCopyingList(true);
    try {
      const newList = await kanbanService.copyList(list.id);
      onListCopied?.(newList);
      toast.success(t('kanbanColumn.toasts.listCopied'));
    } catch {
      toast.error(t('kanbanColumn.toasts.errorCopyList'));
    } finally {
      setCopyingList(false);
    }
  };

  const handleClearCompleted = async () => {
    setShowMenu(false);
    const doneCount = list.cards.reduce((sum, c) => {
      const allItems = c.checklists?.flatMap(g => g.items) ?? c.checklist ?? [];
      return sum + allItems.filter(i => i.done).length;
    }, 0);
    if (doneCount === 0) { toast(t('kanbanColumn.toasts.noCompletedItems')); return; }
    const ok = await confirm({ title: t('kanbanColumn.actions.clearCompletedTitle'), message: t('kanbanColumn.actions.clearCompletedMessage', { count: doneCount }) });
    if (!ok) return;
    try {
      await kanbanService.clearCompleted(list.id);
      toast.success(t('kanbanColumn.toasts.completedItemsRemoved'));
    } catch { toast.error(t('kanbanColumn.toasts.errorClearCompleted')); }
  };

  const handleSetWip = async () => {
    const v = parseInt(wipValue) || 0;
    try {
      const updated = await kanbanService.updateList(list.id, { wipLimit: v });
      onListUpdated(updated);
      setEditingWip(false);
      setShowMenu(false);
      toast.success(v === 0 ? t('kanbanColumn.toasts.wipLimitRemoved') : t('kanbanColumn.toasts.wipLimitSet', { limit: v }));
    } catch { toast.error(t('kanbanColumn.toasts.errorSetWipLimit')); }
  };

  const contrastColor = list.color ? getContrastColor(list.color) : null;
  const contrastIsLight = contrastColor === '#1e293b';

  return (
    <div
      ref={setColumnNodeRef}
      style={columnStyle}
      className="flex max-h-[calc(100vh-172px)] w-[282px] flex-shrink-0 flex-col"
    >
      <div className="flex max-h-full flex-col overflow-hidden rounded-[22px] border border-slate-200/90 bg-[#f8fafc] shadow-[0_12px_28px_-24px_rgba(15,23,42,0.22)] dark:border-gray-700 dark:bg-gray-800">
        <div
          className="flex items-center justify-between px-3.5 pb-2 pt-3 rounded-t-[22px] transition-colors"
          style={list.color ? { background: list.color } : undefined}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              type="button"
              {...columnListeners}
              {...columnAttributes}
              className={`rounded-full p-1 transition-colors ${list.color ? (contrastIsLight ? 'hover:bg-black/10' : 'hover:bg-white/20') : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:text-slate-500 dark:hover:text-slate-100 dark:hover:bg-gray-700'}`}
              style={contrastColor ? { color: contrastColor, opacity: 0.7 } : undefined}
              aria-label={t('kanbanColumn.labels.moveList')}
            >
              <GripVertical className="h-4 w-4" />
            </button>
            {editingTitle ? (
              <input
                autoFocus
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                onBlur={handleRenameList}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameList();
                  if (e.key === 'Escape') { setTitleValue(list.title); setEditingTitle(false); }
                }}
                className="flex-1 rounded-lg border border-[#0c66e4] bg-white px-2.5 py-1 text-sm font-semibold text-[#172b4d] outline-none dark:bg-gray-700 dark:text-gray-100 dark:border-blue-500"
              />
            ) : (
              <h3
                onClick={() => setEditingTitle(true)}
                className="cursor-pointer truncate text-[13px] font-semibold tracking-[-0.01em] transition-colors"
                style={contrastColor ? { color: contrastColor } : undefined}
                title={list.title}
              >
                {list.title}
              </h3>
            )}

            {/* Card count + WIP badge */}
            <span className={`ml-auto mr-1 flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${
              wipExceeded ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' :
              wipAtLimit ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300' :
              'bg-slate-100 text-[#626f86] dark:bg-gray-700 dark:text-gray-400'
            }`}>
              {cardCount}{wipLimit > 0 ? `/${wipLimit}` : ''}
            </span>
            <button
              ref={menuBtnRef}
              onClick={() => {
                if (!showMenu && menuBtnRef.current) {
                  const r = menuBtnRef.current.getBoundingClientRect();
                  setMenuPos({ top: r.bottom + 4, left: r.right - 224 });
                }
                setShowMenu(v => !v);
              }}
              disabled={copyingList}
              className={`rounded-lg p-1 transition-colors disabled:opacity-50 ${list.color ? (contrastIsLight ? 'hover:bg-black/10' : 'hover:bg-white/20') : 'text-[#44546f] hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-700'}`}
              style={contrastColor ? { color: contrastColor, opacity: 0.8 } : undefined}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {showMenu && createPortal(
              <>
                <div className="fixed inset-0 z-[9998]" onClick={() => setShowMenu(false)} />
                <div className="fixed z-[9999] w-56 rounded-xl border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-600 dark:bg-gray-800" style={{ top: menuPos.top, left: Math.max(4, menuPos.left) }}>
                  <button
                    onClick={handleCopyList}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[#44546f] hover:bg-slate-50 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    <Copy className="w-3.5 h-3.5" /> {t('kanbanColumn.actions.copyList')}
                  </button>
                  <button
                    onClick={() => { setShowMenu(false); setShowAgentConfig(true); }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[#44546f] hover:bg-[#f1f2f4] dark:text-gray-300 dark:hover:bg-[#2e3541]"
                  >
                    <Bot className="h-4 w-4 text-[#626f86]" />
                    {t('kanbanColumn.actions.configureAgent')}
                  </button>
                  <button
                    onClick={handleClearCompleted}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[#44546f] hover:bg-slate-50 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    <CheckSquare className="w-3.5 h-3.5" /> {t('kanbanColumn.actions.clearCompleted')}
                  </button>

                  {/* WIP limit */}
                  <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                  {editingWip ? (
                    <div className="px-3 py-2">
                      <p className="mb-1.5 text-xs font-semibold text-[#44546f] dark:text-gray-400">{t('kanbanColumn.labels.wipLimitLabel')}</p>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setWipValue(v => String(Math.max(0, parseInt(v)||0) - 1 || 0))} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-gray-700">
                          <Minus className="w-3 h-3 text-[#44546f]" />
                        </button>
                        <input
                          autoFocus
                          type="number"
                          min="0"
                          value={wipValue}
                          onChange={e => setWipValue(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && void handleSetWip()}
                          className="w-14 rounded border border-[#0c66e4] bg-white px-2 py-1 text-center text-sm text-[#172b4d] outline-none dark:bg-gray-700 dark:text-gray-100 dark:border-blue-500"
                        />
                        <button onClick={() => setWipValue(v => String((parseInt(v)||0) + 1))} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-gray-700">
                          <Plus className="w-3 h-3 text-[#44546f]" />
                        </button>
                        <button onClick={() => void handleSetWip()} className="rounded bg-[#0c66e4] p-1 text-white hover:bg-[#0055cc]">
                          <Check className="w-3 h-3" />
                        </button>
                        <button onClick={() => setEditingWip(false)} className="rounded p-1 text-[#44546f] hover:bg-slate-100 dark:hover:bg-gray-700">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setEditingWip(true)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[#44546f] hover:bg-slate-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {wipLimit > 0 ? t('kanbanColumn.actions.wipLimitCurrent', { limit: wipLimit }) : t('kanbanColumn.actions.setWipLimit')}
                    </button>
                  )}

                  <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                  {/* Header color picker */}
                  {showColorPicker ? (
                    <div className="px-3 py-2">
                      <p className="mb-2 text-xs font-semibold text-[#44546f] dark:text-gray-400">{t('kanbanColumn.labels.headerColor')}</p>
                      <div className="grid grid-cols-5 gap-1.5">
                        {HEADER_COLORS.map(c => (
                          <button
                            key={c.value}
                            title={c.label}
                            onClick={() => void handleSetHeaderColor(c.value)}
                            className={`h-6 w-full rounded-md border-2 transition-transform hover:scale-110 ${
                              list.color === c.value ? 'border-[#0c66e4] dark:border-blue-400' : 'border-transparent'
                            } ${!c.value ? 'bg-slate-200 dark:bg-gray-600' : ''}`}
                            style={c.value ? { background: c.value } : undefined}
                          />
                        ))}
                      </div>
                      <button
                        onClick={() => setShowColorPicker(false)}
                        className="mt-2 text-xs text-[#626f86] hover:text-[#44546f] dark:text-gray-500 dark:hover:text-gray-300"
                      >
                        {t('kanbanColumn.labels.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowColorPicker(true)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[#44546f] hover:bg-slate-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      <Palette className="w-3.5 h-3.5" />
                      {list.color ? t('kanbanColumn.labels.changeHeaderColor') : t('kanbanColumn.labels.headerColor')}
                    </button>
                  )}

                  <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                  <button
                    onClick={handleArchiveList}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"
                  >
                    <Archive className="w-3.5 h-3.5" /> {t('kanbanColumn.actions.archiveList')}
                  </button>
                  <button
                    onClick={handleDeleteList}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> {t('kanbanColumn.actions.removeList')}
                  </button>
                </div>
              </>,
              document.body
            )}
          </div>
        </div>

        {/* WIP exceeded warning */}
        {wipExceeded && (
          <div className="mx-2.5 mb-1 flex items-center gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-medium text-red-600 dark:bg-red-900/20 dark:text-red-400">
            <AlertTriangle className="w-3 h-3 flex-shrink-0" />
            {t('kanbanColumn.labels.wipExceeded', { cardCount, wipLimit })}
          </div>
        )}

        {/* Cards area — scrollable */}
        <div
          ref={setDroppableNodeRef}
          className={`flex min-h-[8px] flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-2 pt-2 transition-colors duration-150 [scrollbar-color:#c8d0db_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#c8d0db] [&::-webkit-scrollbar-track]:bg-transparent dark:[scrollbar-color:#3d4b60_transparent] dark:[&::-webkit-scrollbar-thumb]:bg-[#3d4b60] ${
            isOver ? 'bg-[#e5f0ff] dark:bg-[#1c2b41]' : ''
          }`}
        >
          <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
            {list.cards.map((card) => (
              <KanbanCardItem key={card.id} card={card} onClick={onCardClick} boardMembers={boardMembers} onUpdated={onCardUpdated} visibleFields={visibleFields} editors={editorsByCardId[card.id]} isGhosted={matchingCardIds != null && !matchingCardIds.has(card.id)} isFocused={focusedCardId === card.id} />
            ))}
          </SortableContext>
          {list.cards.length === 0 && (
            <div className={`rounded-xl border-2 border-dashed px-3 py-8 text-center transition-colors ${isOver ? 'border-[#579dff] bg-[#e9f2ff] dark:bg-[#1c2b41] dark:border-blue-500' : 'border-slate-200/60 dark:border-gray-700'}`}>
              {isOver ? (
                <p className="text-sm font-medium text-[#0c66e4] dark:text-blue-400">{t('kanbanColumn.labels.dropHere')}</p>
              ) : (
                <p className="text-xs text-[#aab0be] dark:text-gray-600">{t('kanbanColumn.labels.emptyList')}</p>
              )}
            </div>
          )}
        </div>

        {/* Add card */}
        {!readOnly && <div className="px-2.5 pb-2.5 pt-1.5">
          {addingCard ? (
            <div className="rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm dark:border-gray-600 dark:bg-gray-700">
              <textarea
                autoFocus
                rows={2}
                value={newCardTitle}
                onChange={(e) => setNewCardTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleAddCard(); }
                  if (e.key === 'Escape') { setAddingCard(false); setNewCardTitle(''); }
                }}
                placeholder={t('kanbanColumn.placeholders.cardTitle')}
                className="w-full resize-none bg-transparent text-sm text-[#172b4d] outline-none placeholder-[#626f86] dark:text-gray-100 dark:placeholder-gray-400"
              />
              <div className="mt-2 flex items-center gap-1">
                <button
                  onClick={() => void handleAddCard()}
                  className="flex items-center gap-1 rounded-lg bg-[#0c66e4] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0055cc]"
                >
                  <Check className="w-3 h-3" /> {t('kanbanColumn.actions.addCardButton')}
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowTemplates(p => !p)}
                    className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1.5 text-xs font-medium text-[#44546f] transition-colors hover:bg-slate-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500"
                    title="Templates"
                  >
                    <LayoutTemplate className="w-3 h-3" />
                    <ChevronDown className="w-2.5 h-2.5" />
                  </button>
                  {showTemplates && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowTemplates(false)} />
                      <div className="absolute bottom-8 left-0 z-20 w-44 rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
                        <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-400">{t('kanbanColumn.labels.templates')}</p>
                        {CARD_TEMPLATES.map(tpl => (
                          <button
                            key={tpl.label}
                            onClick={() => void applyTemplate(tpl)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[#172b4d] hover:bg-slate-50 dark:text-gray-200 dark:hover:bg-gray-700"
                          >
                            <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: tpl.labels[0]?.color }} />
                            {tpl.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <button
                  onClick={() => { setAddingCard(false); setNewCardTitle(''); setShowTemplates(false); }}
                  className="rounded-lg p-1.5 text-[#44546f] transition-colors hover:bg-slate-200 dark:text-gray-400 dark:hover:bg-gray-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAddingCard(true)}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-[#626f86] hover:bg-white hover:text-[#172b4d] hover:shadow-[0_2px_8px_-4px_rgba(15,23,42,0.18)] transition-all dark:text-gray-500 dark:hover:bg-gray-700/80 dark:hover:text-gray-200 group"
            >
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-[#626f86] group-hover:bg-[#e9efff] group-hover:text-[#0c66e4] transition-colors dark:bg-gray-700 dark:text-gray-500 dark:group-hover:bg-[#1c2b41] dark:group-hover:text-[#85b8ff]">
                <Plus className="h-3 w-3" />
              </span>
              <span>{t('kanbanColumn.actions.addCard')}</span>
            </button>
          )}
        </div>}
      </div>
        {showAgentConfig && (
          <AgentColumnConfigModal
            listId={list.id}
            boardId={list.boardId}
            onClose={() => setShowAgentConfig(false)}
          />
        )}
        {showDeleteConfirm && createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-gray-800">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                  <Trash2 className="h-5 w-5 text-red-600 dark:text-red-400" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-[#172b4d] dark:text-white">{t('kanbanColumn.labels.deleteModalTitle')}</h3>
                  <p className="text-xs text-[#626f86] dark:text-gray-400">{t('kanbanColumn.labels.deleteModalSubtitle')}</p>
                </div>
              </div>
              <p className="mb-4 text-sm text-[#44546f] dark:text-gray-300">
                {t('kanbanColumn.labels.deleteModalBody', { title: list.title })}
              </p>
              <p className="mb-2 text-xs font-medium text-[#44546f] dark:text-gray-400">
                {t('kanbanColumn.labels.deleteModalConfirmLabel')}
              </p>
              <p className="mb-2 select-none rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm font-semibold text-[#172b4d] dark:bg-gray-700 dark:text-white">
                {list.title}
              </p>
              <input
                autoFocus
                value={deleteConfirmValue}
                onChange={e => setDeleteConfirmValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && deleteConfirmValue === list.title) void handleDeleteListConfirmed();
                  if (e.key === 'Escape') setShowDeleteConfirm(false);
                }}
                placeholder={t('kanbanColumn.placeholders.deleteConfirm', { title: list.title })}
                className="mb-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-red-400 focus:ring-1 focus:ring-red-400 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-red-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void handleDeleteListConfirmed()}
                  disabled={deleteConfirmValue !== list.title}
                  className="flex-1 rounded-xl bg-red-600 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('kanbanColumn.actions.confirmRemoveList')}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-[#44546f] transition-colors hover:bg-slate-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
                >
                  {t('kanbanColumn.labels.cancel')}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
});
