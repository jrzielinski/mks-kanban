import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, Pencil, Trash2, Save, X, Loader2, Clock } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { customAgentsApi } from '../ipc/client';
import type { CustomAgentDTO, CustomAgentBodyDTO, DispatchHistoryEntryDTO } from '@shared/types';

export function CustomAgentsPage(): React.ReactElement {
  const qc = useQueryClient();
  const listQuery = useQuery<CustomAgentDTO[]>({
    queryKey: ['agents'],
    queryFn: () => customAgentsApi.list(),
    staleTime: 30_000,
  });
  const historyQuery = useQuery<DispatchHistoryEntryDTO[]>({
    queryKey: ['agents', 'history'],
    queryFn: () => customAgentsApi.history(),
    staleTime: 30_000,
  });

  const [editing, setEditing] = React.useState<{ name: string | null; scope: 'user' | 'project' } | null>(null);
  const [tab, setTab] = React.useState<'agents' | 'history'>('agents');
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 3_000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  const deleteMut = useMutation({
    mutationFn: (vars: { scope: 'user' | 'project'; name: string }) => customAgentsApi.delete(vars.scope, vars.name),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); toast.success('Agent removido'); },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const agents = listQuery.data ?? [];
  const history = historyQuery.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Custom agents</h1>
        </div>
        <button type="button" onClick={() => setEditing({ name: null, scope: 'user' })}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft">
          <Plus size={12} /> Novo agent
        </button>
      </header>

      <nav className="flex items-center gap-1 border-b border-border-subtle bg-surface-1/40 px-6 py-2">
        <TabBtn label="Agents" active={tab === 'agents'} onClick={() => setTab('agents')} />
        <TabBtn label={`History (${history.length})`} active={tab === 'history'} onClick={() => setTab('history')} />
      </nav>

      <div className="flex-1 overflow-auto px-6 py-5">
        {tab === 'agents' ? (
          <>
            <div className="overflow-hidden rounded-md border border-border-subtle">
              <table className="w-full">
                <thead className="bg-surface-2">
                  <tr>
                    <Th>Nome</Th>
                    <Th>Descrição</Th>
                    <Th className="w-[120px]">Source</Th>
                    <Th className="w-[100px]">Tools</Th>
                    <Th className="w-[120px] text-right">Ações</Th>
                  </tr>
                </thead>
                <tbody>
                  {agents.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-[12px] text-dim/70">Nenhum agent</td></tr>
                  )}
                  {agents.map((a) => {
                    const isBuiltin = a.id.startsWith('builtin:');
                    // Agents de ~/.claude/agents/ ou <cwd>/.claude/agents/
                    // são compartilhados com Claude Code — nosso saveCustomAgent
                    // só conhece os paths em .makestudio/agents/, então editar
                    // criaria duplicado em vez de overwrite. UX: read-only + dica.
                    const isClaudeShared = a.source === 'claude-user' || a.source === 'claude-project';
                    const editable = !isBuiltin && !isClaudeShared;
                    return (
                      <tr key={a.id} className="border-t border-border-subtle">
                        <Td><span className="font-mono text-[12px] text-text">{a.name}</span></Td>
                        <Td><span className="text-[11.5px] text-text-soft line-clamp-1">{a.description ?? '—'}</span></Td>
                        <Td>
                          <span className={clsx(
                            'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em]',
                            isBuiltin && 'bg-secondary/15 text-secondary',
                            a.source === 'user' && 'bg-success/15 text-success',
                            a.source === 'project' && 'bg-warning/15 text-warning',
                            a.source.startsWith('claude-') && 'bg-primary/15 text-primary',
                          )}>{isBuiltin ? 'builtin' : a.source}</span>
                        </Td>
                        <Td><span className="text-[10.5px] text-dim-soft">{a.tools?.length ?? 0}</span></Td>
                        <Td className="text-right">
                          {editable && (
                            <div className="flex items-center justify-end gap-1">
                              <button type="button"
                                onClick={() => setEditing({ name: a.name, scope: a.source as 'user' | 'project' })}
                                className="rounded p-1 text-dim-soft hover:bg-surface-3 hover:text-text" title="Editar">
                                <Pencil size={11} />
                              </button>
                              <button type="button"
                                onClick={() => {
                                  if (pendingDelete === a.name) {
                                    deleteMut.mutate({ scope: a.source as 'user' | 'project', name: a.name });
                                    setPendingDelete(null);
                                  } else setPendingDelete(a.name);
                                }}
                                disabled={deleteMut.isPending}
                                className={clsx('rounded p-1 disabled:opacity-50',
                                  pendingDelete === a.name ? 'bg-danger/20 text-danger' : 'text-dim-soft hover:bg-surface-3 hover:text-danger')}
                                title={pendingDelete === a.name ? 'Clique de novo para confirmar' : 'Remover'}>
                                <Trash2 size={11} />
                              </button>
                            </div>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {editing && <AgentEditor key={`${editing.scope}:${editing.name}`} editingName={editing.name} initialScope={editing.scope} onClose={() => setEditing(null)} />}
          </>
        ) : (
          <DispatchHistory entries={history} />
        )}
      </div>
    </div>
  );
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button type="button" onClick={onClick}
      className={clsx('rounded-md px-3 py-1 font-mono text-[12px] transition-colors',
        active ? 'bg-primary/15 text-primary' : 'text-text-soft hover:bg-surface-2 hover:text-text')}>
      {label}
    </button>
  );
}

function DispatchHistory({ entries }: { entries: DispatchHistoryEntryDTO[] }): React.ReactElement {
  if (entries.length === 0) {
    return <div className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-[12px] text-dim/70">Nenhum dispatch persistido.</div>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <table className="w-full">
        <thead className="bg-surface-2">
          <tr>
            <Th>Subagent</Th>
            <Th>Description</Th>
            <Th className="w-[100px]">Msgs</Th>
            <Th className="w-[100px]">Tokens</Th>
            <Th className="w-[140px]">Updated</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-border-subtle">
              <Td><span className="font-mono text-[12px] text-text">{e.subagentType}</span></Td>
              <Td><span className="text-[11.5px] text-text-soft line-clamp-1">{e.description ?? '—'}</span></Td>
              <Td><span className="font-mono text-[11px] text-dim-soft">{e.messageCount}</span></Td>
              <Td><span className="font-mono text-[11px] text-warning">{e.totalTokens.toLocaleString()}</span></Td>
              <Td><span className="flex items-center gap-1 font-mono text-[10.5px] text-dim/80"><Clock size={10} />{new Date(e.updatedAt).toLocaleString()}</span></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentEditor({
  editingName,
  initialScope,
  onClose,
}: {
  editingName: string | null;
  initialScope: 'user' | 'project';
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const bodyQuery = useQuery<CustomAgentBodyDTO | null>({
    queryKey: ['agents', 'body', editingName],
    queryFn: () => (editingName ? customAgentsApi.get(editingName) : Promise.resolve(null)),
    enabled: editingName !== null,
    staleTime: 0,
  });

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [toolsCsv, setToolsCsv] = React.useState('');
  const [model, setModel] = React.useState('');
  const [maxTurns, setMaxTurns] = React.useState('');
  const [memory, setMemory] = React.useState<'project' | 'user' | 'none'>('none');
  const [scope, setScope] = React.useState<'user' | 'project'>(initialScope);

  React.useEffect(() => {
    const d = bodyQuery.data;
    if (editingName === null) {
      setName(''); setDescription(''); setPrompt(''); setToolsCsv(''); setModel(''); setMaxTurns(''); setMemory('none');
      return;
    }
    if (d) {
      setName(d.name);
      setDescription(d.description);
      setPrompt(d.prompt);
      setToolsCsv((d.tools ?? []).join(', '));
      setModel(d.model ?? '');
      setMaxTurns(typeof d.maxTurns === 'number' ? String(d.maxTurns) : '');
      setMemory(d.memory);
      if (d.source === 'project') setScope('project');
      else setScope('user');
    }
  }, [editingName, bodyQuery.data]);

  const saveMut = useMutation({
    mutationFn: () => customAgentsApi.save({
      scope,
      agent: {
        name: name.trim(),
        description: description.trim(),
        prompt,
        tools: toolsCsv.split(',').map((s) => s.trim()).filter(Boolean),
        model: model.trim() || undefined,
        maxTurns: maxTurns.trim() ? Number(maxTurns) : undefined,
        memory,
      },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Agent salvo');
      onClose();
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const readOnly = bodyQuery.data?.readOnly === true;

  return (
    <div className="mt-4 rounded-md border-2 border-primary/40 bg-surface-2/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-text">{editingName ? `Editando "${editingName}"` : 'Novo agent'}</h3>
        {bodyQuery.isLoading && <Loader2 size={14} className="animate-spin text-dim-soft" />}
      </div>
      {readOnly && (
        <div className="mb-3 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11.5px] text-warning">
          Built-in — read-only. System prompt vive em subagent-config.ts.
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_140px]">
        <Field label="Nome">
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={editingName !== null}
            placeholder="api-reviewer"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60" />
        </Field>
        <Field label="Descrição">
          <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[12px] text-text outline-none focus:border-primary disabled:opacity-60" />
        </Field>
        <Field label="Scope">
          <select value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'project')}
            disabled={editingName !== null || readOnly}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60">
            <option value="user">user</option>
            <option value="project">project</option>
          </select>
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[2fr_120px_120px_140px]">
        <Field label="Tools whitelist (CSV)">
          <input value={toolsCsv} onChange={(e) => setToolsCsv(e.target.value)} disabled={readOnly}
            placeholder="Read, Glob, Grep"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary disabled:opacity-60" />
        </Field>
        <Field label="Model">
          <input value={model} onChange={(e) => setModel(e.target.value)} disabled={readOnly}
            placeholder="fast / primary"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary disabled:opacity-60" />
        </Field>
        <Field label="Max turns">
          <input type="number" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} disabled={readOnly}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary disabled:opacity-60" />
        </Field>
        <Field label="Memory">
          <select value={memory} onChange={(e) => setMemory(e.target.value as any)} disabled={readOnly}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary disabled:opacity-60">
            <option value="none">none</option>
            <option value="project">project</option>
            <option value="user">user</option>
          </select>
        </Field>
      </div>
      <Field label="System prompt (Markdown)" className="mt-3">
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={readOnly} rows={14}
          className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60" />
      </Field>
      {bodyQuery.data?.filePath && (
        <div className="mt-2 text-[11px] text-dim/70">
          Arquivo: <code className="text-accent">{bodyQuery.data.filePath}</code>
        </div>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3">
          <X size={12} /> Cancelar
        </button>
        <button type="button" onClick={() => saveMut.mutate()} disabled={saveMut.isPending || readOnly}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60">
          <Save size={12} /> {saveMut.isPending ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className={clsx('flex flex-col gap-1', className)}>
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">{label}</span>
      {children}
    </label>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }): React.ReactElement {
  return <th className={clsx('px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80', className)}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }): React.ReactElement {
  return <td className={clsx('px-3 py-2 align-middle', className)}>{children}</td>;
}
