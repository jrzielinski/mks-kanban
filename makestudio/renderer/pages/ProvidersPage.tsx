import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  RefreshCw,
  KeyRound,
  Eye,
  EyeOff,
  Trash2,
  Save,
  X,
  CheckCircle2,
  XCircle,
  Loader2,
  Zap,
  RotateCcw,
  Plus,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { providersApi } from '../ipc/client';
import type {
  ProvidersSnapshotDTO,
  CatalogEntryDTO,
  ProviderInfoDTO,
  ProviderTier,
  EffortLevel,
  ProviderTestResultDTO,
} from '@shared/types';

const TIER_LABELS: Record<ProviderTier, string> = {
  fast: 'Fast',
  default: 'Default',
  image: 'Image / Vision',
};

const EFFORT_LEVELS: Array<{ value: EffortLevel; label: string; description: string }> = [
  { value: 'low', label: 'Low', description: 'Respostas curtas, menos contexto.' },
  { value: 'medium', label: 'Medium', description: 'Padrão equilibrado.' },
  { value: 'high', label: 'High', description: 'Mais reasoning, prompts maiores.' },
  { value: 'max', label: 'Max', description: 'Reasoning máximo. Custo mais alto.' },
];

export function ProvidersPage(): React.ReactElement {
  const qc = useQueryClient();
  const snapshotQuery = useQuery<ProvidersSnapshotDTO>({
    queryKey: ['providers', 'snapshot'],
    queryFn: () => providersApi.catalog(),
    staleTime: 30_000,
  });

  // Subscribe pra updates cross-window (key adicionada em outra janela etc).
  React.useEffect(() => {
    return providersApi.onChanged((snap) => {
      qc.setQueryData(['providers', 'snapshot'], snap);
    });
  }, [qc]);

  const setMut = useMutation({
    mutationFn: (req: Parameters<typeof providersApi.set>[0]) => providersApi.set(req),
    onSuccess: (snap) => {
      qc.setQueryData(['providers', 'snapshot'], snap);
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const setEffortMut = useMutation({
    mutationFn: (level: EffortLevel) => providersApi.setEffort(level),
    onSuccess: (snap) => {
      qc.setQueryData(['providers', 'snapshot'], snap);
      toast.success('Effort atualizado');
    },
  });

  const data = snapshotQuery.data;
  const tiers = (data?.entries ?? []) as CatalogEntryDTO[];
  const providers = (data?.providers ?? []) as ProviderInfoDTO[];
  const costs = data?.costs ?? [];
  const effort = data?.effort ?? 'medium';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Boxes size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Providers</h1>
        </div>
        <button
          type="button"
          onClick={() => setMut.mutate({ refreshFromServer: true })}
          disabled={setMut.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
          title="Re-buscar catálogo do backend"
        >
          <RefreshCw size={12} className={setMut.isPending ? 'animate-spin' : ''} />
          Sincronizar com servidor
        </button>
      </header>

      <div className="flex-1 overflow-auto px-6 py-5 space-y-6">
        {/* Tiers */}
        <Section title="Catálogo (3 tiers)" description="Modelo selecionado por tipo de chamada. Override mantém override entre fetches do servidor.">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {tiers.map((t) => (
              <TierCard
                key={t.tier}
                entry={t}
                cost={costs.find((c) => c.tier === t.tier)}
                onSave={(args) => setMut.mutate({ catalog: args })}
                onReset={() => setMut.mutate({ resetCatalogTier: t.tier })}
                disabled={setMut.isPending}
              />
            ))}
          </div>
        </Section>

        {/* Effort */}
        <Section title="Effort" description="Quanto reasoning enviar — afeta custo e latência.">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {EFFORT_LEVELS.map((e) => (
              <button
                key={e.value}
                type="button"
                onClick={() => setEffortMut.mutate(e.value)}
                disabled={setEffortMut.isPending}
                className={clsx(
                  'flex flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors',
                  effort === e.value
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border-subtle bg-surface-2 text-text-soft hover:border-border-soft hover:text-text',
                )}
              >
                <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                  <Zap size={11} />
                  {e.label}
                </span>
                <span className="text-[10.5px] text-dim/80">{e.description}</span>
              </button>
            ))}
          </div>
        </Section>

        {/* Providers / API keys */}
        <Section title="API keys" description="Storage criptografado em ~/.makestudio/credentials.enc (AES-256-GCM). Chaves de env vars têm prioridade sobre store quando ambas existem.">
          <ProvidersTable providers={providers} disabled={setMut.isPending} />
        </Section>
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-[13.5px] font-semibold text-text">{title}</h2>
        {description && <p className="mt-0.5 text-[11.5px] text-dim-soft">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function TierCard({
  entry,
  cost,
  onSave,
  onReset,
  disabled,
}: {
  entry: CatalogEntryDTO;
  cost: { inputPricePer1M: number; outputPricePer1M: number; hasPricing: boolean } | undefined;
  onSave: (args: { tier: ProviderTier; provider: string; model: string; baseUrl?: string; maxOutputTokens?: number }) => void;
  onReset: () => void;
  disabled: boolean;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const [provider, setProvider] = React.useState(entry.provider);
  const [model, setModel] = React.useState(entry.model);
  const [baseUrl, setBaseUrl] = React.useState(entry.baseUrl ?? '');
  React.useEffect(() => {
    if (!editing) {
      setProvider(entry.provider);
      setModel(entry.model);
      setBaseUrl(entry.baseUrl ?? '');
    }
  }, [entry, editing]);

  const submit = (): void => {
    if (!provider.trim() || !model.trim()) {
      toast.error('Provider e modelo são obrigatórios');
      return;
    }
    onSave({
      tier: entry.tier,
      provider: provider.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim() || undefined,
    });
    setEditing(false);
  };

  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/40 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
          {TIER_LABELS[entry.tier]}
        </span>
        <div className="flex items-center gap-1">
          {entry.overridden && (
            <button
              type="button"
              onClick={onReset}
              disabled={disabled}
              title="Reverter pro catálogo do servidor"
              className="flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning hover:bg-warning/15"
            >
              <RotateCcw size={9} />
              Override
            </button>
          )}
          <span
            className={clsx(
              'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em]',
              entry.hasKey ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger',
            )}
          >
            {entry.hasKey ? 'key ok' : 'sem key'}
          </span>
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="anthropic"
            className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="claude-sonnet-4-6"
            className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
          />
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="baseURL (opcional)"
            className="rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-dim-soft outline-none focus:border-primary"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[11px] text-text-soft hover:bg-surface-3"
            >
              <X size={11} />
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={disabled}
              className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
            >
              <Save size={11} /> Aplicar
            </button>
          </div>
        </div>
      ) : (
        <div onClick={() => setEditing(true)} className="cursor-pointer">
          <div className="font-mono text-[13px] font-medium text-text">{entry.model}</div>
          <div className="text-[11px] text-dim-soft">via {entry.provider}{entry.baseUrl ? ` · ${entry.baseUrl}` : ''}</div>
          {cost?.hasPricing && (
            <div className="mt-1 font-mono text-[10.5px] text-warning">
              ${cost.inputPricePer1M}/M in · ${cost.outputPricePer1M}/M out
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProvidersTable({
  providers,
  disabled,
}: {
  providers: ProviderInfoDTO[];
  disabled: boolean;
}): React.ReactElement {
  const [adding, setAdding] = React.useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <table className="w-full">
        <thead className="bg-surface-2">
          <tr>
            <Th>Provider</Th>
            <Th>Source</Th>
            <Th>Key</Th>
            <Th>Default base URL</Th>
            <Th className="w-[280px] text-right">Ações</Th>
          </tr>
        </thead>
        <tbody>
          {providers.length === 0 && !adding && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-[12px] text-dim/70">
                Nenhum provider configurado.
              </td>
            </tr>
          )}
          {providers.map((p) => (
            <ProviderRow key={p.name} provider={p} disabled={disabled} />
          ))}
          {adding && <NewProviderRow onCancel={() => setAdding(false)} disabled={disabled} />}
        </tbody>
      </table>
      <div className="border-t border-border-subtle bg-surface-1/40 px-3 py-2">
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded border border-dashed border-border-soft px-3 py-1.5 text-[12px] text-text-soft hover:border-primary/50 hover:text-primary"
          >
            <Plus size={12} />
            Adicionar provider
          </button>
        )}
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  disabled,
}: {
  provider: ProviderInfoDTO;
  disabled: boolean;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const [keyValue, setKeyValue] = React.useState('');
  const [showKey, setShowKey] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState(false);
  const [testResult, setTestResult] = React.useState<ProviderTestResultDTO | null>(null);

  React.useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(false), 3_000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  const setMut = useMutation({
    mutationFn: () => providersApi.set({ key: { provider: provider.name, key: keyValue } }),
    onSuccess: () => {
      setEditing(false);
      setKeyValue('');
      toast.success(`Key salva em ${provider.name}`);
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });
  const removeMut = useMutation({
    mutationFn: () => providersApi.set({ key: { provider: provider.name, remove: true } }),
    onSuccess: () => toast.success(`Key removida de ${provider.name}`),
  });
  const testMut = useMutation({
    mutationFn: () => providersApi.test({ provider: provider.name }),
    onSuccess: (r) => {
      setTestResult(r);
      if (r.ok) toast.success(`Conectado em ${r.latencyMs}ms`);
      else toast.error(`Falha: ${r.error}`);
    },
  });

  return (
    <tr className="border-t border-border-subtle">
      <Td>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] text-text">{provider.name}</span>
          {provider.referencedByCatalog && (
            <span className="rounded bg-primary/15 px-1 py-0 text-[9.5px] uppercase text-primary">
              em uso
            </span>
          )}
        </div>
      </Td>
      <Td>
        <SourceBadge source={provider.source} />
      </Td>
      <Td>
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              placeholder="sk-..."
              className="w-[200px] rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="rounded p-1 text-dim-soft hover:text-text"
            >
              {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          </div>
        ) : provider.hasKey ? (
          <code className="font-mono text-[11px] text-text-soft">{provider.keyMasked}</code>
        ) : (
          <span className="text-[11px] text-dim/70">—</span>
        )}
      </Td>
      <Td>
        {provider.defaultBaseUrl ? (
          <code className="font-mono text-[10.5px] text-dim-soft">{provider.defaultBaseUrl}</code>
        ) : (
          <span className="text-[10.5px] text-dim/70">—</span>
        )}
      </Td>
      <Td className="text-right">
        <div className="flex items-center justify-end gap-1">
          {testResult && !editing && (
            <span
              className={clsx(
                'rounded px-1.5 py-0.5 font-mono text-[10px]',
                testResult.ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger',
              )}
              title={testResult.error || `${testResult.latencyMs}ms`}
            >
              {testResult.ok ? `${testResult.latencyMs}ms` : 'fail'}
            </span>
          )}
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => { setEditing(false); setKeyValue(''); }}
                className="rounded p-1 text-dim-soft hover:bg-surface-3"
              >
                <X size={11} />
              </button>
              <button
                type="button"
                onClick={() => setMut.mutate()}
                disabled={disabled || !keyValue.trim()}
                className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
              >
                <Save size={11} /> Salvar
              </button>
            </>
          ) : (
            <>
              {provider.hasKey && (
                <button
                  type="button"
                  onClick={() => testMut.mutate()}
                  disabled={testMut.isPending}
                  className="flex items-center gap-1 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[10.5px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
                >
                  {testMut.isPending ? <Loader2 size={10} className="animate-spin" /> : <CheckCircle2 size={10} />}
                  Test
                </button>
              )}
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[10.5px] text-text-soft hover:bg-surface-3"
              >
                <KeyRound size={10} className="inline mr-1" />
                {provider.hasKey ? 'Trocar' : 'Setar'}
              </button>
              {provider.hasKey && provider.source === 'store' && (
                <button
                  type="button"
                  onClick={() => {
                    if (pendingDelete) { removeMut.mutate(); setPendingDelete(false); }
                    else { setPendingDelete(true); }
                  }}
                  disabled={disabled}
                  className={clsx(
                    'rounded p-1 disabled:opacity-50',
                    pendingDelete
                      ? 'bg-danger/20 text-danger'
                      : 'text-dim-soft hover:bg-surface-3 hover:text-danger',
                  )}
                  title={pendingDelete ? 'Clique de novo pra confirmar' : 'Remover key'}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </>
          )}
        </div>
      </Td>
    </tr>
  );
}

function NewProviderRow({
  onCancel,
  disabled,
}: {
  onCancel: () => void;
  disabled: boolean;
}): React.ReactElement {
  const [name, setName] = React.useState('');
  const [keyValue, setKeyValue] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [showKey, setShowKey] = React.useState(false);
  const setMut = useMutation({
    mutationFn: () => providersApi.set({ key: { provider: name.trim(), key: keyValue, baseUrl: baseUrl.trim() || undefined } }),
    onSuccess: () => { onCancel(); toast.success(`Provider ${name} adicionado`); },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });
  return (
    <tr className="border-t border-border-subtle bg-surface-2/40">
      <Td>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="openai"
          className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[12px] text-text outline-none focus:border-primary"
        />
      </Td>
      <Td colSpan={2}>
        <div className="flex items-center gap-1">
          <input
            type={showKey ? 'text' : 'password'}
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder="sk-..."
            className="flex-1 rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text outline-none focus:border-primary"
          />
          <button type="button" onClick={() => setShowKey((s) => !s)} className="rounded p-1 text-dim-soft hover:text-text">
            {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        </div>
      </Td>
      <Td>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="baseURL (opcional)"
          className="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1 font-mono text-[10.5px] text-dim-soft outline-none focus:border-primary"
        />
      </Td>
      <Td className="text-right">
        <div className="flex items-center justify-end gap-1">
          <button type="button" onClick={onCancel} className="rounded p-1 text-dim-soft hover:bg-surface-3">
            <X size={11} />
          </button>
          <button
            type="button"
            onClick={() => setMut.mutate()}
            disabled={disabled || !name.trim() || !keyValue.trim()}
            className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
          >
            <Save size={11} /> Adicionar
          </button>
        </div>
      </Td>
    </tr>
  );
}

function SourceBadge({ source }: { source: ProviderInfoDTO['source'] }): React.ReactElement {
  const meta: Record<ProviderInfoDTO['source'], { label: string; cls: string }> = {
    session: { label: 'session', cls: 'bg-primary/15 text-primary' },
    env: { label: 'env var', cls: 'bg-warning/15 text-warning' },
    store: { label: 'store', cls: 'bg-success/15 text-success' },
    none: { label: 'none', cls: 'bg-surface-3 text-dim-soft' },
  };
  const m = meta[source];
  return (
    <span className={clsx('rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em]', m.cls)}>
      {m.label}
    </span>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <th
      className={clsx(
        'px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  colSpan,
  className,
}: {
  children: React.ReactNode;
  colSpan?: number;
  className?: string;
}): React.ReactElement {
  return (
    <td colSpan={colSpan} className={clsx('px-3 py-2 align-middle', className)}>
      {children}
    </td>
  );
}
