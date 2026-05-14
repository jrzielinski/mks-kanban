// flowbuilder/src/components/kanban/KanbanCardItem.tsx
import React, { useState, useRef, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
// @ts-ignore
import { Calendar, AlignLeft, CheckSquare, Paperclip, MessageSquare, Pencil, X, Check, LayoutTemplate, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import kanbanService, { KanbanCard, KanbanBoardMember } from '@/services/kanban.service';
import { CARD_TEMPLATES } from './kanban-card-templates';
import { useTranslation } from 'react-i18next';
import { CardContextMenu } from './CardContextMenu';

const QUICK_LABEL_COLORS = [
  '#4bce97','#f5cd47','#fea362','#f87168','#9f8fef',
  '#579dff','#6cc3e0','#94c748','#e774bb','#8590a2',
];

function getCardAgingStyle(updatedAt: string): React.CSSProperties {
  const days = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000);
  if (days > 21) return { opacity: 0.55, filter: 'grayscale(50%)' };
  if (days > 14) return { opacity: 0.7, filter: 'grayscale(25%)' };
  if (days > 7) return { opacity: 0.85 };
  return {};
}

interface Props {
  card: KanbanCard;
  onClick: (card: KanbanCard) => void;
  boardMembers?: KanbanBoardMember[];
  onUpdated?: (card: KanbanCard) => void;
  visibleFields?: string[];
  editors?: { userId: string; field: string }[];
  isGhosted?: boolean; // true = card doesn't match filter, show with reduced opacity
  isFocused?: boolean; // true = card is focused via J/K keyboard navigation
}

function relativeDueLabel(due: Date, allDone: boolean): { label: string; cls: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diff = Math.round((dueDay.getTime() - today.getTime()) / 86400000);

  if (allDone) return {
    label: due.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
    cls: 'bg-[#1f845a] text-white',
  };
  if (diff < 0) return {
    label: `Atrasado · ${due.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`,
    cls: 'bg-[#ffeceb] text-[#ae2a19] dark:bg-red-900/40 dark:text-red-300',
  };
  if (diff === 0) return {
    label: 'Hoje',
    cls: 'bg-[#fff7d6] text-[#7f5f01] dark:bg-yellow-900/40 dark:text-yellow-300',
  };
  if (diff === 1) return {
    label: 'Amanha',
    cls: 'bg-[#e3f9e5] text-[#1a6835] dark:bg-green-900/40 dark:text-green-300',
  };
  if (diff <= 7) return {
    label: `Em ${diff} dias`,
    cls: 'bg-[#e9eef5] text-[#626f86] dark:bg-gray-700 dark:text-gray-400',
  };
  return {
    label: due.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
    cls: 'bg-[#e9eef5] text-[#626f86] dark:bg-gray-700 dark:text-gray-400',
  };
}

export const KanbanCardItem = memo(function KanbanCardItem({
  card,
  onClick,
  boardMembers,
  onUpdated,
  visibleFields,
  editors,
  isGhosted,
  isFocused,
}: Props) {
  const { t } = useTranslation('flow-builder');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card', card },
  });

  const [showQuickEdit, setShowQuickEdit] = useState(false);
  const [quickTitle, setQuickTitle] = useState(card.title);
  const [quickDue, setQuickDue] = useState(card.dueDate?.slice(0, 10) ?? '');
  const [quickLabels, setQuickLabels] = useState(card.labels);
  const [quickMaxHours, setQuickMaxHours] = useState<string>(card.maxHours != null ? String(card.maxHours) : '');
  const [quickEditPos, setQuickEditPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [showQuickTemplates, setShowQuickTemplates] = useState(false);
  const [saving, setSaving] = useState(false);
  // Anchor for the right-click context menu. null = no menu open.
  // We position the menu via clientX/Y (page coords) so it stays at the
  // cursor even if the board container scrolls. CardContextMenu portals to
  // document.body and accepts the absolute position directly.
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const quickRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const cardWrapperRef = useRef<HTMLDivElement>(null);

  // Scroll into view when focused via J/K
  useEffect(() => {
    if (isFocused && cardWrapperRef.current) {
      cardWrapperRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isFocused]);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Close quick edit on outside click — handled by portal backdrop now, but keep as fallback
  useEffect(() => {
    if (!showQuickEdit) return;
    const fn = (e: MouseEvent) => {
      if (quickRef.current && !quickRef.current.contains(e.target as Node)) {
        setShowQuickEdit(false);
        setShowQuickTemplates(false);
        setQuickEditPos(null);
      }
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [showQuickEdit]);

  const openQuickEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = groupRef.current?.getBoundingClientRect();
    if (rect) {
      setQuickEditPos({
        top: rect.top,
        left: rect.left,
        width: rect.width,
      });
    }
    setQuickTitle(card.title);
    setQuickLabels(card.labels ?? []);
    setQuickDue(card.dueDate?.slice(0, 10) ?? '');
    setQuickMaxHours(card.maxHours != null ? String(card.maxHours) : '');
    setShowQuickEdit(true);
  };

  const saveQuickEdit = async () => {
    if (!quickTitle.trim()) return;
    setSaving(true);
    try {
      const updated = await kanbanService.updateCard(card.id, {
        title: quickTitle.trim(),
        labels: quickLabels,
        dueDate: quickDue || null,
        ...(quickMaxHours !== '' ? { maxHours: parseFloat(quickMaxHours) } : { maxHours: null }),
      });
      onUpdated?.(updated);
      setShowQuickEdit(false);
      setShowQuickTemplates(false);
      setQuickEditPos(null);
    } catch { toast.error('Erro ao salvar'); }
    finally { setSaving(false); }
  };

  const toggleQuickLabel = (color: string) => {
    setQuickLabels(prev => {
      const idx = prev.findIndex(l => l.color === color);
      return idx >= 0 ? prev.filter((_, i) => i !== idx) : [...prev, { text: '', color }];
    });
  };

  // When dragging, render a visible placeholder
  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        style={{ ...style, minHeight: 72 }}
        className="rounded-2xl border-2 border-dashed border-[#579dff]/60 bg-[#eef4ff]/50 dark:border-blue-600/40 dark:bg-blue-900/10 animate-pulse"
      />
    );
  }

  const due = card.dueDate ? new Date(card.dueDate) : null;
  const daysSinceUpdate = card.updatedAt ? Math.floor((Date.now() - new Date(card.updatedAt).getTime()) / 86400000) : 0;
  const agingStyle = card.updatedAt ? getCardAgingStyle(card.updatedAt) : {};
  const isVisible = (field: string) => !visibleFields || visibleFields.length === 0 || visibleFields.includes(field);

  const allChecklistItems = card.checklists?.length > 0
    ? card.checklists.flatMap(g => g.items)
    : (card.checklist ?? []);
  const doneCount = allChecklistItems.filter((c) => c.done).length;
  const allDone = allChecklistItems.length > 0 && doneCount === allChecklistItems.length;

  // Card explicitamente concluído via botão (customFields.__completedAt)
  // suprime o status de atrasado / vence-hoje em todos os locais.
  const isDone = Boolean(card.customFields?.['__completedAt']);
  const isOverdue = !isDone && !allDone && card.dueDate && new Date(card.dueDate) < new Date() && new Date(card.dueDate).toDateString() !== new Date().toDateString();
  const isDueToday = !isDone && card.dueDate && new Date(card.dueDate).toDateString() === new Date().toDateString();

  const getMember = (memberId: string) => boardMembers?.find(m => m.id === memberId);
  const dueBadge = due ? relativeDueLabel(due, allDone) : null;

  return (
    <div ref={(el) => { (groupRef as React.MutableRefObject<HTMLDivElement | null>).current = el; (cardWrapperRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }} className={`group relative transition-all duration-200 ${isGhosted ? 'opacity-30 pointer-events-auto' : ''} ${isFocused ? 'ring-2 ring-[#579dff] rounded-xl' : ''}`}>
      {/* Quick edit button */}
      <button
        onMouseDown={e => e.stopPropagation()}
        onClick={openQuickEdit}
        className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-slate-200/80 bg-white/95 text-[#44546f] opacity-0 shadow-sm transition-all group-hover:opacity-100 hover:border-[#bfd4ff] hover:bg-[#e9efff] hover:text-[#0c66e4] dark:border-gray-600 dark:bg-gray-700/90 dark:text-gray-400 dark:hover:bg-[#1c2b41] dark:hover:text-[#85b8ff]"
        title={t('nodes.kanbanCardItem.tsx.edicaoRapida_title')}
      >
        <Pencil className="h-3 w-3" />
      </button>

      {editors && editors.length > 0 && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 shadow-sm dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
          title={t('nodes.kanbanCardItem.tsx.alguemEstaEditandoEsteCard_title')}>
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
          </span>
          editando
        </div>
      )}

      <div
        ref={setNodeRef}
        style={{ ...style, ...agingStyle }}
        className={`cursor-pointer select-none overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_4px_rgba(15,23,42,0.06),0_4px_12px_-8px_rgba(15,23,42,0.14)] transition-all duration-150 hover:-translate-y-[1px] hover:border-slate-300/90 hover:shadow-[0_4px_16px_-6px_rgba(15,23,42,0.22),0_1px_4px_rgba(15,23,42,0.08)] dark:border-gray-700/80 dark:bg-gray-800 dark:hover:border-gray-600 dark:hover:bg-gray-750 ${isOverdue ? 'border-l-[3px] border-l-red-400' : isDueToday ? 'border-l-[3px] border-l-yellow-400' : ''}`}
        onClick={() => onClick(card)}
        onContextMenu={(e) => {
          // Right-click → inline quick-actions menu. preventDefault stops the
          // browser/VSCode native menu from competing. We deliberately
          // anchor via clientX/Y instead of the card's bounding box so the
          // menu sticks to the cursor (matches native menu UX).
          e.preventDefault();
          e.stopPropagation();
          setContextMenuPos({ x: e.clientX, y: e.clientY });
        }}
        {...attributes}
        {...listeners}
      >
        {/* Cover */}
        {card.coverImageUrl ? (
          <div className="h-20 w-full overflow-hidden rounded-t-2xl bg-[#e2e8f0] dark:bg-gray-600">
            <img src={card.coverImageUrl} alt={card.title} className="h-full w-full object-cover" />
          </div>
        ) : card.coverColor !== '#ffffff' ? (
          <div className="h-6 rounded-t-2xl w-full" style={{ background: card.coverColor }} />
        ) : null}

        <div className="p-3">
          {card.labels.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {card.labels.slice(0, 3).map((lbl, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  style={{ background: lbl.color }}
                  title={lbl.text || lbl.color}
                >
                  {lbl.text && lbl.text.length <= 12 ? lbl.text : null}
                  {(!lbl.text || lbl.text.length > 12) && <span className="block h-1.5 w-4" />}
                </div>
              ))}
              {card.labels.length > 3 && (
                <div className="flex items-center rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-gray-600 dark:text-gray-300">
                  +{card.labels.length - 3}
                </div>
              )}
            </div>
          )}

          <p className="text-[13px] font-semibold leading-[1.4] text-[#172b4d] dark:text-gray-100 tracking-[-0.01em]">
            {card.title}
          </p>

          {card.description && (
            <p className="mt-1 line-clamp-2 text-[11px] leading-[1.4] text-[#8590a2] dark:text-gray-400">
              {card.description.replace(/[#>*_`]/g, '').trim()}
            </p>
          )}

          {isVisible('stickers') && card.stickers?.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-0.5">
              {card.stickers.map((s, i) => (
                <span key={i} className="text-base leading-none" title={s}>{s}</span>
              ))}
            </div>
          )}

          {card.blockedBy?.length > 0 && (
            <div className="mt-1.5">
              <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-900/20 dark:text-red-400" title={`Bloqueado por ${card.blockedBy.length} card${card.blockedBy.length > 1 ? 's' : ''}`}>
                <Lock className="h-2.5 w-2.5" />
                Bloqueado{card.blockedBy.length > 1 ? ` (${card.blockedBy.length})` : ''}
              </span>
            </div>
          )}

          {daysSinceUpdate > 14 && (
            <div className="mt-1.5">
              <span className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                Sem atividade há {daysSinceUpdate}d
              </span>
            </div>
          )}

          {(due || card.description || allChecklistItems.length > 0 || card.attachments.length > 0 || card.memberIds.length > 0 || (card.commentCount ?? 0) > 0 || (card.votes?.length ?? 0) > 0) && (
            <div className="mt-2.5 flex items-center gap-1.5 flex-wrap border-t border-slate-100/80 pt-2 dark:border-gray-700/50">
              {/* Esquerda: due date + checklist */}
              {isVisible('datas') && due && dueBadge && (
                <span className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${dueBadge.cls}`}>
                  <Calendar className="w-2.5 h-2.5" />
                  {dueBadge.label}
                </span>
              )}
              {isVisible('checklist') && allChecklistItems.length > 0 && (() => {
                const total = allChecklistItems.length;
                const done = doneCount;
                const pct = Math.round((done / total) * 100);
                return (
                  <div className="flex items-center gap-1.5">
                    <div className="h-1 w-12 overflow-hidden rounded-full bg-slate-200 dark:bg-gray-600">
                      <div className="h-full rounded-full bg-[#1f845a] transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className={`text-[10px] font-medium ${done === total ? 'text-[#1f845a]' : 'text-[#626f86] dark:text-gray-400'}`}>
                      {done}/{total}
                    </span>
                  </div>
                );
              })()}

              {/* Meio: comentários + anexos + votos com separadores entre eles */}
              {(() => {
                const showComments = isVisible('comentarios') && (card.commentCount ?? 0) > 0;
                const showAttachments = isVisible('anexos') && card.attachments.length > 0;
                const showVotes = isVisible('votos') && (card.votes?.length ?? 0) > 0;
                const middleItems = [showComments, showAttachments, showVotes].filter(Boolean);
                if (middleItems.length === 0) return null;
                return (
                  <div className="flex items-center gap-1">
                    {showComments && (
                      <span className="inline-flex items-center gap-1 text-[#626f86] dark:text-gray-500">
                        <MessageSquare className="h-3.5 w-3.5" />
                        <span className="text-[11px] font-medium">{card.commentCount}</span>
                      </span>
                    )}
                    {showComments && (showAttachments || showVotes) && (
                      <span className="w-px h-3 bg-slate-200 dark:bg-gray-600 mx-0.5" />
                    )}
                    {showAttachments && (
                      <span className="inline-flex items-center gap-1 text-[#626f86] dark:text-gray-500">
                        <Paperclip className="h-3.5 w-3.5" />
                        <span className="text-[11px] font-medium">{card.attachments.length}</span>
                      </span>
                    )}
                    {showAttachments && showVotes && (
                      <span className="w-px h-3 bg-slate-200 dark:bg-gray-600 mx-0.5" />
                    )}
                    {showVotes && (
                      <span className="inline-flex items-center gap-1 text-[#626f86] dark:text-gray-500 text-[11px]">
                        👍 {card.votes!.length}
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Direita: membros */}
              {isVisible('membros') && card.memberIds.length > 0 && (
                <div className="ml-auto flex items-center -space-x-1.5">
                  {card.memberIds.slice(0, 3).map((memberId, index) => {
                    const member = getMember(memberId);
                    return (
                      <span
                        key={`${memberId}-${index}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full border border-white text-[9px] font-bold text-white shadow-sm ring-1 ring-slate-200 dark:border-gray-800 dark:ring-gray-700"
                        style={{ background: member?.avatarColor ?? '#579dff' }}
                        title={member?.name ?? memberId}
                      >
                        {member ? member.name.slice(0, 1).toUpperCase() : '?'}
                      </span>
                    );
                  })}
                  {card.memberIds.length > 3 && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-white bg-slate-100 text-[9px] font-bold text-slate-600 shadow-sm ring-1 ring-slate-200 dark:border-gray-800 dark:bg-gray-700 dark:text-gray-300 dark:ring-gray-700">
                      +{card.memberIds.length - 3}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Quick edit popup — rendered via portal to fix z-order issues with column headers */}
      {showQuickEdit && quickEditPos && createPortal(
        <>
          {/* Backdrop to close on outside click */}
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => { setShowQuickEdit(false); setShowQuickTemplates(false); setQuickEditPos(null); }}
          />
          <div
            ref={quickRef}
            style={{
              position: 'fixed',
              top: quickEditPos.top,
              left: quickEditPos.left,
              width: Math.max(quickEditPos.width, 272),
              zIndex: 9999,
            }}
            className="rounded-xl border border-[#0c66e4] bg-white shadow-2xl dark:border-blue-600 dark:bg-gray-800 p-3"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-[#44546f] dark:text-gray-400">{t('nodes.kanbanCardItem.tsx.edicaoRapida')}</span>
              <button
                onClick={() => { setShowQuickEdit(false); setShowQuickTemplates(false); setQuickEditPos(null); }}
                className="text-[#626f86] hover:text-[#172b4d] dark:text-gray-500"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Templates */}
            <div className="relative mb-2">
              <button
                onClick={() => setShowQuickTemplates(p => !p)}
                className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-[#44546f] hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              >
                <LayoutTemplate className="h-3 w-3" />
                Templates
              </button>
              {showQuickTemplates && (
                <div className="absolute left-0 top-8 z-10 w-44 rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
                  <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-400">Templates</p>
                  {CARD_TEMPLATES.map(tpl => (
                    <button
                      key={tpl.label}
                      onClick={() => {
                        if (tpl.title && !quickTitle.startsWith(tpl.title)) {
                          setQuickTitle(tpl.title + (quickTitle || ''));
                        }
                        setQuickLabels(tpl.labels);
                        setShowQuickTemplates(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[#172b4d] hover:bg-slate-50 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: tpl.color }} />
                      {tpl.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <textarea
              autoFocus
              value={quickTitle}
              onChange={e => setQuickTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveQuickEdit(); }
                if (e.key === 'Escape') { setShowQuickEdit(false); setQuickEditPos(null); }
              }}
              rows={2}
              className="mb-2 w-full resize-none rounded-lg border border-[#579dff] bg-[#f8fafc] px-2.5 py-2 text-sm font-medium text-[#172b4d] outline-none dark:bg-gray-700 dark:text-gray-100"
            />

            <p className="mb-1.5 text-[11px] font-semibold text-[#44546f] dark:text-gray-500">Etiquetas</p>
            <div className="mb-2 flex flex-wrap gap-1">
              {QUICK_LABEL_COLORS.map(c => {
                const on = quickLabels.some(l => l.color === c);
                return (
                  <button
                    key={c}
                    onClick={() => toggleQuickLabel(c)}
                    className="relative h-5 rounded-sm transition-all hover:scale-105"
                    style={{ background: c, width: '28px', outline: on ? '2px solid #172b4d' : 'none', outlineOffset: '1px' }}
                  >
                    {on && <Check className="absolute inset-0 m-auto h-3 w-3 text-white" />}
                  </button>
                );
              })}
            </div>

            <p className="mb-1 text-[11px] font-semibold text-[#44546f] dark:text-gray-500">Vencimento</p>
            <input
              type="date"
              value={quickDue}
              onChange={e => setQuickDue(e.target.value)}
              className="mb-2 w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
            />

            <p className="mb-1 text-[11px] font-semibold text-[#44546f] dark:text-gray-500">{t('nodes.kanbanCardItem.tsx.horasMax')}</p>
            <input
              type="number"
              min="0.5"
              step="0.5"
              value={quickMaxHours}
              onChange={e => setQuickMaxHours(e.target.value)}
              placeholder="Ex: 8"
              className="mb-3 w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
            />

            <div className="flex gap-2">
              <button
                onClick={() => void saveQuickEdit()}
                disabled={saving || !quickTitle.trim()}
                className="flex-1 rounded-lg bg-[#0c66e4] py-1.5 text-sm font-medium text-white hover:bg-[#0055cc] disabled:opacity-60"
              >
                {saving ? 'Salvando...' : 'Salvar'}
              </button>
              <button
                onClick={() => onClick(card)}
                className="rounded-lg border border-[#e2e6ea] px-3 py-1.5 text-sm text-[#44546f] hover:bg-slate-100 dark:border-gray-600 dark:text-gray-400"
              >
                Abrir
              </button>
            </div>
          </div>
        </>,
        document.body
      )}

      {contextMenuPos && (
        <CardContextMenu
          card={card}
          pos={contextMenuPos}
          onClose={() => setContextMenuPos(null)}
          onUpdated={onUpdated}
        />
      )}
    </div>
  );
});
