import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bug,
  RefreshCw,
  Search,
  Play,
  Pause,
  X,
  Copy,
  ChevronDown,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { debugLogsApi } from '../ipc/client';
import type {
  DebugLogEntryDTO,
  DebugLogSessionDTO,
} from '@shared/types';

// Categorias agrupadas pra UI — mantém os chips compactos. As listas
// reflectem os tipos de evento emitidos por debug-log.ts.
const TYPE_GROUPS: Array<{ label: string; types: string[] }> = [
  { label: 'tool', types: ['tool_call', 'tool_result'] },
  { label: 'bash', types: ['bash_start', 'bash_stdout', 'bash_stderr', 'bash_end'] },
  { label: 'llm', types: ['llm_request', 'llm_chunk', 'llm_response'] },
  { label: 'permission', types: ['permission_prompt', 'permission_choice'] },
  { label: 'session', types: ['session_start', 'session_end'] },
  { label: 'log', types: ['info', 'warn', 'error'] },
];

const TYPE_BADGE: Record<string, string> = {
  tool_call: 'bg-primary/15 text-primary',
  tool_result: 'bg-primary/15 text-primary',
  bash_start: 'bg-success/15 text-success',
  bash_stdout: 'bg-success/15 text-success',
  bash_stderr: 'bg-warning/15 text-warning',
  bash_end: 'bg-success/15 text-success',
  llm_request: 'bg-secondary/15 text-secondary',
  llm_chunk: 'bg-secondary/15 text-secondary',
  llm_response: 'bg-secondary/15 text-secondary',
  permission_prompt: 'bg-warning/15 text-warning',
  permission_choice: 'bg-warning/15 text-warning',
  session_start: 'bg-accent/15 text-accent',
  session_end: 'bg-accent/15 text-accent',
  info: 'bg-surface-3 text-dim-soft',
  warn: 'bg-warning/15 text-warning',
  error: 'bg-danger/15 text-danger',
};

const TAIL_BUFFER_MAX = 5_000;

