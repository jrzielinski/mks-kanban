import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  GitBranch, RefreshCw, GitCommit, GitPullRequest, Plus, ChevronDown,
  ArrowUp, ArrowDown, FileText, Wand2, Send, ExternalLink,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { gitApi, prApi } from '../ipc/client';
import type { GitStatusDTO, GitFileChangeDTO, GitDiffDTO, PullRequestDTO, PRCreateRequestDTO } from '@shared/types';

const FILE_STATUS_COLOR: Record<string, string> = {
  M: 'text-warning',
  A: 'text-success',
  D: 'text-error',
  R: 'text-primary',
  '?': 'text-dim',
  U: 'text-error',
};

function FileBadge({ f }: { f: GitFileChangeDTO }) {
  return (
    <div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-surface-3 cursor-pointer group">
      <span className={clsx('font-mono text-[10px] font-bold w-3 shrink-0', FILE_STATUS_COLOR[f.status] ?? 'text-dim')}>
        {f.status}
      </span>
      <span className="font-mono text-[11px] text-text truncate">{f.path}</span>
      {f.staged && <span className="ml-auto text-[9px] rounded bg-primary/10 px-1 text-primary">staged</span>}
    </div>
  );
}

function PRRow({ pr, onSelect }: { pr: PullRequestDTO; onSelect: (pr: PullRequestDTO) => void }) {
  const stateColor = pr.state === 'OPEN' ? 'text-success' : pr.mergedAt ? 'text-primary' : 'text-dim';
  return (
    <tr className="border-t border-border-subtle hover:bg-surface-2/50 cursor-pointer" onClick={() => onSelect(pr)}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={clsx('text-[10px] font-medium', stateColor)}>{pr.state}</span>
          <span className="text-[12px] text-text">{pr.title}</span>
          {pr.draft && <span className="rounded bg-dim/20 px-1 text-[9px] text-dim">draft</span>}
        </div>
        {pr.headRef && <span className="text-[10px] text-dim">← {pr.headRef}</span>}
      </td>
      <td className="px-4 py-3 text-[11px] text-dim">#{pr.number}</td>
      <td className="px-4 py-3 text-[11px] text-dim">{pr.author}</td>
      <td className="px-4 py-3 text-right">
        <a href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-[11px] text-dim hover:text-primary ml-auto w-fit">
          <ExternalLink size={10} />
        </a>
      </td>
    </tr>
  );
}

function PRDetailModal({ pr, onClose }: { pr: PullRequestDTO; onClose: () => void }) {
  const commentsQ = useQuery({
    queryKey: ['pr-comments', pr.number],
    queryFn: () => prApi.comments(pr.number),
    staleTime: 60_000,
  });
  const comments = commentsQ.data?.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[600px] max-h-[80vh] flex flex-col rounded-xl border border-border-subtle bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <span className="text-[11px] text-dim">#{pr.number} · {pr.state}</span>
            <h2 className="text-[14px] font-semibold text-text">{pr.title}</h2>
          </div>
          <button type="button" onClick={onClose} className="text-dim hover:text-text text-[18px]">×</button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">
          {pr.body && <p className="text-[12px] text-text-soft mb-4 whitespace-pre-wrap">{pr.body}</p>}
          {comments.length > 0 && (
            <div className="flex flex-col gap-3">
              <span className="text-[11px] font-medium text-text-soft">Review Comments ({comments.length})</span>
              {comments.map((c, i) => (
                <div key={i} className="rounded-md border border-border-subtle bg-surface-2 p-3">
                  {c.path && <span className="font-mono text-[10px] text-dim block">{c.path}{c.line ? `:${c.line}` : ''}</span>}
                  <p className="text-[12px] text-text mt-1">{c.body}</p>
                  <span className="text-[10px] text-dim">{c.author}</span>
                </div>
              ))}
            </div>
          )}
          {comments.length === 0 && !commentsQ.isFetching && <p className="text-[12px] text-dim">Sem comentários de review</p>}
        </div>
      </div>
    </div>
  );
}

