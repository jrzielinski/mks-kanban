import React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Package, Play, X, Loader2, FolderOpen } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { boilerplatesApi } from '../ipc/client';
import * as CH from '@shared/channels';
import { invoke } from '../ipc/client';
import type { BoilerplateDTO, BoilerplatePromptDTO, BoilerplateApplyProgressDTO } from '@shared/types';

export function BoilerplatesPage(): React.ReactElement {
  const listQuery = useQuery<BoilerplateDTO[]>({
    queryKey: ['boilerplates'],
    queryFn: () => boilerplatesApi.list(),
    staleTime: 60_000,
  });
  const [wizardSlug, setWizardSlug] = React.useState<string | null>(null);
  const list = listQuery.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Package size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Boilerplates</h1>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-5">
        {list.length === 0 && !listQuery.isLoading && (
          <div className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-[12px] text-dim/70">
            Nenhum boilerplate registrado. Use <code className="font-mono">makestudio boilerplate setup</code> no terminal pra detectar.
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((b) => (
            <div key={b.slug} className="rounded-md border border-border-subtle bg-surface-2/40 p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-[12.5px] font-medium text-text">{b.name}</span>
                <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[9.5px] text-dim-soft">
                  L{b.difficulty}
                </span>
              </div>
              <div className="mb-2 line-clamp-2 text-[11px] text-dim-soft">{b.description ?? '—'}</div>
              <div className="mb-3 flex flex-wrap gap-1">
                {b.stacks.slice(0, 4).map((s) => (
                  <span key={s} className="rounded bg-secondary/15 px-1.5 py-0.5 font-mono text-[9.5px] text-secondary">{s}</span>
                ))}
              </div>
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="text-dim/70">
                  {b.exists ? (b.hasManifest ? '✓ wizard pronto' : '✓ copy puro') : '⚠ path não existe'}
                </span>
                <button type="button" onClick={() => setWizardSlug(b.slug)} disabled={!b.exists}
                  className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-40">
                  <Play size={10} fill="currentColor" />
                  Aplicar
                </button>
              </div>
            </div>
          ))}
        </div>
        {wizardSlug && <ApplyWizard slug={wizardSlug} onClose={() => setWizardSlug(null)} />}
      </div>
    </div>
  );
}

function ApplyWizard({ slug, onClose }: { slug: string; onClose: () => void }): React.ReactElement {
  const promptsQuery = useQuery<BoilerplatePromptDTO[]>({
    queryKey: ['boilerplate', slug, 'prompts'],
    queryFn: () => boilerplatesApi.prompts(slug),
    staleTime: 60_000,
  });
  const [step, setStep] = React.useState<'targetDir' | 'prompts' | 'progress'>('targetDir');
  const [targetDir, setTargetDir] = React.useState('');
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [progress, setProgress] = React.useState<BoilerplateApplyProgressDTO[]>([]);

  const prompts = promptsQuery.data ?? [];

  // Hidrata defaults assim que chegam.
  React.useEffect(() => {
    if (prompts.length > 0 && Object.keys(answers).length === 0) {
      const init: Record<string, string> = {};
      for (const p of prompts) {
        if (p.default !== undefined) init[p.name] = p.default;
      }
      setAnswers(init);
    }
  }, [prompts]);

  // Subscribe assim que o wizard monta — não esperar `step === 'progress'`,
  // senão eventos `start`/`copy` emitidos antes do effect commit são perdidos.
  React.useEffect(() => {
    return boilerplatesApi.onProgress((ev) => setProgress((p) => [...p, ev]));
  }, []);

  const pickDirMut = useMutation({
    mutationFn: async () => {
      const r = await invoke(CH.DIALOG_OPEN_DIR, {});
      return r as { filePath?: string; cancelled: boolean };
    },
    onSuccess: (r) => {
      if (!r.cancelled && r.filePath) setTargetDir(r.filePath);
    },
  });

  const applyMut = useMutation({
    mutationFn: () => boilerplatesApi.apply({ slug, targetDir, answers }),
    onMutate: () => { setStep('progress'); setProgress([]); },
    onSettled: (r) => {
      if (r?.ok) toast.success(`Aplicado: ${r.filesChanged} arquivos modificados de ${r.filesScanned} escaneados`);
      else if (r?.error) toast.error(r.error);
    },
  });

  const canSubmit = targetDir.trim().length > 0 && prompts.every((p) => !p.required || (answers[p.name] ?? '').trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[680px] max-w-[90vw] rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-text">Aplicar boilerplate: {slug}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-dim hover:bg-surface-3 hover:text-text">
            <X size={14} />
          </button>
        </div>

        {step === 'targetDir' && (
          <>
            <Field label="Pasta destino">
              <div className="flex gap-1.5">
                <input value={targetDir} onChange={(e) => setTargetDir(e.target.value)}
                  placeholder="/Users/foo/projetos/novo-app"
                  className="flex-1 rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
                <button type="button" onClick={() => pickDirMut.mutate()}
                  className="flex items-center gap-1 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3">
                  <FolderOpen size={12} /> Escolher
                </button>
              </div>
            </Field>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose}
                className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3">
                Cancelar
              </button>
              <button type="button" onClick={() => setStep('prompts')} disabled={!targetDir.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60">
                Próximo
              </button>
            </div>
          </>
        )}

        {step === 'prompts' && (
          <>
            {prompts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-[12px] text-dim/70">
                Sem boilerplate.yaml — aplica como copy puro, sem placeholders.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {prompts.map((p) => (
                  <Field key={p.name} label={`${p.name}${p.required ? ' *' : ''}`}>
                    <span className="text-[10.5px] text-dim-soft">{p.description}</span>
                    {p.type === 'choice' && p.choices ? (
                      <select value={answers[p.name] ?? p.default ?? ''}
                        onChange={(e) => setAnswers({ ...answers, [p.name]: e.target.value })}
                        className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary">
                        <option value="">(escolher)</option>
                        {p.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : p.type === 'boolean' ? (
                      <select value={answers[p.name] ?? p.default ?? 'false'}
                        onChange={(e) => setAnswers({ ...answers, [p.name]: e.target.value })}
                        className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary">
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <input value={answers[p.name] ?? p.default ?? ''}
                        onChange={(e) => setAnswers({ ...answers, [p.name]: e.target.value })}
                        placeholder={p.default}
                        className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary" />
                    )}
                  </Field>
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setStep('targetDir')}
                className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3">
                Voltar
              </button>
              <button type="button" onClick={() => applyMut.mutate()} disabled={!canSubmit || applyMut.isPending}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60">
                <Play size={11} fill="currentColor" /> Aplicar
              </button>
            </div>
          </>
        )}

        {step === 'progress' && (
          <>
            <div className="max-h-[320px] overflow-auto rounded border border-border-subtle bg-surface-3 p-2 font-mono text-[10.5px] text-dim-soft">
              {progress.length === 0 && (
                <div className="flex items-center gap-2 text-dim/70">
                  <Loader2 size={11} className="animate-spin" /> aguardando…
                </div>
              )}
              {progress.map((p, i) => (
                <div key={i} className={clsx(
                  p.phase === 'error' && 'text-danger',
                  p.phase === 'done' && 'text-success',
                )}>
                  [{p.phase}] {p.log ?? p.error ?? p.file ?? ''}
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={onClose} disabled={applyMut.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60">
                Fechar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">{label}</span>
      {children}
    </label>
  );
}
