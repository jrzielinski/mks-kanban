import React from 'react';
import { useMutation } from '@tanstack/react-query';
import { MessageSquare, Bug, Lightbulb, HelpCircle, Send, Check, RefreshCw, Paperclip } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { feedbackApi } from '../ipc/client';

type Category = 'bug' | 'feature' | 'other';

const CATEGORIES: { id: Category; label: string; icon: React.ReactNode; description: string }[] = [
  {
    id: 'bug',
    label: 'Bug',
    icon: <Bug size={15} />,
    description: 'Algo não está funcionando como esperado',
  },
  {
    id: 'feature',
    label: 'Sugestão',
    icon: <Lightbulb size={15} />,
    description: 'Uma ideia ou melhoria que gostaria de ver',
  },
  {
    id: 'other',
    label: 'Outro',
    icon: <HelpCircle size={15} />,
    description: 'Elogios, dúvidas ou qualquer outra coisa',
  },
];

const MAX_CHARS = 2000;

export function FeedbackPage(): React.ReactElement {
  const [category, setCategory] = React.useState<Category>('bug');
  const [text, setText] = React.useState('');
  const [attachLogs, setAttachLogs] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  const sendMut = useMutation({
    mutationFn: () => feedbackApi.send({ category, text: text.trim(), attachLogs }),
    onSuccess: (res) => {
      if (res.ok) {
        setSent(true);
        toast.success('Feedback enviado. Obrigado!');
      } else {
        toast.error(res.error ?? 'Falha ao enviar feedback');
      }
    },
    onError: (e: any) => toast.error(e?.message ?? 'Erro ao enviar'),
  });

  function reset(): void {
    setText('');
    setCategory('bug');
    setAttachLogs(false);
    setSent(false);
  }

  const charsLeft = MAX_CHARS - text.length;
  const canSubmit = text.trim().length >= 10 && !sendMut.isPending;

  if (sent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 px-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10 text-success">
          <Check size={28} strokeWidth={2} />
        </div>
        <div className="text-center">
          <h2 className="text-[18px] font-semibold text-text">Feedback enviado!</h2>
          <p className="mt-1 text-[13px] text-text-soft">
            Obrigado por ajudar a melhorar o MakeStudio.
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-border-subtle px-4 py-2 text-[12px] text-text-soft hover:text-text"
        >
          Enviar outro feedback
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-border-subtle px-6 py-4">
        <MessageSquare size={16} className="text-primary" />
        <h1 className="text-[18px] font-semibold text-text">Feedback</h1>
      </header>

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-xl">

          {/* Category picker */}
          <fieldset className="mb-6">
            <legend className="mb-3 text-[12px] font-medium text-text-soft">
              Categoria
            </legend>
            <div className="grid grid-cols-3 gap-3">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  aria-pressed={category === cat.id}
                  onClick={() => setCategory(cat.id)}
                  className={clsx(
                    'flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center transition-colors',
                    category === cat.id
                      ? 'border-primary/40 bg-primary/8 text-primary'
                      : 'border-border-subtle bg-surface-2/30 text-text-soft hover:border-border-soft hover:text-text',
                  )}
                >
                  <span aria-hidden="true">{cat.icon}</span>
                  <span className="text-[12px] font-medium">{cat.label}</span>
                  <span className="text-[10px] leading-tight opacity-70">{cat.description}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {/* Text area */}
          <div className="mb-4">
            <label htmlFor="feedback-text" className="mb-2 block text-[12px] font-medium text-text-soft">
              Mensagem
              <span className="ml-1 text-dim">(mín. 10 caracteres)</span>
            </label>
            <textarea
              id="feedback-text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
              placeholder={
                category === 'bug'
                  ? 'Descreva o problema: o que aconteceu, o que você esperava que acontecesse, passos para reproduzir…'
                  : category === 'feature'
                  ? 'Descreva a funcionalidade que você gostaria de ver…'
                  : 'Sua mensagem…'
              }
              rows={7}
              className="w-full resize-none rounded-lg border border-border-subtle bg-surface-2 px-4 py-3 text-[13px] text-text outline-none placeholder:text-dim focus:border-primary"
              aria-describedby="feedback-chars"
            />
            <p
              id="feedback-chars"
              className={clsx(
                'mt-1 text-right text-[10px]',
                charsLeft < 100 ? 'text-warning' : 'text-dim',
              )}
            >
              {charsLeft} caracteres restantes
            </p>
          </div>

          {/* Attach logs toggle */}
          <label className="mb-6 flex cursor-pointer items-center gap-3 rounded-lg border border-border-subtle bg-surface-2/30 px-4 py-3">
            <input
              type="checkbox"
              checked={attachLogs}
              onChange={(e) => setAttachLogs(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
              aria-label="Incluir logs de debug recentes"
            />
            <Paperclip size={13} className="shrink-0 text-dim-soft" aria-hidden="true" />
            <div className="flex-1">
              <p className="text-[12px] font-medium text-text">Incluir logs de debug recentes</p>
              <p className="text-[10px] text-dim">Últimas 50 entradas do log de sessão — ajuda a diagnosticar bugs</p>
            </div>
          </label>

          {/* Submit */}
          <button
            type="button"
            onClick={() => sendMut.mutate()}
            disabled={!canSubmit}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-[13px] font-semibold text-surface-0 hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Enviar feedback"
          >
            {sendMut.isPending
              ? <><RefreshCw size={14} className="animate-spin" /> Enviando…</>
              : <><Send size={14} /> Enviar feedback</>}
          </button>

          <p className="mt-4 text-center text-[11px] text-dim">
            Feedback salvo localmente como fallback se a conexão com o servidor falhar.
          </p>
        </div>
      </div>
    </div>
  );
}