function CreatePRModal({ onClose, onCreated }: { onClose: () => void; onCreated: (pr: PullRequestDTO) => void }) {
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [base, setBase] = React.useState('develop');
  const [draft, setDraft] = React.useState(false);

  const mut = useMutation({
    mutationFn: () => prApi.create({ title: title.trim(), body: body.trim(), base: base.trim(), draft }),
    onSuccess: (res) => {
      if (res.ok && res.data) { toast.success('PR criado'); onCreated(res.data); onClose(); }
      else toast.error(res.error ?? 'Falha ao criar PR');
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] rounded-xl border border-border-subtle bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2">
            <GitPullRequest size={14} className="text-primary" />
            <span className="text-[14px] font-semibold text-text">Criar Pull Request</span>
          </div>
          <button type="button" onClick={onClose} className="text-dim hover:text-text text-[18px]">×</button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-soft">Título <span className="text-error">*</span></label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-soft">Descrição</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={4}
              className="rounded-md border border-border-subtle bg-surface-2 px-3 py-2 text-[12px] text-text outline-none focus:border-primary resize-none" />
          </div>
          <div className="flex gap-4">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-[11px] font-medium text-text-soft">Base branch</label>
              <input value={base} onChange={e => setBase(e.target.value)}
                className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
            </div>
            <div className="flex items-end gap-2 pb-1.5">
              <label className="flex items-center gap-1.5 text-[11px] text-text-soft cursor-pointer">
                <input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} className="rounded" />
                Draft
              </label>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-soft hover:text-text">Cancelar</button>
          <button type="button" onClick={() => mut.mutate()} disabled={!title.trim() || mut.isPending}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-50">
            {mut.isPending ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Criar PR
          </button>
        </div>
      </div>
    </div>
  );
}

export function GitPage(): React.ReactElement {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = React.useState<'status' | 'prs'>('status');
  const [selectedFile, setSelectedFile] = React.useState<string | null>(null);
  const [commitMsg, setCommitMsg] = React.useState('');
  const [prState, setPrState] = React.useState<'open' | 'closed' | 'all'>('open');
  const [selectedPr, setSelectedPr] = React.useState<PullRequestDTO | null>(null);
  const [showCreatePr, setShowCreatePr] = React.useState(false);
  const [pendingCpp, setPendingCpp] = React.useState(false);
  const [cppBase, setCppBase] = React.useState('develop');

  const statusQ = useQuery<GitStatusDTO>({
    queryKey: ['git-status'],
    queryFn: () => gitApi.status(),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const diffQ = useQuery<GitDiffDTO>({
    queryKey: ['git-diff', selectedFile],
    queryFn: () => gitApi.diff({ path: selectedFile ?? undefined }),
    enabled: selectedFile !== null,
    staleTime: 5_000,
  });

  const prsQ = useQuery<{ ok: boolean; data?: PullRequestDTO[]; error?: string }>({
    queryKey: ['prs', prState],
    queryFn: () => prApi.list(prState),
    staleTime: 30_000,
    enabled: activeTab === 'prs',
  });

  const suggestMut = useMutation({
    mutationFn: () => gitApi.commit({ op: 'suggest' }),
    onSuccess: (res) => {
      if (res.ok && res.data) setCommitMsg((res.data as Record<string, unknown>)?.message as string ?? '');
      else toast.error(res.error ?? 'Falha ao sugerir');
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  const commitMut = useMutation({
    mutationFn: () => gitApi.commit({ op: 'commit', message: commitMsg }),
    onSuccess: (res) => {
      if (res.ok) { toast.success('Commit realizado'); setCommitMsg(''); qc.invalidateQueries({ queryKey: ['git-status'] }); }
      else toast.error(res.error ?? 'Falha no commit');
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  const cppMut = useMutation({
    mutationFn: () => gitApi.commit({ op: 'cpp', message: commitMsg, base: cppBase }),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success('Commit + Push + PR criado');
        setCommitMsg('');
        setPendingCpp(false);
        qc.invalidateQueries({ queryKey: ['git-status'] });
        qc.invalidateQueries({ queryKey: ['prs'] });
      } else toast.error(res.error ?? 'Falha');
      setPendingCpp(false);
    },
    onError: (e: any) => { toast.error(e?.message ?? String(e)); setPendingCpp(false); },
  });

  const status = statusQ.data;
  const prs: PullRequestDTO[] = prsQ.data?.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <GitBranch size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Git · PRs</h1>
          {status?.branch && (
            <span className="font-mono text-[11px] text-dim">{status.branch}</span>
          )}
          {status && (status.ahead > 0 || status.behind > 0) && (
            <div className="flex items-center gap-1">
              {status.ahead > 0 && <span className="flex items-center gap-0.5 text-[10px] text-success"><ArrowUp size={9} />{status.ahead}</span>}
              {status.behind > 0 && <span className="flex items-center gap-0.5 text-[10px] text-warning"><ArrowDown size={9} />{status.behind}</span>}
            </div>
          )}
        </div>
        <button type="button" onClick={() => { qc.invalidateQueries({ queryKey: ['git-status'] }); qc.invalidateQueries({ queryKey: ['prs'] }); }}
          className="rounded p-1.5 text-dim hover:text-text">
          <RefreshCw size={13} className={clsx((statusQ.isFetching || prsQ.isFetching) && 'animate-spin')} />
        </button>
      </header>

      <div className="flex border-b border-border-subtle px-6">
        {[
          { id: 'status', label: 'Status', icon: <GitCommit size={11} /> },
          { id: 'prs', label: 'Pull Requests', icon: <GitPullRequest size={11} /> },
        ].map((t) => (
          <button key={t.id} type="button" onClick={() => setActiveTab(t.id as any)}
            className={clsx('flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[11px] transition-colors',
              activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-dim hover:text-text')}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {activeTab === 'status' && (
          <>
            {/* Left: files + commit form */}
            <div className="flex w-[320px] shrink-0 flex-col border-r border-border-subtle overflow-hidden">
              <div className="flex-1 overflow-auto px-3 py-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-dim mb-2">
                  Arquivos modificados {status ? `(${status.files.length})` : ''}
                </p>
                {statusQ.isLoading && <p className="text-[12px] text-dim py-4 text-center">Carregando…</p>}
                {status?.files.length === 0 && <p className="text-[12px] text-dim py-4 text-center">Working tree limpa</p>}
                {status?.files.map((f) => (
                  <div key={f.path + (f.staged ? 's' : 'u')} onClick={() => setSelectedFile(f.path)}>
                    <FileBadge f={f} />
                  </div>
                ))}
              </div>

              {/* Commit form */}
              <div className="border-t border-border-subtle px-3 py-3 flex flex-col gap-2">
                <textarea value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
                  placeholder="Mensagem do commit…" rows={3}
                  className="rounded-md border border-border-subtle bg-surface-2 px-3 py-2 text-[12px] text-text outline-none focus:border-primary resize-none" />
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => suggestMut.mutate()} disabled={suggestMut.isPending}
                    className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-soft hover:text-primary disabled:opacity-50">
                    {suggestMut.isPending ? <RefreshCw size={10} className="animate-spin" /> : <Wand2 size={10} />} Sugerir
                  </button>
                  <button type="button" onClick={() => commitMut.mutate()} disabled={!commitMsg.trim() || commitMut.isPending}
                    className="flex items-center gap-1 rounded-md bg-surface-3 px-2 py-1 text-[11px] text-text-soft hover:text-text disabled:opacity-50">
                    <GitCommit size={10} /> Commit
                  </button>
                  {pendingCpp ? (
                    <div className="flex items-center gap-1 ml-auto">
                      <input value={cppBase} onChange={e => setCppBase(e.target.value)}
                        className="w-20 rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text outline-none focus:border-primary" />
                      <button type="button" disabled={cppMut.isPending} onClick={() => cppMut.mutate()}
                        className="rounded bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20 disabled:opacity-50">
                        {cppMut.isPending ? <RefreshCw size={9} className="animate-spin" /> : 'OK'}
                      </button>
                      <button type="button" onClick={() => setPendingCpp(false)} className="text-[11px] text-dim hover:text-text">✕</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setPendingCpp(true)} disabled={!commitMsg.trim()}
                      className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-50 ml-auto">
                      <Send size={10} /> CPP
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Right: diff viewer */}
            <div className="flex-1 overflow-auto p-4">
              {!selectedFile && (
                <div className="flex h-full items-center justify-center text-[13px] text-dim">
                  Selecione um arquivo para ver o diff
                </div>
              )}
              {selectedFile && diffQ.isLoading && (
                <div className="flex h-full items-center justify-center text-[12px] text-dim">Carregando diff…</div>
              )}
              {selectedFile && diffQ.data && (
                <pre className="font-mono text-[11px] text-text whitespace-pre leading-relaxed overflow-auto">
                  {diffQ.data.raw || 'Sem diff disponível'}
                  {diffQ.data.truncated && <span className="text-warning block mt-2">… [diff truncado]</span>}
                </pre>
              )}
            </div>
          </>
        )}

        {activeTab === 'prs' && (
          <div className="flex-1 overflow-auto px-6 py-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {(['open', 'closed', 'all'] as const).map((s) => (
                  <button key={s} type="button" onClick={() => setPrState(s)}
                    className={clsx('rounded-md px-2.5 py-1 text-[11px] transition-colors',
                      prState === s ? 'bg-primary/10 text-primary' : 'text-dim hover:text-text')}>
                    {s}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setShowCreatePr(true)}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft">
                <Plus size={12} /> Criar PR
              </button>
            </div>

            {prsQ.isLoading && <p className="text-center text-[13px] text-dim py-10">Carregando…</p>}
            {!prsQ.isLoading && prs.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-10">
                <GitPullRequest size={28} className="text-dim/40" />
                <p className="text-[13px] text-dim">Nenhum PR encontrado</p>
              </div>
            )}
            {prs.length > 0 && (
              <div className="overflow-hidden rounded-md border border-border-subtle">
                <table className="w-full">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Título</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">#</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Autor</th>
                      <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-dim"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {prs.map(pr => <PRRow key={pr.number} pr={pr} onSelect={setSelectedPr} />)}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedPr && <PRDetailModal pr={selectedPr} onClose={() => setSelectedPr(null)} />}
      {showCreatePr && <CreatePRModal onClose={() => setShowCreatePr(false)} onCreated={() => { qc.invalidateQueries({ queryKey: ['prs'] }); }} />}
    </div>
  );
}
