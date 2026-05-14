import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, MessageSquare, Link2 } from 'lucide-react';
import toast from 'react-hot-toast';
import kanbanService, { KanbanCard } from '@/services/kanban.service';

/**
 * Inline right-click menu for kanban cards. Lives in a portal at
 * `document.body` so it can escape any `overflow: hidden` clipping from the
 * board's scroll container; positioned absolutely at the cursor's
 * `clientX/Y`. The menu auto-flips when it would overflow the viewport.
 *
 * Why context menu instead of always-opening the CardDetailModal:
 *   - common micro-actions (snooze a card, drop a comment, copy link) don't
 *     justify the cost of opening / rendering the full modal
 *   - keeps the board layout intact — the user can right-click multiple
 *     cards in succession without modal close/reopen churn
 *
 * Actions implemented in v1:
 *   - Add comment (inline input + Enter)
 *   - Snooze (1d / 1w / 2w / clear) — sets `dueDate`
 *   - Copy link
 *
 * Deliberately deferred:
 *   - Move to list — needs a secondary picker; covered by drag-and-drop
 *   - Log hours — needs a numeric input; covered by the detail modal
 */

interface Props {
  /** Card being acted on. */
  card: KanbanCard;
  /** Cursor position to anchor the menu at (clientX/Y). */
  pos: { x: number; y: number };
  /** Close handler — called after a successful action OR when the user
   *  clicks outside / presses Escape. */
  onClose: () => void;
  /** Notify the parent (KanbanCardItem) that the card mutated so it can
   *  update its local state without waiting for a full re-fetch. */
  onUpdated?: (next: KanbanCard) => void;
  /** Optional callback when the user comments — lets the parent surface a
   *  notification or refresh `commentCount`. */
  onCommented?: () => void;
}

/** Approximate menu dimensions used for viewport-fit calculations. The exact
 *  rendered size depends on content, but this is close enough to avoid
 *  jumping. If the menu overflows we re-anchor against the opposite edge. */
const MENU_W = 240;
const MENU_H_BASE = 220;
const MENU_H_WITH_INPUT = 320;