export function DebugLogsPage(): React.ReactElement {
  const qc = useQueryClient();

  const sessionsQuery = useQuery<DebugLogSessionDTO[]>({
    queryKey: ['debug', 'sessions'],
    queryFn: () => debugLogsApi.listSessions(),
    staleTime: 5_000,
  });

  const sessions = sessionsQuery.data ?? [];
  const currentSession = sessions.find((s) => s.isCurrent) ?? sessions[0] ?? null;
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!selectedSessionId && currentSession) setSelectedSessionId(currentSession.sessionId);
  }, [currentSession, selectedSessionId]);

  const [activeTypes, setActiveTypes] = React.useState<Set<string>>(new Set());
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const tailQuery = useQuery<DebugLogEntryDTO[]>({
    queryKey: ['debug', 'tail', selectedSessionId, Array.from(activeTypes).sort().join(','), debouncedSearch],
    queryFn: () =>
      debugLogsApi.tail({
        sessionId: selectedSessionId ?? undefined,
        limit: 1_000,
        types: activeTypes.size > 0 ? Array.from(activeTypes) : undefined,
        search: debouncedSearch || undefined,
      }),
    enabled: !!selectedSessionId,
    staleTime: 5_000,
  });

  // ── Tail mode ─────────────────────────────────────────────────────────
  const [tailMode, setTailMode] = React.useState(false);
  const [followId, setFollowId] = React.useState<string | null>(null);
  const [streamedEntries, setStreamedEntries] = React.useState<DebugLogEntryDTO[]>([]);

  React.useEffect(() => {
    if (!tailMode || !selectedSessionId) return;
    let cancelled = false;
    let myFollowId: string | null = null;

    void (async () => {
      try {
        const r = await debugLogsApi.followStart({
          sessionId: selectedSessionId,
          types: activeTypes.size > 0 ? Array.from(activeTypes) : undefined,
        });
        if (cancelled) {
          await debugLogsApi.followStop(r.followId).catch(() => {});
          return;
        }
        myFollowId = r.followId;
        setFollowId(r.followId);
      } catch (e: any) {
        toast.error(`Tail falhou: ${e?.message ?? e}`);
        setTailMode(false);
      }
    })();

    const off = debugLogsApi.onLine((ev) => {
      if (!myFollowId || ev.followId !== myFollowId) return;
      // Honor active filters (server already applied `types`, but
      // `search` is renderer-side).
      if (debouncedSearch) {
        const needle = debouncedSearch.toLowerCase();
        const hay = `${ev.entry.type} ${JSON.stringify(ev.entry.payload)}`.toLowerCase();
        if (!hay.includes(needle)) return;
      }
      setStreamedEntries((prev) => {
        const next = [...prev, ev.entry];
        return next.length > TAIL_BUFFER_MAX ? next.slice(next.length - TAIL_BUFFER_MAX) : next;
      });
    });

    return () => {
      cancelled = true;
      off();
      if (myFollowId) {
        void debugLogsApi.followStop(myFollowId).catch(() => {});
      }
      setFollowId(null);
    };
  }, [tailMode, selectedSessionId, Array.from(activeTypes).sort().join(','), debouncedSearch]);

  // Combined entries: snapshot from query + streamed-new appended.
  const baseEntries = tailQuery.data ?? [];
  const allEntries = React.useMemo(() => {
    if (!tailMode || streamedEntries.length === 0) return baseEntries;
    // Avoid duplicating entries that are already in the base — match by ts+type.
    const seen = new Set(baseEntries.map((e) => `${e.ts}|${e.type}`));
    const fresh = streamedEntries.filter((e) => !seen.has(`${e.ts}|${e.type}`));
    return [...baseEntries, ...fresh];
  }, [baseEntries, streamedEntries, tailMode]);

  // ── Selection / detail ────────────────────────────────────────────────
  const [selectedIdx, setSelectedIdx] = React.useState<number | null>(null);
  const selected = selectedIdx !== null ? allEntries[selectedIdx] : null;

  // ── Helpers ───────────────────────────────────────────────────────────
  const toggleType = (type: string): void => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
    setSelectedIdx(null);
  };
  const toggleGroup = (group: { label: string; types: string[] }): void => {
    setActiveTypes((prev) => {
      const allActive = group.types.every((t) => prev.has(t));
      const next = new Set(prev);
      if (allActive) {
        for (const t of group.types) next.delete(t);
      } else {
        for (const t of group.types) next.add(t);
      }
      return next;
    });
    setSelectedIdx(null);
  };
  const clearStreamed = (): void => setStreamedEntries([]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Bug size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Debug logs</h1>
        </div>
        <div className="flex items-center gap-2">
          <SessionDropdown
            sessions={sessions}
            value={selectedSessionId}
            onChange={(id) => {
              setSelectedSessionId(id);
              setSelectedIdx(null);
              setStreamedEntries([]);
            }}
          />
          <button
            type="button"
            onClick={() => setTailMode((t) => !t)}
            disabled={!selectedSessionId}
            className={clsx(
              'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] disabled:opacity-60',
              tailMode
                ? 'border-success/40 bg-success/15 text-success'
                : 'border-border-subtle bg-surface-2 text-text-soft hover:bg-surface-3',
            )}
          >
            {tailMode ? <Pause size={11} /> : <Play size={11} fill="currentColor" />}
            {tailMode ? 'Tail ON' : 'Tail OFF'}
            {tailMode && followId && <span className="ml-1 h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
          </button>
          <button
            type="button"
            onClick={() => qc.invalidateQueries({ queryKey: ['debug'] })}
            disabled={tailQuery.isFetching}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
          >
            <RefreshCw size={12} className={tailQuery.isFetching ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-1/40 px-6 py-2">
        {TYPE_GROUPS.map((g) => {
          const allActive = g.types.every((t) => activeTypes.has(t));
          const someActive = g.types.some((t) => activeTypes.has(t));
          return (
            <button
              key={g.label}
              type="button"
              onClick={() => toggleGroup(g)}
              className={clsx(
                'rounded-md border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.05em] transition-colors',
                allActive
                  ? 'border-primary/60 bg-primary/15 text-primary'
                  : someActive
                    ? 'border-primary/30 bg-surface-2 text-text-soft'
                    : 'border-border-subtle bg-surface-2 text-dim-soft hover:bg-surface-3',
              )}
              title={`Types: ${g.types.join(', ')}`}
            >
              {g.label}{someActive && ` ·${g.types.filter((t) => activeTypes.has(t)).length}/${g.types.length}`}
            </button>
          );
        })}
        <div className="ml-2 flex items-center gap-1.5 rounded border border-border-subtle bg-surface-2 px-2">
          <Search size={11} className="text-dim-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="busca em type + payload"
            className="w-[220px] bg-transparent py-1 text-[11.5px] text-text outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="text-dim-soft hover:text-text"
              title="Limpar"
            >
              <X size={11} />
            </button>
          )}
        </div>
        {streamedEntries.length > 0 && (
          <button
            type="button"
            onClick={clearStreamed}
            className="ml-auto rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[10.5px] text-dim-soft hover:bg-surface-3"
            title="Limpa só o buffer de streaming — não apaga arquivo"
          >
            Limpar tail
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <EntryList
          entries={allEntries}
          selectedIdx={selectedIdx}
          onSelect={setSelectedIdx}
          isLoading={tailQuery.isLoading}
        />
        <EntryDetail entry={selected} />
      </div>
    </div>
  );
}

// ── Components ─────────────────────────────────────────────────────────

function SessionDropdown({
  sessions,
  value,
  onChange,
}: {
  sessions: DebugLogSessionDTO[];
  value: string | null;
  onChange: (id: string | null) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const current = sessions.find((s) => s.sessionId === value);
  const label = current
    ? `${current.sessionId.slice(0, 12)}${current.isCurrent ? ' (atual)' : ''}`
    : 'Sem sessão';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3"
      >
        <span className="font-mono">{label}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 max-h-[400px] w-[400px] overflow-auto rounded-md border border-border-subtle bg-surface-1 shadow-lg">
          {sessions.length === 0 && (
            <div className="px-3 py-3 text-center text-[12px] text-dim/70">
              Nenhuma sessão.
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => { onChange(s.sessionId); setOpen(false); }}
              className={clsx(
                'block w-full border-b border-border-subtle px-3 py-2 text-left last:border-b-0 transition-colors',
                s.sessionId === value
                  ? 'bg-primary/10'
                  : 'hover:bg-surface-2',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] text-text">{s.sessionId.slice(0, 16)}</span>
                {s.isCurrent && (
                  <span className="rounded bg-success/15 px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.05em] text-success">
                    atual
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-dim-soft">
                <span>{new Date(s.startedAt).toLocaleString()}</span>
                <span className="font-mono">
                  {s.eventCount.toLocaleString()} ev · {(s.sizeBytes / 1024).toFixed(1)}KB
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EntryList({
  entries,
  selectedIdx,
  onSelect,
  isLoading,
}: {
  entries: DebugLogEntryDTO[];
  selectedIdx: number | null;
  onSelect: (idx: number) => void;
  isLoading: boolean;
}): React.ReactElement {
  // Renderizamos manualmente (sem virtualização) — limite de 5k linhas é
  // tolerável; o ganho de complexidade da virtualização não compensa pra
  // esta página. Se passar a ficar lerda, swap pra @tanstack/react-virtual.
  const ref = React.useRef<HTMLDivElement>(null);
  // Auto-scroll quando uma nova linha entra (tail mode).
  const lastCount = React.useRef(0);
  React.useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (entries.length > lastCount.current && wasAtBottom) {
      el.scrollTop = el.scrollHeight;
    }
    lastCount.current = entries.length;
  }, [entries.length]);

  return (
    <div ref={ref} className="flex-1 overflow-auto border-r border-border-subtle bg-surface-1/40">
      {isLoading && entries.length === 0 && (
        <div className="px-4 py-8 text-center text-[12px] text-dim/70">Carregando…</div>
      )}
      {!isLoading && entries.length === 0 && (
        <div className="px-4 py-8 text-center text-[12px] text-dim/70">
          Nenhum evento — relaxe os filtros.
        </div>
      )}
      <table className="w-full">
        <tbody>
          {entries.map((e, i) => (
            <tr
              key={`${e.ts}-${i}`}
              onClick={() => onSelect(i)}
              className={clsx(
                'cursor-pointer border-b border-border-subtle/50 transition-colors',
                selectedIdx === i ? 'bg-primary/10' : 'hover:bg-surface-2',
              )}
            >
              <td className="w-[80px] px-3 py-1 font-mono text-[10.5px] text-dim-soft">
                {e.ts.slice(11, 19)}
              </td>
              <td className="w-[140px] px-2 py-1">
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em]',
                    TYPE_BADGE[e.type] ?? 'bg-surface-3 text-dim-soft',
                  )}
                >
                  {e.type}
                </span>
              </td>
              <td className="px-2 py-1">
                <span className="line-clamp-1 font-mono text-[11px] text-text-soft">
                  {summarizeEntry(e)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntryDetail({ entry }: { entry: DebugLogEntryDTO | null }): React.ReactElement {
  if (!entry) {
    return (
      <div className="flex w-[40%] min-w-[320px] items-center justify-center bg-surface-1/20 text-[12px] text-dim/70">
        Selecione um evento pra ver detalhes.
      </div>
    );
  }
  const json = JSON.stringify(
    { ts: entry.ts, type: entry.type, sessionId: entry.sessionId, ...entry.payload },
    null,
    2,
  );
  const onCopy = (): void => {
    void navigator.clipboard.writeText(json).then(
      () => toast.success('Copiado'),
      () => toast.error('Falha ao copiar'),
    );
  };
  return (
    <div className="flex w-[40%] min-w-[320px] flex-col bg-surface-1/30">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em]',
              TYPE_BADGE[entry.type] ?? 'bg-surface-3 text-dim-soft',
            )}
          >
            {entry.type}
          </span>
          <span className="font-mono text-[11px] text-dim-soft">{entry.ts}</span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded border border-border-subtle bg-surface-2 px-2 py-0.5 text-[10.5px] text-text-soft hover:bg-surface-3"
        >
          <Copy size={10} />
          Copiar JSON
        </button>
      </div>
      <pre className="flex-1 overflow-auto px-3 py-2 font-mono text-[11px] text-text">
        {json}
      </pre>
    </div>
  );
}

function summarizeEntry(e: DebugLogEntryDTO): string {
  const p = e.payload;
  switch (e.type) {
    case 'tool_call':   return `${p.tool ?? '?'} · ${formatPreview(p.input)}`;
    case 'tool_result': return `${p.tool ?? '?'} · ${p.durationMs ?? 0}ms · out=${p.outputLen ?? 0}b`;
    case 'bash_start':  return `${p.cmd ?? '?'}`;
    case 'bash_stdout': return `[stdout] ${formatPreview(p.chunk)}`;
    case 'bash_stderr': return `[stderr] ${formatPreview(p.chunk)}`;
    case 'bash_end':    return `exit=${p.exitCode ?? '?'} · ${p.durationMs ?? 0}ms`;
    case 'llm_request': return `${p.model ?? '?'} · ${p.msgCount ?? 0} msgs · sys=${p.systemLen ?? 0}b`;
    case 'llm_response':return `${p.model ?? '?'} · out=${p.tokensOut ?? 0}t · ${p.durationMs ?? 0}ms`;
    case 'permission_prompt': return `${p.toolName ?? '?'} · ${formatPreview(p.preview)}`;
    case 'permission_choice': return `${p.toolName ?? '?'} → ${p.choice ?? '?'}`;
    case 'session_start': return `pid=${p.pid ?? '?'}`;
    case 'session_end':   return '—';
    case 'info':
    case 'warn':
    case 'error': return String(p.msg ?? '');
    default: return formatPreview(p);
  }
}

function formatPreview(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.slice(0, 160);
  try {
    return JSON.stringify(v).slice(0, 160);
  } catch {
    return String(v).slice(0, 160);
  }
}
