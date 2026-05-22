import React from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Play,
  Square,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  History,
  X,
  Lightbulb,
} from 'lucide-react';
import clsx from 'clsx';
import { headlessApi, subscribe } from '../ipc/client';
import * as CH from '@shared/channels';
import type { HeadlessOutputDTO, HeadlessDoneDTO } from '@shared/types';

interface RunState {
  runId: string;
  startedAt: number;
  done: boolean;
  exitCode: number | null;
  durationMs: number | null;
  tokenEstimate: number;
}

interface OutputLine {
  id: number;
  channel: HeadlessOutputDTO['channel'];
  text: string;
  ts: number;
}

interface HistoryEntry {
  id: string;
  prompt: string;
  ranAt: string;
  exitCode: number | null;
  durationMs: number;
  tokenEstimate: number;
  yes: boolean;
  maxTurns: number;
  format: 'text' | 'json';
}

const MAX_LINES = 1000;
const HISTORY_KEY = 'makestudio:headless:history';
const HISTORY_LIMIT = 20;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch { /* quota — best effort */ }
}

// Approximate token count: ~4 chars per token is a decent average for
// English-ish text, good enough for surfacing run cost on the UI.
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function HeadlessRunnerPage(): React.ReactElement {
  const [prompt, setPrompt] = React.useState('');
  const [yes, setYes] = React.useState(false);
  const [maxTurns, setMaxTurns] = React.useState(50);
  const [format, setFormat] = React.useState<'text' | 'json'>('text');
  const [run, setRun] = React.useState<RunState | null>(null);
  const [lines, setLines] = React.useState<OutputLine[]>([]);
  const [elapsed, setElapsed] = React.useState(0);
  const [history, setHistory] = React.useState<HistoryEntry[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const lineCounter = React.useRef(0);
  const outputRef = React.useRef<HTMLDivElement>(null);
  // Snapshot the launch parameters so EVT_HEADLESS_DONE (which fires from a
  // global subscriber) can persist them in the history alongside exit code.
  const launchSnapshot = React.useRef<{
    prompt: string;
    yes: boolean;
    maxTurns: number;
    format: 'text' | 'json';
  } | null>(null);

  // Subscribers globais — filtramos por runId no handler.
  React.useEffect(() => {
    const offOut = subscribe<HeadlessOutputDTO>(
      CH.EVT_HEADLESS_OUTPUT,
      (chunk) => {
        if (!run || run.done) return;
        if (chunk.runId !== run.runId) return;
        if (chunk.channel === 'assistant') {
          const delta = approxTokens(chunk.text);
          setRun((prev) =>
            prev && prev.runId === chunk.runId && !prev.done
              ? { ...prev, tokenEstimate: prev.tokenEstimate + delta }
              : prev,
          );
        }
        setLines((prev) => {
          const next = [
            ...prev,
            {
              id: lineCounter.current++,
              channel: chunk.channel,
              text: chunk.text,
              ts: chunk.ts,
            },
          ];
          if (next.length > MAX_LINES) next.splice(0, next.length - MAX_LINES);
          return next;
        });
      },
    );
    const offDone = subscribe<HeadlessDoneDTO>(CH.EVT_HEADLESS_DONE, (done) => {
      if (!run || run.done) return;
      if (done.runId !== run.runId) return;
      const finalText = done.finalText ?? '';
      // Token estimate at done = max(streamed deltas, final assistant text).
      // The non-streaming path emits the assistant message in one shot, so
      // either source can dominate.
      const finalTokens = Math.max(run.tokenEstimate, approxTokens(finalText));
      setRun({
        ...run,
        done: true,
        exitCode: done.exitCode,
        durationMs: done.durationMs,
        tokenEstimate: finalTokens,
      });
      const snap = launchSnapshot.current;
      if (snap) {
        const entry: HistoryEntry = {
          id: done.runId,
          prompt: snap.prompt,
          ranAt: new Date().toISOString(),
          exitCode: done.exitCode,
          durationMs: done.durationMs,
          tokenEstimate: finalTokens,
          yes: snap.yes,
          maxTurns: snap.maxTurns,
          format: snap.format,
        };
        setHistory((prev) => {
          const next = [entry, ...prev].slice(0, HISTORY_LIMIT);
          saveHistory(next);
          return next;
        });
      }
    });
    return () => {
      offOut();
      offDone();
    };
  }, [run]);

  // Timer enquanto rodando.
  React.useEffect(() => {
    if (!run || run.done) return;
    const t = window.setInterval(() => {
      setElapsed(Date.now() - run.startedAt);
    }, 250);
    return () => window.clearInterval(t);
  }, [run]);

  // Auto-scroll pro final.
  React.useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const runMut = useMutation({
    mutationFn: (args: {
      prompt: string;
      yes?: boolean;
      maxTurns?: number;
      format?: 'text' | 'json';
    }) => headlessApi.run(args),
    onSuccess: (res) => {
      setRun({
        runId: res.runId,
        startedAt: Date.parse(res.startedAt) || Date.now(),
        done: false,
        exitCode: null,
        durationMs: null,
        tokenEstimate: 0,
      });
      setLines([]);
      lineCounter.current = 0;
      setElapsed(0);
    },
  });

  const stopMut = useMutation({
    mutationFn: (runId: string) => headlessApi.stop(runId),
  });

  const submit = (): void => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (run && !run.done) return;
    launchSnapshot.current = { prompt: trimmed, yes, maxTurns, format };
    runMut.mutate({ prompt: trimmed, yes, maxTurns, format });
  };

  const reloadFromHistory = (entry: HistoryEntry): void => {
    if (run && !run.done) return;
    setPrompt(entry.prompt);
    setYes(entry.yes);
    setMaxTurns(entry.maxTurns);
    setFormat(entry.format);
    setHistoryOpen(false);
  };

  const clearHistory = (): void => {
    setHistory([]);
    saveHistory([]);
  };

  const stop = (): void => {
    if (!run || run.done) return;
    stopMut.mutate(run.runId);
  };

  const clearOutput = (): void => {
    setLines([]);
    setRun(null);
    setElapsed(0);
  };

  const isRunning = run !== null && !run.done;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-text">Execução rápida</h1>
          <p className="mt-0.5 text-[12.5px] text-dim-soft">
            Pergunte algo ou peça uma tarefa única — sem abrir uma conversa.
          </p>
        </div>
      </header>

      {/* Banner explicativo — pra quem não conhece "headless runner" */}
      <div className="flex items-start gap-2 border-b border-border-subtle bg-primary/[0.04] px-6 py-3 text-[12px] leading-relaxed text-text-soft">
        <Lightbulb size={13} className="mt-0.5 shrink-0 text-primary" strokeWidth={2} />
        <div>
          <p>
            <span className="font-medium text-text">O que isso faz:</span> manda
            uma instrução pro agente, ele executa de uma vez só e mostra o
            resultado aqui. Diferente do chat, não tem ida-e-volta — é uma rajada
            única.
          </p>
          <p className="mt-1.5 text-dim">
            <span className="font-medium text-text-soft">Bom pra:</span> resumir
            mudanças ("o que mudou nesta branch?"), gerar código pontual ("crie
            um README pra este projeto"), checagens rápidas ("os testes estão
            passando?") — qualquer coisa que dê pra responder de uma vez.
          </p>
        </div>
      </div>

      {/* Controls */}
      <section className="border-b border-border-subtle px-6 py-4">
        <label className="mb-1 block text-[11px] uppercase tracking-[0.1em] text-dim/80">
          Prompt
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={4}
          placeholder="Resumir as mudanças nesta branch em 3 bullet points."
          className="block w-full resize-none rounded-md border border-border-subtle bg-surface-2 px-3 py-2 text-[13px] text-text placeholder:text-dim/70 focus:border-primary/50 focus:outline-none"
          disabled={isRunning}
        />
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label
            className="flex cursor-pointer items-center gap-2 text-[12.5px] text-text-soft"
            title="Não pede confirmação pra rodar comandos / editar arquivos. Use com cuidado em comandos automatizados."
          >
            <input
              type="checkbox"
              checked={yes}
              onChange={(e) => setYes(e.target.checked)}
              disabled={isRunning}
              className="h-3.5 w-3.5 cursor-pointer accent-primary"
            />
            Auto-aprovar ações
          </label>
          <label
            className="flex cursor-help items-center gap-2 text-[12.5px] text-text-soft"
            title="Quantas etapas (turns) o agente pode executar antes de parar — protege contra loops infinitos."
          >
            Máximo de passos:
            <input
              type="number"
              min={1}
              max={200}
              value={maxTurns}
              onChange={(e) =>
                setMaxTurns(
                  Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 50)),
                )
              }
              disabled={isRunning}
              className="w-16 rounded-md border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text disabled:opacity-60"
            />
          </label>
          <fieldset
            className="flex items-center gap-2 text-[12.5px] text-text-soft"
            title="Texto = saída humana legível. JSON = saída estruturada útil pra outros programas processarem."
          >
            <span>Formato:</span>
            <FormatRadio
              value="text"
              current={format}
              onChange={setFormat}
              disabled={isRunning}
            />
            <FormatRadio
              value="json"
              current={format}
              onChange={setFormat}
              disabled={isRunning}
            />
          </fieldset>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className={clsx(
                'flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] transition-colors',
                historyOpen
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border-subtle bg-surface-2 text-text-soft hover:bg-surface-3',
              )}
              title="Histórico de execuções"
            >
              <History size={12} />
              Histórico ({history.length})
            </button>
            {!isRunning ? (
              <button
                type="button"
                onClick={submit}
                disabled={!prompt.trim() || runMut.isPending}
                className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12.5px] font-medium text-surface-0 transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Play size={12} fill="currentColor" />
                Executar
              </button>
            ) : (
              <button
                type="button"
                onClick={stop}
                disabled={stopMut.isPending}
                className="flex h-8 items-center gap-1.5 rounded-md border border-danger/40 bg-surface-2 px-3 text-[12.5px] font-medium text-danger hover:bg-danger/15 disabled:opacity-60"
              >
                <Square size={11} fill="currentColor" />
                {stopMut.isPending ? 'Parando…' : 'Parar'}
              </button>
            )}
            <button
              type="button"
              onClick={clearOutput}
              disabled={isRunning}
              className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
              title="Limpar output"
            >
              <Trash2 size={12} />
              Limpar
            </button>
          </div>
        </div>
      </section>

      {historyOpen && (
        <HistoryPanel
          history={history}
          onSelect={reloadFromHistory}
          onClear={clearHistory}
          onClose={() => setHistoryOpen(false)}
          disabled={isRunning}
        />
      )}

      {/* Output */}
      <section className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border-subtle bg-surface-1/40 px-6 py-2">
          <RunStateBadge run={run} elapsed={elapsed} />
          <span className="font-mono text-[11px] text-dim-soft">
            {lines.length} {lines.length === 1 ? 'linha' : 'linhas'}
          </span>
        </div>
        <div ref={outputRef} className="flex-1 overflow-auto px-6 py-3">
          {lines.length === 0 && !run && (
            <div className="text-[12.5px] text-dim/70">
              Sem output ainda. Submeta um prompt acima.
            </div>
          )}
          {lines.length === 0 && run && !run.done && (
            <div className="flex items-center gap-2 text-[12.5px] text-dim-soft">
              <Loader2 size={12} className="animate-spin" />
              Aguardando primeira saída…
            </div>
          )}
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">
            {lines.map((l) => (
              <OutputLineView key={l.id} line={l} />
            ))}
          </pre>
        </div>
      </section>
    </div>
  );
}

