import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useChatStore } from '../../store';
import { MessageItem } from './MessageItem';
import type { TuiMessageDTO } from '@shared/types';

/**
 * Coalesce CONSECUTIVE `info` bubbles (the role used for slash-command
 * stdout — e.g. `/cost`, `/version`) into a single multiline info bubble
 * so MessageItem renders it via SlashOutputCard (key/value table, /trust
 * style) instead of N stacked single-liners with a redundant Info icon
 * each.
 *
 * Why merge here instead of in every handler:
 *   The CLI handlers in src/repl/slash-handlers/* historically emit one
 *   console.log per row. The bridge turns each into its own info message.
 *   Each handler COULD be rewritten to bundle into one console.log, but
 *   that's 11+ files of churn that gets re-broken whenever someone adds a
 *   new handler. Doing it once at the render boundary covers all current
 *   AND future handlers automatically.
 *
 * What is NOT merged: streaming bubbles, errors/warns, tool/assistant
 * messages — only role=info, and only across an unbroken consecutive
 * run. As soon as a non-info message appears, the next info starts a new
 * group.
 */
function coalesceInfoRuns(messages: TuiMessageDTO[]): TuiMessageDTO[] {
  if (messages.length < 2) return messages;
  const out: TuiMessageDTO[] = [];
  let runStart = -1;
  const flush = (until: number): void => {
    if (runStart < 0) return;
    const run = messages.slice(runStart, until);
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      out.push({
        ...run[0],
        // Stable id: first id in the run. React key stays the same across
        // renders even when more info messages arrive (run grows from the
        // end), so the card doesn't unmount/remount and lose scroll/state.
        id: run[0].id,
        text: run.map((m) => m.text || '').filter((t) => t.length > 0).join('\n'),
      });
    }
    runStart = -1;
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'info' && !m.streaming) {
      if (runStart < 0) runStart = i;
    } else {
      flush(i);
      out.push(m);
    }
  }
  flush(messages.length);
  return out;
}

/**
 * Lista de mensagens do chat. Auto-scroll pro bottom quando novas
 * mensagens chegam OU quando a última é atualizada em streaming.
 *
 * Não virtualizado nesta fase — assumimos conversas de até alguns milhares
 * de mensagens. Na Fase 5 avaliamos virtualização (react-virtual).
 */
export function MessageList(): React.ReactElement {
  const rawMessages = useChatStore((s) => s.messages);
  const messages = useMemo(() => coalesceInfoRuns(rawMessages), [rawMessages]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // wasAtBottom is captured BEFORE each new render commits (in onScroll)
  // so the post-render layout effect knows whether to stick to bottom.
  // Defaults to true so the very first messages auto-scroll on mount.
  const wasAtBottomRef = useRef(true);

  // Track whether the user is parked near the bottom. Updates on every
  // scroll event (user-driven) — content-growth doesn't fire scroll, so
  // this only flips when the human actually scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      wasAtBottomRef.current = distanceFromBottom < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Stick-to-bottom — runs synchronously AFTER DOM mutations, BEFORE paint
  // (useLayoutEffect). Setting scrollTop = scrollHeight is more reliable
  // across embedded webviews than scrollIntoView() — VSCode webview iframes
  // sometimes swallow the scrollIntoView side-effect on the inner overflow
  // container, which is what "ele nao ta rolando a pagina sozinho" was.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!wasAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Streaming chunks grow the inner container WITHOUT changing the
  // messages array reference (Zustand mutates the last message in
  // place). useLayoutEffect on [messages] won't fire — but a
  // ResizeObserver on the inner content does. Re-anchor on every
  // height growth while the user is at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!wasAtBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={scrollRef} className="h-full w-full overflow-y-auto">
      <div ref={innerRef} className="mx-auto max-w-4xl py-6" data-message-list-content>
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
      </div>
    </div>
  );
}
