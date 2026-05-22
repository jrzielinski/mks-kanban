import React from 'react';
import clsx from 'clsx';
import { Code2, GraduationCap, Gem, PenLine, TerminalSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import logoIcon from '../assets/makestudioicon.png';
import { useChatStore } from '../store';
import { MessageList } from '../components/chat/MessageList';
import { InputBox } from '../components/input/InputBox';
import { useAuth } from '../hooks/useAuth';
import { invoke } from '../ipc/client';
import * as CH from '@shared/channels';

interface Suggestion {
  label: string;
  icon: LucideIcon;
  /** Submete direto pro agente sem mostrar popover. Usado pra Comandos → /help. */
  submit?: string;
  /** Lista de prompts prontos. Click no chip abre popover com estes;
   *  click num deles fila o texto completo no input pra envio. */
  examples?: string[];
}

const SUGGESTIONS: Suggestion[] = [
  {
    label: 'Código',
    icon: Code2,
    examples: [
      'Faça um code review do arquivo aberto e aponte os 3 maiores riscos.',
      'Refatore essa função pra ficar mais legível, sem mudar comportamento.',
      'Escreva testes unitários cobrindo os casos de borda dessa função.',
      'Ache e corrija o bug que tá causando este erro: ',
      'Explique o que esse código faz, passo a passo, em PT-BR.',
    ],
  },
  {
    label: 'Aprender',
    icon: GraduationCap,
    examples: [
      'Me explique o conceito de programação concorrente em JavaScript.',
      'Qual a diferença entre throttle e debounce, com exemplos?',
      'Como funciona um event loop em Node.js? Inclua exemplos.',
      'Me ensine os princípios SOLID com exemplos curtos em TypeScript.',
      'Explique o que é prompt caching em LLMs e quando vale a pena.',
    ],
  },
  {
    label: 'Criar',
    icon: Gem,
    examples: [
      'Crie um endpoint REST em NestJS com CRUD completo de usuários.',
      'Crie um componente React com tabela, busca e paginação.',
      'Crie um schema Zod pra validar este payload: ',
      'Crie um GitHub Actions workflow que roda lint + tests no PR.',
      'Crie um Dockerfile multi-stage pra Node.js produção.',
    ],
  },
  {
    label: 'Escrever',
    icon: PenLine,
    examples: [
      'Escreva uma mensagem de commit clara pro diff atual.',
      'Escreva o README desse projeto com as seções essenciais.',
      'Escreva um changelog do que mudou desde o último release.',
      'Escreva a descrição de PR pra essa branch.',
      'Escreva uma docstring detalhada pra essa função.',
    ],
  },
  { label: 'Comandos', icon: TerminalSquare, submit: '/help' },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Boa madrugada';
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

// Derive a display name from the auth email's local part. Splits on
// `.`, `_` and `-` so "joao.silva" → "Joao Silva". Single tokens like
// "jrzielinski" stay as "Jrzielinski".
function deriveDisplayName(email: string | undefined): string {
  const local = (email ?? '').split('@')[0] ?? '';
  if (!local) return 'Operador';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function ChatPage(): React.ReactElement {
  // Welcome state: nenhuma mensagem ainda OU só mensagens de sistema/info/warn
  // (ex.: aviso de "não autenticado") sem turn do user/assistant.
  const hasRealTurn = useChatStore((s) =>
    s.messages.some((m) => m.role === 'user' || m.role === 'assistant'),
  );

  if (hasRealTurn) {
    return (
      <div className="relative flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <MessageList />
        </div>
        <InputBox />
      </div>
    );
  }

  return <WelcomeState />;
}

function WelcomeState(): React.ReactElement {
  const auth = useAuth();
  const userName = React.useMemo(
    () => deriveDisplayName(auth.data?.email),
    [auth.data?.email],
  );
  const systemMessages = useChatStore((s) =>
    s.messages.filter((m) => m.role === 'info' || m.role === 'warn' || m.role === 'error'),
  );

  const [openSuggestion, setOpenSuggestion] = React.useState<string | null>(null);

  const submitDirect = (text: string): void => {
    invoke(CH.AGENT_SUBMIT, text).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[suggestion] submit failed', err);
    });
  };

  const fillInput = (text: string): void => {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea');
    if (ta) {
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      // Move caret to end so the user can keep typing where the example
      // left off (most prompts end with a colon waiting for context).
      const len = text.length;
      try { ta.setSelectionRange(len, len); } catch { /* */ }
    }
  };

  const handleSuggestion = (s: Suggestion): void => {
    if (s.submit) {
      submitDirect(s.submit);
      return;
    }
    if (s.examples && s.examples.length > 0) {
      setOpenSuggestion((cur) => (cur === s.label ? null : s.label));
    }
  };

  // Close popover on outside click / Esc.
  React.useEffect(() => {
    if (!openSuggestion) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('[data-suggestion-root]')) return;
      setOpenSuggestion(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenSuggestion(null);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [openSuggestion]);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center px-6">
      {/* Heading — logo MakeStudio + saudação em sans-serif */}
      <div className="mb-10 flex items-center gap-4">
        <img
          src={logoIcon}
          alt="MakeStudio"
          className="h-12 w-12 shrink-0 object-contain drop-shadow-[0_0_24px_rgba(232,93,39,0.25)]"
        />
        <h1 className="text-[36px] font-semibold leading-none tracking-tight text-text">
          {greeting()}, <span className="bg-gradient-to-r from-secondary via-primary to-primary-soft bg-clip-text text-transparent">{userName}</span>
        </h1>
      </div>

      {/* Input — versão welcome, maior e centralizado */}
      <div className="w-full">
        <InputBox variant="welcome" />
      </div>

      {/* Chips horizontais — cada um abre um popover com prompts prontos
          (exceto Comandos, que vai direto pra /help). */}
      <div
        className="mt-5 flex flex-wrap items-center justify-center gap-2"
        data-suggestion-root
      >
        {SUGGESTIONS.map((s) => (
          <div key={s.label} className="relative" data-suggestion-root>
            <button
              type="button"
              onClick={() => handleSuggestion(s)}
              className={clsx(
                'group inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] transition-colors',
                openSuggestion === s.label
                  ? 'border-primary/40 bg-primary/[0.08] text-text'
                  : 'border-border-soft bg-surface-1 text-text-soft hover:bg-surface-2 hover:text-text',
              )}
            >
              <s.icon
                size={14}
                strokeWidth={1.8}
                className={clsx(
                  'transition-colors',
                  openSuggestion === s.label
                    ? 'text-primary'
                    : 'text-dim-soft group-hover:text-primary',
                )}
              />
              {s.label}
            </button>

            {openSuggestion === s.label && s.examples && (
              <div
                data-suggestion-root
                className="absolute left-1/2 z-30 mt-2 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border-subtle bg-surface-1 shadow-elev backdrop-blur"
              >
                <div className="flex items-center gap-2 border-b border-border-subtle/60 px-4 py-2.5">
                  <s.icon size={13} strokeWidth={2} className="text-primary" />
                  <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                    {s.label}
                  </span>
                  <span className="text-[11px] text-dim">
                    · clique pra preencher · ⏎ pra enviar
                  </span>
                </div>
                <div className="max-h-[60vh] overflow-y-auto py-1">
                  {s.examples.map((ex, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        fillInput(ex);
                        setOpenSuggestion(null);
                      }}
                      className="flex w-full items-start gap-2 px-4 py-2 text-left text-[12.5px] leading-relaxed text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
                    >
                      <span className="mt-[2px] shrink-0 text-[10px] font-mono text-dim/60">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span>{ex}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Avisos do sistema (auth, etc.) — abaixo das suggestions, discretos */}
      {systemMessages.length > 0 && (
        <div className="mt-8 flex w-full max-w-2xl flex-col gap-1.5">
          {systemMessages.slice(-3).map((m) => (
            <div
              key={m.id}
              className={clsx(
                'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]',
                m.role === 'error'
                  ? 'border-danger/30 bg-danger/[0.06] text-danger'
                  : m.role === 'warn'
                    ? 'border-warning/25 bg-warning/[0.05] text-warning/95'
                    : 'border-border-subtle bg-surface-2/40 text-dim-soft',
              )}
            >
              <span className="mt-[1px] shrink-0 text-[11px] opacity-80">
                {m.role === 'error' ? '×' : m.role === 'warn' ? '!' : 'i'}
              </span>
              <span className="leading-relaxed">{m.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
