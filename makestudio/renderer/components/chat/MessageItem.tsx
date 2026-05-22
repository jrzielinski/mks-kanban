import React from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import type { TuiMessageDTO, AuthStatusDTO } from '@shared/types';
import { Markdown } from './Markdown';
import { StreamCursor } from './StreamCursor';
import { ToolCard } from './ToolCard';
import {
  Info, AlertTriangle, Archive, ChevronDown, ChevronRight,
  Copy, Check, ThumbsUp, ThumbsDown, RefreshCw,
} from 'lucide-react';
import logoIcon from '../../assets/makestudioicon.png';
import { authApi, invoke } from '../../ipc/client';
import * as CH from '@shared/channels';
import { toast } from '../../lib/clientToast';
import { useChatStore } from '../../store';

interface Props {
  message: TuiMessageDTO;
}

export const MessageItem = React.memo(function MessageItem({
  message,
}: Props): React.ReactElement {
  if (message.role === 'user') {
    // Auto-compact resume marker: when the context overflows, auto-compact
    // pushes a "user" message containing the summary of prior turns so the
    // LLM still has continuity. We don't want to render it as a fake user
    // bubble — show it as a collapsible system note instead.
    const isCompactSummary =
      typeof message.text === 'string' &&
      (message.text.startsWith('This session is being continued from a previous conversation') ||
        message.text.startsWith('Continuation summary —'));
    if (isCompactSummary) {
      return <CompactSummaryCard text={message.text} />;
    }
    return (
      <div className="group flex flex-row-reverse gap-3 px-6 py-3">
        <UserAvatar />
        {/* Right-aligned chat bubble — modern messenger pattern.
            - max-w-[80%] keeps short prompts compact and long ones legible
            - bubble has rounded corners (asymmetric: tighter top-right where
              the avatar attaches, softer bottom-left for the "speech" feel)
            - subtle bg + border lifts the message off the chat background
            - text inside is LEFT-aligned for readability — only the bubble
              itself is right-positioned via flex-row-reverse on the parent */}
        <div className="flex min-w-0 max-w-[80%] flex-col items-end pt-0.5">
          <div className="rounded-2xl rounded-tr-md border border-border-subtle bg-surface-2/70 px-4 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="whitespace-pre-wrap break-words text-left text-[14px] leading-relaxed text-text">
              {message.text}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    // Suppress the bubble entirely when the assistant turn finished with no
    // text (the empty-response retry path leaves these stranded — every
    // failed iteration in chat.ts:288 adds an empty assistant bubble that
    // becomes a lonely floating avatar after the retry succeeds in a new
    // bubble). Streaming bubbles always render so the user sees the cursor
    // immediately on submit.
    if (!message.streaming && !message.text) return null;
    return (
      <div className="group flex gap-3 px-6 py-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <img
            src={logoIcon}
            alt="MakeStudio"
            className="h-7 w-7 object-contain drop-shadow-[0_0_12px_rgba(232,93,39,0.35)]"
            draggable={false}
          />
        </div>
        <div className="min-w-0 flex-1">
          <Markdown text={message.text || ''} />
          {message.streaming && <StreamCursor />}
          {!message.streaming && message.text && (
            <AssistantActions messageId={message.id} text={message.text} />
          )}
        </div>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <div className="px-6 py-1">
        <div className="ml-10">
          <ToolCard message={message} />
        </div>
      </div>
    );
  }

  if (message.role === 'info') {
    const cleaned = stripAnsi(message.text || '');
    const isMultiline = cleaned.includes('\n');
    if (isMultiline) {
      return (
        <div className="px-6 py-1.5">
          <div className="ml-10">
            <SlashOutputCard text={cleaned} />
          </div>
        </div>
      );
    }
    return (
      <div className="px-6 py-1">
        <div className="ml-10 flex items-start gap-2 text-dim">
          <Info size={12} strokeWidth={2} className="mt-[3px] shrink-0" />
          <span className="text-[12.5px]">{cleaned}</span>
        </div>
      </div>
    );
  }

  if (message.role === 'warn' || message.role === 'error') {
    const isErr = message.role === 'error';
    return (
      <div className="px-6 py-1.5">
        <div
          className={clsx(
            'ml-10 flex items-start gap-2 text-[12.5px]',
            isErr ? 'text-danger' : 'text-warning',
          )}
        >
          <AlertTriangle size={12} strokeWidth={2} className="mt-[3px] shrink-0" />
          <span className="whitespace-pre-wrap">{message.text}</span>
        </div>
      </div>
    );
  }

  // system / fallback
  return (
    <div className="px-6 py-1">
      <div className="ml-10 text-[12.5px] italic text-dim">{message.text}</div>
    </div>
  );
});

/**
 * Botões de ação no rodapé de cada mensagem do assistente.
 * Estilo Claude/ChatGPT: copiar, like, dislike, regenerar.
 *
 * - Copiar: clipboard + toast de confirmação (ícone vira ✓ por 1.5s)
 * - 👍 / 👎: feedback local (toast). Persistência em backend pode entrar depois.
 * - Regenerar: dispara `/retry` no agente — mesma slash command do CLI.
 */
function AssistantActions({
  messageId,
  text,
}: {
  messageId: string;
  text: string;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const [feedback, setFeedback] = React.useState<'up' | 'down' | null>(null);
  const [regenerating, setRegenerating] = React.useState(false);
  const busy = useChatStore((s) => s.busy);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Copiado');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Falha ao copiar');
    }
  };

  const handleFeedback = (kind: 'up' | 'down'): void => {
    if (feedback === kind) {
      setFeedback(null);
      return;
    }
    setFeedback(kind);
    toast.success(
      kind === 'up' ? 'Obrigado pelo feedback!' : 'Anotado — vamos melhorar.',
    );
  };

  const handleRegenerate = async (): Promise<void> => {
    if (busy || regenerating) return;
    setRegenerating(true);
    try {
      await invoke(CH.AGENT_SUBMIT, '/retry');
    } catch (err) {
      toast.error(`Falha ao regenerar: ${(err as Error)?.message ?? err}`);
    } finally {
      window.setTimeout(() => setRegenerating(false), 800);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-1 text-dim">
      <ActionButton
        title={copied ? 'Copiado' : 'Copiar mensagem'}
        onClick={handleCopy}
        active={copied}
      >
        {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={1.8} />}
      </ActionButton>
      <ActionButton
        title="Resposta útil"
        onClick={() => handleFeedback('up')}
        active={feedback === 'up'}
      >
        <ThumbsUp
          size={13}
          strokeWidth={1.8}
          fill={feedback === 'up' ? 'currentColor' : 'none'}
        />
      </ActionButton>
      <ActionButton
        title="Resposta ruim"
        onClick={() => handleFeedback('down')}
        active={feedback === 'down'}
      >
        <ThumbsDown
          size={13}
          strokeWidth={1.8}
          fill={feedback === 'down' ? 'currentColor' : 'none'}
        />
      </ActionButton>
      <ActionButton
        title={busy ? 'Aguarde a resposta atual terminar' : 'Gerar nova resposta'}
        onClick={handleRegenerate}
        disabled={busy || regenerating}
      >
        <RefreshCw
          size={13}
          strokeWidth={1.8}
          className={regenerating ? 'animate-spin' : ''}
        />
      </ActionButton>
    </div>
  );
}

