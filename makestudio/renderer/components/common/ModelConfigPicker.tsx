import React from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { apiConfigsApi, type ApiConfigDTO } from '../../ipc/client';
import { toast } from '../../lib/clientToast';

/**
 * ModelConfigPicker — botão que abre um popover com a lista de api-configs
 * cadastradas no Zielinski Cloud e permite trocar a config ativa via PATCH.
 *
 * Usado em dois lugares: na StatusBar (rodapé) e na InputBox (acima do envio).
 * Ambos anchored bottom-right, abrem pra cima.
 */
interface Props {
  currentModel: string | null;
  /** Renderiza o conteúdo do botão trigger. Recebe o nome curto do modelo. */
  renderTrigger?: (display: string) => React.ReactNode;
  /** Classes do botão trigger. Default = estilo "ghost" da status bar. */
  triggerClassName?: string;
  /** Largura do popover. Default 340. */
  panelWidth?: number;
  /**
   * Abre o popover acima ('top') ou abaixo ('bottom') do trigger.
   * Default 'top' — bom pra triggers no fim da tela (StatusBar).
   * Use 'bottom' quando houver espaço abaixo (ex: InputBox no chat).
   */
  placement?: 'top' | 'bottom';
}

export function ModelConfigPicker({
  currentModel,
  renderTrigger,
  triggerClassName,
  panelWidth = 340,
  placement = 'top',
}: Props): React.ReactElement | null {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);

  const listQuery = useQuery({
    queryKey: ['api-configs'],
    queryFn: () => apiConfigsApi.list(),
    enabled: open,
    staleTime: 30_000,
  });

  const activateMut = useMutation({
    mutationFn: (id: string) => apiConfigsApi.activate(id),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success('Modelo trocado');
        qc.invalidateQueries({ queryKey: ['api-configs'] });
        setOpen(false);
      } else {
        toast.error(res.error ?? 'Falha ao trocar modelo');
      }
    },
  });

  // Render the picker even when no model is currently selected — the
  // user must still be able to OPEN this menu to pick one. Hiding the
  // trigger when `currentModel` is null was a soft footgun: if the boot
  // sequence couldn't fetch /repl-chat/info, the user lost all access
  // to model switching with no recourse short of restarting the app.
  const display = currentModel ? shortenModel(currentModel) : 'Selecionar modelo';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          triggerClassName ??
          'flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-dim-soft transition-colors hover:bg-surface-2 hover:text-text'
        }
        title="Trocar modelo / API config"
      >
        {renderTrigger ? (
          renderTrigger(display)
        ) : (
          <>
            {display}
            <ChevronDown size={10} className="opacity-60" />
          </>
        )}
      </button>

      {open && (
        <>
          {/* Backdrop pra fechar ao clicar fora */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          {/* Painel — anchored à direita, abre pra cima ou pra baixo conforme placement */}
          <div
            className={clsx(
              'absolute right-0 z-50 flex flex-col rounded-lg border border-border-subtle bg-surface-1 p-1.5 shadow-elev',
              placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
            )}
            style={{
              width: panelWidth,
              // Limita altura ao viewport com folga — popover sempre cabe sem
              // cortar conteúdo. Itens internos rolam dentro desse cap.
              maxHeight: 'calc(100vh - 160px)',
            }}
          >
            <div className="flex items-center justify-between px-2 py-1.5">
              <div className="text-[11px] uppercase tracking-[0.1em] text-dim/80">
                API Configs
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  qc.invalidateQueries({ queryKey: ['api-configs'] });
                }}
                disabled={listQuery.isFetching}
                title="Recarregar"
                className="flex h-5 w-5 items-center justify-center rounded text-dim hover:bg-surface-2 hover:text-text disabled:opacity-40"
              >
                <RefreshCw
                  size={10}
                  className={clsx(listQuery.isFetching && 'animate-spin')}
                />
              </button>
            </div>

            {listQuery.isLoading && (
              <div className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-dim-soft">
                <Loader2 size={11} className="animate-spin" /> Carregando…
              </div>
            )}

            {/* Erro de IPC — handler não existe (main precisa rebuild) ou crash */}
            {listQuery.isError && (
              <div className="m-1 rounded border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] leading-relaxed text-danger">
                <div className="font-medium">Erro de IPC</div>
                <div className="mt-0.5 break-all font-mono text-[10px]">
                  {(listQuery.error as Error)?.message ?? String(listQuery.error)}
                </div>
                <div className="mt-1.5 text-[10.5px] text-danger/80">
                  Se o erro mencionar o handler{' '}
                  <span className="font-mono">apiConfigs:list</span>, recompile o
                  main: <span className="font-mono">cd agent/desktop && npx tsc -p tsconfig.json</span>{' '}
                  e relance o app.
                </div>
              </div>
            )}

            {/* Resposta lida mas backend retornou erro (auth, 401, etc.) */}
            {listQuery.data && !listQuery.data.ok && (
              <div className="m-1 rounded border border-danger/30 bg-danger/8 px-3 py-2 text-[11px] text-danger">
                {listQuery.data.error ?? 'Erro ao listar configs'}
              </div>
            )}

            {listQuery.data?.ok && listQuery.data.configs && (
              <ConfigList
                configs={listQuery.data.configs}
                activeId={listQuery.data.activeId}
                activatingId={activateMut.isPending ? activateMut.variables : null}
                onActivate={(id) => activateMut.mutate(id)}
              />
            )}

            {/* Fallback: query foi feita, ok=true, mas configs ausente — caso defensivo */}
            {listQuery.data?.ok && !listQuery.data.configs && (
              <div className="m-1 rounded border border-warning/30 bg-warning/8 px-3 py-2 text-[11px] text-warning">
                Resposta sem campo <span className="font-mono">configs</span>. Veja
                o console do main process pra detalhes.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Nome amigável do provider pro header da seção. Lower-case → label. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic / Claude',
  openai: 'OpenAI',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  cerebras: 'Cerebras',
  qwen: 'Qwen',
  mistral: 'Mistral',
  gemini: 'Gemini',
  google: 'Google',
  cohere: 'Cohere',
  together: 'Together AI',
  sambanova: 'SambaNova',
  perplexity: 'Perplexity',
  xai: 'xAI / Grok',
};

/** Ordem preferencial pra exibição. Providers fora dessa lista vão pro fim, em ordem alfa. */
const PROVIDER_ORDER = [
  'anthropic', 'openai', 'gemini', 'google', 'groq', 'deepseek',
  'cerebras', 'qwen', 'mistral', 'cohere', 'together', 'sambanova',
  'perplexity', 'xai',
];

function providerLabel(p: string): string {
  const key = p.toLowerCase();
  return PROVIDER_LABELS[key] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

function compareProviders(a: string, b: string): number {
  const ai = PROVIDER_ORDER.indexOf(a.toLowerCase());
  const bi = PROVIDER_ORDER.indexOf(b.toLowerCase());
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

function ConfigList({
  configs,
  activeId,
  activatingId,
  onActivate,
}: {
  configs: ApiConfigDTO[];
  activeId: string | undefined;
  activatingId: string | null;
  onActivate: (id: string) => void;
}): React.ReactElement {
  if (configs.length === 0) {
    return (
      <div className="px-3 py-3 text-[11.5px] text-dim/70">
        Nenhuma config cadastrada.
      </div>
    );
  }

  // Agrupa por provider (lowercased), preservando a ordem PROVIDER_ORDER.
  const grouped = new Map<string, ApiConfigDTO[]>();
  for (const c of configs) {
    const key = (c.provider || 'outros').toLowerCase();
    const arr = grouped.get(key) ?? [];
    arr.push(c);
    grouped.set(key, arr);
  }
  const sortedProviders = [...grouped.keys()].sort(compareProviders);

  // Provider que contém a config ativa — expande por default pro usuário
  // ver onde tá o "✓" sem precisar abrir nada.
  const activeProvider = activeId
    ? configs.find((c) => c.id === activeId)?.provider?.toLowerCase()
    : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {sortedProviders.map((provider) => (
        <ProviderGroup
          key={provider}
          provider={provider}
          items={grouped.get(provider) ?? []}
          activeId={activeId}
          activatingId={activatingId}
          onActivate={onActivate}
          defaultOpen={provider === activeProvider}
        />
      ))}
    </div>
  );
}

function ProviderGroup({
  provider,
  items,
  activeId,
  activatingId,
  onActivate,
  defaultOpen,
}: {
  provider: string;
  items: ApiConfigDTO[];
  activeId: string | undefined;
  activatingId: string | null;
  onActivate: (id: string) => void;
  defaultOpen: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(defaultOpen);
  const hasActive = items.some((c) => c.id === activeId);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0 text-dim" strokeWidth={2.2} />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-dim" strokeWidth={2.2} />
        )}
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
          {providerLabel(provider)}
        </span>
        {hasActive && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-primary"
            title="Provider com config ativa"
          />
        )}
        <span className="text-[10px] font-normal text-dim/60">{items.length}</span>
      </button>
      {open && (
        <div className="mb-1 ml-1">
          {items.map((c) => {
            const active = c.id === activeId;
            const activating = activatingId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => !active && !activating && onActivate(c.id)}
                disabled={active || activating}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                  active
                    ? 'bg-primary/10 text-text'
                    : 'text-text-soft hover:bg-surface-2 hover:text-text disabled:opacity-50',
                )}
              >
                <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {active ? (
                    <Check size={11} className="text-primary" strokeWidth={2.4} />
                  ) : activating ? (
                    <Loader2 size={11} className="animate-spin text-dim" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-dim/40" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">{c.name}</div>
                  {c.model && (
                    <div className="truncate font-mono text-[10.5px] text-dim/80">
                      {c.model}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function shortenModel(m: string): string {
  const s = m.toLowerCase();
  if (s.includes('opus')) {
    const v = s.match(/opus-?(\d+)-?(\d+)?/);
    return v ? `Opus ${v[1]}${v[2] ? '.' + v[2] : ''}` : 'Opus';
  }
  if (s.includes('sonnet')) {
    const v = s.match(/sonnet-?(\d+)-?(\d+)?/);
    return v ? `Sonnet ${v[1]}${v[2] ? '.' + v[2] : ''}` : 'Sonnet';
  }
  if (s.includes('haiku')) return 'Haiku';
  if (s.includes('gpt')) return m.toUpperCase();
  if (s.includes('gemini')) return 'Gemini';
  if (s.includes('deepseek')) {
    const v = s.match(/deepseek-?v?(\d+)?-?(\w+)?/);
    if (v) return `DeepSeek${v[1] ? ' v' + v[1] : ''}${v[2] ? ' ' + v[2].charAt(0).toUpperCase() + v[2].slice(1) : ''}`;
    return 'DeepSeek';
  }
  return m.length > 24 ? m.slice(0, 22) + '…' : m;
}