// ─── Output line ────────────────────────────────────────────────────────

function OutputLineView({ line }: { line: OutputLine }): React.ReactElement {
  const colorClass =
    line.channel === 'error'
      ? 'text-danger'
      : line.channel === 'info'
        ? 'text-dim-soft'
        : line.channel === 'log'
          ? 'text-dim/70'
          : 'text-text';
  const prefix =
    line.channel === 'error'
      ? '[error] '
      : line.channel === 'info'
        ? '[info] '
        : line.channel === 'log'
          ? ''
          : '';
  return (
    <span className={clsx('block', colorClass)}>
      {prefix}
      {line.text}
    </span>
  );
}

// ─── Run state badge ────────────────────────────────────────────────────

function RunStateBadge({
  run,
  elapsed,
}: {
  run: RunState | null;
  elapsed: number;
}): React.ReactElement {
  if (!run) {
    return <span className="text-[12px] text-dim/70">aguardando</span>;
  }
  const tokensSuffix =
    run.tokenEstimate > 0 ? ` · ~${formatTokens(run.tokenEstimate)} tokens` : '';
  if (!run.done) {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-secondary">
        <Loader2 size={11} className="animate-spin" />
        rodando · {formatElapsed(elapsed)}{tokensSuffix}
      </span>
    );
  }
  // done
  const ok = run.exitCode === 0;
  if (ok) {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-success">
        <CheckCircle2 size={11} />
        exit 0 · {formatElapsed(run.durationMs ?? 0)}{tokensSuffix}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-danger">
      <XCircle size={11} />
      exit {run.exitCode} · {formatElapsed(run.durationMs ?? 0)}{tokensSuffix}
      <ExitCodeHint code={run.exitCode} />
    </span>
  );
}