/**
 * Remove ANSI escape codes (cores do chalk) que vazam pra info messages
 * via console.log do CLI. Padrão genérico: ESC[ ... m.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[a-zA-Z]/g, '');
}



/**
 * Auto-compact resume summary card. Auto-compact stores the
 * post-summarisation continuity message as `role: 'user'` so the LLM
 * has continuity across the context boundary. The renderer needs to
 * present it as a system note (collapsed by default) — otherwise the
 * top of every long-running session is a wall of right-aligned
 * pseudo-user text that confuses people into thinking they wrote it.
 */
/**
 * User avatar — initials in a gradient circle. Matches the avatar in
 * Sidebar.tsx (account row) so the same person reads as the same person
 * in both places. Falls back to "?" when the auth query hasn't resolved
 * yet — TanStack Query caches `['auth', 'status']` across the app, so
 * by the time the chat is visible this is always populated.
 */
function userInitials(email?: string | null): string {
  if (!email) return '?';
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._\-+]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function UserAvatar(): React.ReactElement {
  const authQ = useQuery<AuthStatusDTO>({
    queryKey: ['auth', 'status'],
    queryFn: () => authApi.status(),
    staleTime: 60_000,
  });
  const email = authQ.data?.email ?? null;
  return (
    <div
      title={email ?? 'Voce'}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-secondary to-tertiary text-[10.5px] font-bold text-text shadow-sm"
    >
      {userInitials(email)}
    </div>
  );
}

