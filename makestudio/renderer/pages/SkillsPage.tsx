import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Plus, Pencil, Trash2, Save, X, Play, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { skillsApi } from '../ipc/client';
import type { SkillDTO, SkillBodyDTO } from '@shared/types';

export function SkillsPage(): React.ReactElement {
  const qc = useQueryClient();
  const listQuery = useQuery<SkillDTO[]>({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
    staleTime: 30_000,
  });
  const [editing, setEditing] = React.useState<{ name: string | null; scope: 'user' | 'project' } | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 3_000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  const deleteMut = useMutation({
    mutationFn: (vars: { scope: 'user' | 'project'; name: string }) => skillsApi.delete(vars.scope, vars.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      toast.success('Skill removida');
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const skills = listQuery.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Skills</h1>
        </div>
        <button
          type="button"
          onClick={() => setEditing({ name: null, scope: 'user' })}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft"
        >
          <Plus size={12} /> Nova skill
        </button>
      </header>

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="overflow-hidden rounded-md border border-border-subtle">
          <table className="w-full">
            <thead className="bg-surface-2">
              <tr>
                <Th>Nome</Th>
                <Th>Descrição</Th>
                <Th className="w-[100px]">Source</Th>
                <Th className="w-[120px] text-right">Ações</Th>
              </tr>
            </thead>
            <tbody>
              {skills.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-[12px] text-dim/70">Nenhuma skill</td>
                </tr>
              )}
              {skills.map((s) => {
                const editable = s.source !== 'bundled';
                return (
                  <tr key={s.id} className="border-t border-border-subtle">
                    <Td><span className="font-mono text-[12px] text-text">/{s.name}</span></Td>
                    <Td><span className="text-[11.5px] text-text-soft">{s.description ?? '—'}</span></Td>
                    <Td>
                      <span className={clsx(
                        'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em]',
                        s.source === 'bundled' && 'bg-secondary/15 text-secondary',
                        s.source === 'user' && 'bg-success/15 text-success',
                        s.source === 'project' && 'bg-warning/15 text-warning',
                      )}>{s.source}</span>
                    </Td>
                    <Td className="text-right">
                      {editable && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing({ name: s.name, scope: s.source as 'user' | 'project' })}
                            className="rounded p-1 text-dim-soft hover:bg-surface-3 hover:text-text"
                            title="Editar"
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (pendingDelete === s.name) {
                                deleteMut.mutate({ scope: s.source as 'user' | 'project', name: s.name });
                                setPendingDelete(null);
                              } else {
                                setPendingDelete(s.name);
                              }
                            }}
                            disabled={deleteMut.isPending}
                            className={clsx(
                              'rounded p-1 disabled:opacity-50',
                              pendingDelete === s.name
                                ? 'bg-danger/20 text-danger'
                                : 'text-dim-soft hover:bg-surface-3 hover:text-danger',
                            )}
                            title={pendingDelete === s.name ? 'Clique de novo para confirmar' : 'Remover'}
                          >
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
        {editing && <SkillEditor key={`${editing.scope}:${editing.name}`} editingName={editing.name} initialScope={editing.scope} onClose={() => setEditing(null)} />}
      </div>
    </div>
  );
}

function SkillEditor({
  editingName,
  initialScope,
  onClose,
}: {
  editingName: string | null;
  initialScope: 'user' | 'project';
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const bodyQuery = useQuery<SkillBodyDTO | null>({
    queryKey: ['skills', 'body', editingName],
    queryFn: () => (editingName ? skillsApi.get(editingName) : Promise.resolve(null)),
    enabled: editingName !== null,
    staleTime: 0,
  });

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [body, setBody] = React.useState('');
  const [argsCsv, setArgsCsv] = React.useState('');
  const [whenToUse, setWhenToUse] = React.useState('');
  const [scope, setScope] = React.useState<'user' | 'project'>(initialScope);

  React.useEffect(() => {
    const d = bodyQuery.data;
    if (editingName === null) {
      setName(''); setDescription(''); setBody(''); setArgsCsv(''); setWhenToUse('');
      return;
    }
    if (d) {
      setName(d.name);
      setDescription(d.description);
      setBody(d.body ?? '');
      setArgsCsv((d.args ?? []).join(', '));
      setWhenToUse(d.whenToUse ?? '');
      if (d.source === 'project') setScope('project');
      else if (d.source === 'user') setScope('user');
    }
  }, [editingName, bodyQuery.data]);

  const saveMut = useMutation({
    mutationFn: () => skillsApi.save({
      scope,
      skill: {
        name: name.trim(),
        description: description.trim(),
        body,
        args: argsCsv.split(',').map((s) => s.trim()).filter(Boolean),
        whenToUse: whenToUse.trim() || undefined,
      },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      toast.success('Skill salva');
      onClose();
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const runMut = useMutation({
    mutationFn: () => skillsApi.run(name.trim(), argsCsv),
    onSuccess: (r) => {
      if (r.ok) toast.success('Skill expandida — preview no console do dev tools');
      else toast.error(r.error ?? 'Falha');
      // eslint-disable-next-line no-console
      if (r.expanded) console.log('[skill expanded]\n' + r.expanded);
    },
  });

  return (
    <div className="mt-4 rounded-md border-2 border-primary/40 bg-surface-2/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-text">{editingName ? `Editando "${editingName}"` : 'Nova skill'}</h3>
        {bodyQuery.isLoading && <Loader2 size={14} className="animate-spin text-dim-soft" />}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_140px]">
        <Field label="Nome (slug)">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={editingName !== null}
            placeholder="deploy-staging"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60"
          />
        </Field>
        <Field label="Descrição">
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[12px] text-text outline-none focus:border-primary" />
        </Field>
        <Field label="Scope">
          <select value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'project')}
            disabled={editingName !== null}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary disabled:opacity-60">
            <option value="user">user</option>
            <option value="project">project</option>
          </select>
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Args (CSV)">
          <input value={argsCsv} onChange={(e) => setArgsCsv(e.target.value)} placeholder="environment, version"
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary" />
        </Field>
        <Field label="When to use (LLM-facing)">
          <input value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)}
            className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[11.5px] text-text outline-none focus:border-primary" />
        </Field>
      </div>
      <Field label="Body (Markdown — corpo do prompt)" className="mt-3">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12}
          placeholder="Deploy the backend to {{environment}}…"
          className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
      </Field>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={() => runMut.mutate()} disabled={!name.trim() || runMut.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3 disabled:opacity-60">
          {runMut.isPending ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          Test (expand)
        </button>
        <button type="button" onClick={onClose}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3">
          <X size={12} /> Cancelar
        </button>
        <button type="button" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
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