export function CardContextMenu({ card, pos, onClose, onUpdated, onCommented }: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<null | string>(null);

  // Outside click / Escape close. We listen on capture so we beat any
  // descendant `stopPropagation` calls (the kanban canvas has a few).
  useEffect(() => {
    const onPointer = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    // setTimeout so the click that *opened* the menu doesn't immediately
    // close it (the right-click fires before this effect's listener
    // registers, but a subsequent left-click would).
    const t = setTimeout(() => {
      window.addEventListener('mousedown', onPointer, true);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const adjusted = useMemo(() => fitToViewport(pos, commenting ? MENU_H_WITH_INPUT : MENU_H_BASE), [pos, commenting]);

  const snooze = useCallback(
    async (days: number | null): Promise<void> => {
      const tag = days === null ? 'clear' : `snooze-${days}d`;
      setBusy(tag);
      try {
        const nextDue = days === null ? null : isoDateNDaysFromNow(days);
        const next = await kanbanService.updateCard(card.id, { dueDate: nextDue });
        onUpdated?.(next);
        toast.success(days === null ? 'Due date cleared.' : `Snoozed ${days}d.`);
        onClose();
      } catch (e) {
        toast.error('Could not update card — ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        setBusy(null);
      }
    },
    [card.id, onUpdated, onClose],
  );

  const copyLink = useCallback(async () => {
    setBusy('copy');
    try {
      const url = buildCardLink(card);
      await navigator.clipboard.writeText(url);
      toast.success('Card link copied.');
      onClose();
    } catch (e) {
      toast.error('Could not copy — ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }, [card, onClose]);

  const submitComment = useCallback(async () => {
    const text = comment.trim();
    if (!text) return;
    setBusy('comment');
    try {
      await kanbanService.addActivity(card.id, text);
      toast.success('Comment added.');
      setComment('');
      onCommented?.();
      onClose();
    } catch (e) {
      toast.error('Could not add comment — ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }, [card.id, comment, onCommented, onClose]);

  return createPortal(
    <div
      ref={rootRef}
      className="fixed z-[10000] w-60 overflow-hidden rounded-xl border border-slate-200 bg-white text-sm shadow-2xl dark:border-gray-700 dark:bg-gray-800"
      style={{ left: adjusted.x, top: adjusted.y }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="border-b border-slate-100 px-3 py-2 text-[11px] uppercase tracking-wider text-slate-400 dark:border-gray-700 dark:text-slate-500">
        {truncate(card.title || 'Card', 32)}
      </div>

      {/* Comment row */}
      {!commenting ? (
        <MenuRow
          icon={<MessageSquare className="h-4 w-4" />}
          label="Add comment…"
          onClick={() => setCommenting(true)}
          disabled={busy !== null}
        />
      ) : (
        <div className="px-3 py-2">
          <textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submitComment();
              }
            }}
            placeholder="Write a comment… (Ctrl/⌘+Enter to send)"
            className="w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            rows={3}
          />
          <div className="mt-1 flex justify-end gap-1">
            <button
              type="button"
              onClick={() => { setComment(''); setCommenting(false); }}
              className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!comment.trim() || busy === 'comment'}
              onClick={() => void submitComment()}
              className="rounded-md bg-blue-500 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'comment' ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}

      <div className="my-1 border-t border-slate-100 dark:border-gray-700" />

      <MenuRow
        icon={<Clock className="h-4 w-4" />}
        label="Snooze 1 day"
        onClick={() => void snooze(1)}
        disabled={busy === 'snooze-1d'}
      />
      <MenuRow
        icon={<Clock className="h-4 w-4" />}
        label="Snooze 1 week"
        onClick={() => void snooze(7)}
        disabled={busy === 'snooze-7d'}
      />
      <MenuRow
        icon={<Clock className="h-4 w-4" />}
        label="Snooze 2 weeks"
        onClick={() => void snooze(14)}
        disabled={busy === 'snooze-14d'}
      />
      {card.dueDate ? (
        <MenuRow
          icon={<Clock className="h-4 w-4" />}
          label="Clear due date"
          onClick={() => void snooze(null)}
          disabled={busy === 'clear'}
          tone="muted"
        />
      ) : null}

      <div className="my-1 border-t border-slate-100 dark:border-gray-700" />

      <MenuRow
        icon={<Link2 className="h-4 w-4" />}
        label="Copy card link"
        onClick={() => void copyLink()}
        disabled={busy === 'copy'}
      />
    </div>,
    document.body,
  );
}

function MenuRow(props: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'normal' | 'muted';
}): JSX.Element {
  const muted = props.tone === 'muted';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        muted
          ? 'text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-gray-700'
          : 'text-slate-700 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-gray-700'
      }`}
      role="menuitem"
    >
      <span className={muted ? 'text-slate-400 dark:text-slate-500' : 'text-slate-500 dark:text-slate-400'}>
        {props.icon}
      </span>
      {props.label}
    </button>
  );
}

function fitToViewport(pos: { x: number; y: number }, height: number): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const PADDING = 8;
  let x = pos.x;
  let y = pos.y;
  if (x + MENU_W + PADDING > vw) x = Math.max(PADDING, vw - MENU_W - PADDING);
  if (y + height + PADDING > vh) y = Math.max(PADDING, vh - height - PADDING);
  return { x, y };
}

function isoDateNDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function buildCardLink(card: KanbanCard): string {
  // Mirrors the URL the canvas itself uses for "view card" navigation. We
  // include both board and card ids so the recipient lands on the right
  // board even if they don't have it open.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const boardId = (card as unknown as { boardId?: string }).boardId ?? '';
  return `${origin}/kanban/${encodeURIComponent(boardId)}?card=${encodeURIComponent(card.id)}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