function CompactSummaryCard({ text }: { text: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  // Word/section counters give the badge a useful preview without
  // forcing the user to expand. Sections are detected by the headed
  // pattern auto-compact emits ("1. Primary Request and Intent:" etc).
  const sectionCount = (text.match(/^\d+\.\s+\S/gm) || []).length;
  const wordCount = text.trim().split(/\s+/).length;
  return (
    <div className="px-6 py-3">
      <div className="ml-10">
        <div
          className={clsx(
            'group relative overflow-hidden rounded-xl border transition-all duration-200',
            open
              ? 'border-primary/30 bg-gradient-to-br from-primary/[0.08] via-surface-1 to-surface-1 shadow-[0_8px_30px_-12px_rgba(232,93,39,0.18)]'
              : 'border-border-subtle bg-gradient-to-br from-surface-1 to-surface-1/40 hover:border-primary/25 hover:shadow-[0_4px_16px_-8px_rgba(232,93,39,0.15)]',
          )}
        >
          {/* Decorative corner glow — claude.ai-style ambient light */}
          <div
            aria-hidden="true"
            className={clsx(
              'pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-primary/15 blur-3xl transition-opacity',
              open ? 'opacity-60' : 'opacity-30 group-hover:opacity-50',
            )}
          />

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="relative flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            {/* Icon badge — primary tinted square with archive glyph */}
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/20">
              <Archive size={15} strokeWidth={2} />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-semibold tracking-tight text-text">
                  Resumo da sessão anterior
                </span>
                <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">
                  auto-compact
                </span>
              </div>
              <div className="mt-1 text-[12px] leading-snug text-text-soft">
                A janela de contexto encheu — o sistema gerou um resumo dos
                turns anteriores pra preservar a continuidade da conversa.
                Clique pra expandir e ver o conteúdo.
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-dim">
                <span className="font-mono text-text-soft">{sectionCount} seções</span>
                <span className="text-dim/50">·</span>
                <span className="font-mono text-text-soft">
                  {wordCount.toLocaleString()} palavras
                </span>
                <span className="text-dim/50">·</span>
                <span className="font-mono text-text-soft">
                  {text.length.toLocaleString()} chars
                </span>
              </div>
            </div>

            {/* Toggle chevron — rotates instead of swapping for smoother feel */}
            <div
              className={clsx(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim transition-all',
                'group-hover:bg-surface-2 group-hover:text-text-soft',
                open && 'rotate-90 text-primary',
              )}
            >
              <ChevronRight size={14} strokeWidth={2.2} />
            </div>
          </button>

          {open && (
            <div className="relative border-t border-border-subtle/40 bg-surface-0/60 px-5 py-4">
              <Markdown
                text={text}
                className="prose-compact text-[12.5px] leading-[1.65]"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders multi-line slash-command output (e.g. /trust, /version,
 * /plugins, /cost) as a structured card with proper typography:
 *   - First line as title (sans, larger)
 *   - "key: value" lines as a definition list (label sans-dim, value sans)
 *   - Inline tokens that look like commands/paths/flags get mono treatment
 *   - Free-form lines fall through as paragraphs
 *
 * The handlers in agent/src/repl/slash-handlers/* still print plain text
 * via console.log (so CLI keeps working) — we just present that text more
 * nicely on the desktop renderer.
 */
function SlashOutputCard({ text }: { text: string }): React.ReactElement {
  const rawLines = text.split("\n").map((l) => l.replace(/^\s+/, "").replace(/\s+$/, ""));
  const lines = rawLines.filter((l) => l.length > 0);
  if (lines.length === 0) {
    return <div className="rounded-lg border border-border-subtle bg-surface-1/60 px-4 py-3" />;
  }
  // Unicode \p{L} matches any letter so accented Portuguese keys
  // ("Sessão", "Período", "Confiança") work alongside ASCII.
  const looksLikeKv = (l: string): boolean => /^[\p{L}_][\p{L}0-9_\-\s]{0,24}:\s+/u.test(l);
  const head = !looksLikeKv(lines[0]) ? lines[0] : null;
  const body = head ? lines.slice(1) : lines;
  const renderValue = (v: string, k: number): React.ReactNode => {
    const parts = v.split(/(\s+)/);
    return parts.map((p, i) => {
      if (/^\s+$/.test(p)) return <React.Fragment key={`${k}-${i}`}>{p}</React.Fragment>;
      const isCode =
        /^\//.test(p) ||
        /[/.][A-Za-z0-9_\-]/.test(p) ||
        /^--[a-z]/.test(p) ||
        (p === p.toUpperCase() && /^[A-Z][A-Z0-9_]+$/.test(p));
      if (isCode) {
        return (
          <code key={`${k}-${i}`} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-text-soft">{p}</code>
        );
      }
      return <React.Fragment key={`${k}-${i}`}>{p}</React.Fragment>;
    });
  };
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-1/60 px-5 py-4">
      {head && (
        (() => {
          // Split "Title — subtitle" / "Title - subtitle" / "Title: subtitle".
          // The em-dash convention is what slash handlers use already
          // (e.g. /trust → "/trust — modo de confianca da sessao").
          const split = head.match(/^(.+?)\s+(?:—|–|-|:)\s+(.+)$/);
          const title = split ? split[1] : head;
          const subtitle = split ? split[2] : null;
          return (
            <div className="mb-3 border-b border-border-subtle/60 pb-2.5">
              <div className="text-[14px] font-semibold tracking-tight text-text">
                {renderValue(title, -1)}
              </div>
              {subtitle && (
                <div className="mt-0.5 text-[12px] leading-snug text-dim">
                  {renderValue(subtitle, -2)}
                </div>
              )}
            </div>
          );
        })()
      )}
      <dl className="grid gap-y-1.5">
        {body.map((line, i) => {
          const m = line.match(/^([\p{L}_][\p{L}0-9_\-\s]{0,24}):\s+(.*)$/u);
          if (m) {
            return (
              <div key={i} className="grid grid-cols-[110px_1fr] items-baseline gap-x-3">
                <dt className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-dim/80">{m[1]}</dt>
                <dd className="text-[12.5px] leading-relaxed text-text-soft">{renderValue(m[2], i)}</dd>
              </div>
            );
          }
          return (
            <div key={i} className="text-[12.5px] leading-relaxed text-text-soft">
              {renderValue(line, i)}
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function ActionButton({
  children,
  title,
  onClick,
  active,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-dim hover:bg-surface-2 hover:text-text-soft',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-dim',
      )}
    >
      {children}
    </button>
  );
}