// ─── History panel ──────────────────────────────────────────────────────

function HistoryPanel({
  history,
  onSelect,
  onClear,
  onClose,
  disabled,
}: {
  history: HistoryEntry[];
  onSelect: (entry: HistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <section className="border-b border-border-subtle bg-surface-1/40 px-6 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.1em] text-dim/80">
          Histórico recente
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            disabled={history.length === 0}
            className="text-[11.5px] text-dim-soft transition-colors hover:text-danger disabled:opacity-40 disabled:hover:text-dim-soft"
          >
            Limpar histórico
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-dim-soft transition-colors hover:bg-surface-2 hover:text-text"
            title="Fechar"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {history.length === 0 ? (
        <div className="text-[12px] text-dim/70">
          Sem execuções ainda. Após rodar um prompt, ele aparece aqui pra recarregar.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {history.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onSelect(entry)}
                disabled={disabled}
                className="flex w-full items-center gap-3 rounded-md border border-border-subtle bg-surface-2/40 px-3 py-2 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                title="Recarregar prompt e flags"
              >
                <HistoryStatusDot exitCode={entry.exitCode} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">
                  {entry.prompt.split('\n')[0]}
                </span>
                <span className="font-mono text-[11px] text-dim-soft">
                  {formatElapsed(entry.durationMs)} · ~{formatTokens(entry.tokenEstimate)}t
                </span>
                <span className="font-mono text-[11px] text-dim/70">
                  {formatRelative(entry.ranAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryStatusDot({ exitCode }: { exitCode: number | null }): React.ReactElement {
  const ok = exitCode === 0;
  return (
    <span
      className={clsx(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        ok ? 'bg-success' : 'bg-danger',
      )}
      title={ok ? 'exit 0' : `exit ${exitCode}`}
    />
  );
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m atrás`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h atrás`;
  return `${Math.floor(diff / 86_400_000)}d atrás`;
}

function ExitCodeHint({ code }: { code: number | null }): React.ReactElement | null {
  if (code === null) return null;
  const label =
    code === 1
      ? 'auth/init'
      : code === 2
        ? 'prompt vazio'
        : code === 3
          ? 'context cheio'
          : code === 4
            ? 'circuit breaker'
            : code === 5
              ? 'provider error'
              : null;
  if (!label) return null;
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-danger/15 px-1.5 py-0.5 text-[10.5px] text-danger">
      <AlertTriangle size={9} />
      {label}
    </span>
  );
}

function FormatRadio({
  value,
  current,
  onChange,
  disabled,
}: {
  value: 'text' | 'json';
  current: 'text' | 'json';
  onChange: (v: 'text' | 'json') => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <label className="flex items-center gap-1 cursor-pointer">
      <input
        type="radio"
        checked={current === value}
        onChange={() => onChange(value)}
        disabled={disabled}
        className="h-3 w-3 cursor-pointer accent-primary"
      />
      <span className="font-mono text-[11.5px] text-dim-soft">{value}</span>
    </label>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
