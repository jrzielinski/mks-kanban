import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Server, Plus, RefreshCw, Trash2, ChevronRight, AlertCircle,
  CheckCircle2, Clock, XCircle, Terminal, Wrench, BookOpen, Layers,
  Folder, GitBranch, Github, Search, Database, Slack, Globe, Brain,
  Clock4, Sparkles, MousePointer, FileSpreadsheet, Lightbulb,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { mcpApi } from '../ipc/client';
import type { McpServerDetailDTO, McpAddRequestDTO, McpServerListItemDTO } from '@shared/types';

// ── Status badge ─────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { icon: React.ReactNode; label: string; cls: string }> = {
    ready:    { icon: <CheckCircle2 size={11} />, label: 'ready',    cls: 'text-success bg-success/10' },
    starting: { icon: <Clock size={11} />,        label: 'starting', cls: 'text-warning bg-warning/10' },
    error:    { icon: <XCircle size={11} />,      label: 'error',    cls: 'text-error bg-error/10' },
    exited:   { icon: <AlertCircle size={11} />,  label: 'exited',   cls: 'text-dim bg-surface-2' },
  };
  const s = map[status] ?? map.exited;
  return (
    <span className={clsx('flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium', s.cls)}>
      {s.icon} {s.label}
    </span>
  );
}

// ── Catálogo de MCP servers conhecidos ───────────────────────────────────
//
// Entradas curadas dos servidores oficiais do Anthropic + populares da
// comunidade. Click num card → pré-preenche o AddModal. Quando o servidor
// precisa de uma chave/token ou caminho, marcamos `needs` pra mostrar um
// hint na UI e o usuário não cria sem isso preenchido.

interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  command: string;
  args: string[];
  /** Variáveis de ambiente requeridas (KEY=) — pré-preenchidas pro user editar. */
  envHints?: string[];
  /** Aviso curto sobre requisitos (ex: "precisa de path local", "precisa de API key"). */
  needs?: string;
}

const MCP_CATALOG: CatalogEntry[] = [
  {
    name: 'filesystem',
    title: 'Filesystem',
    description: 'Lê e escreve arquivos numa pasta local específica do seu computador.',
    icon: Folder,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '<caminho-da-pasta>'],
    needs: 'Precisa: substitua <caminho-da-pasta> por um diretório real (ex: /home/usuario/projetos).',
  },
  {
    name: 'fetch',
    title: 'Fetch (web)',
    description: 'Baixa páginas da web e retorna o conteúdo como markdown — pro agente "navegar" e ler URLs.',
    icon: Globe,
    command: 'uvx',
    args: ['mcp-server-fetch'],
    needs: 'Precisa: ter `uv` instalado (https://docs.astral.sh/uv/).',
  },
  {
    name: 'memory',
    title: 'Memory',
    description: 'Knowledge graph persistente — agente lembra fatos entre sessões.',
    icon: Brain,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    name: 'github',
    title: 'GitHub',
    description: 'Lê repos, issues e PRs do GitHub. Cria/comenta issues automaticamente.',
    icon: Github,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envHints: ['GITHUB_PERSONAL_ACCESS_TOKEN='],
    needs: 'Precisa: GitHub Personal Access Token (settings/tokens).',
  },
  {
    name: 'git',
    title: 'Git local',
    description: 'Operações git num repositório local — log, diff, status, etc.',
    icon: GitBranch,
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '<caminho-do-repo>'],
    needs: 'Precisa: substitua <caminho-do-repo> e tenha `uv` instalado.',
  },
  {
    name: 'brave-search',
    title: 'Brave Search',
    description: 'Busca na web via Brave Search API. 2.000 buscas grátis/mês.',
    icon: Search,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envHints: ['BRAVE_API_KEY='],
    needs: 'Precisa: API key gratuita em api.search.brave.com.',
  },
  {
    name: 'postgres',
    title: 'PostgreSQL',
    description: 'Read-only no Postgres — agente consulta tabelas e schemas.',
    icon: Database,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '<connection-string>'],
    needs: 'Precisa: connection string (ex: postgresql://user:pass@host/db).',
  },
  {
    name: 'sqlite',
    title: 'SQLite',
    description: 'Lê e escreve em um arquivo SQLite local — útil pra dados estruturados.',
    icon: FileSpreadsheet,
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '<arquivo.db>'],
    needs: 'Precisa: caminho de um .db existente e `uv` instalado.',
  },
  {
    name: 'time',
    title: 'Time / Timezones',
    description: 'Hora atual, conversões entre timezones — útil pra agendamentos.',
    icon: Clock4,
    command: 'uvx',
    args: ['mcp-server-time'],
    needs: 'Precisa: ter `uv` instalado.',
  },
  {
    name: 'puppeteer',
    title: 'Puppeteer',
    description: 'Automação de browser — abre páginas, clica, digita, screenshot.',
    icon: MousePointer,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  {
    name: 'slack',
    title: 'Slack',
    description: 'Lê mensagens e posta em canais do seu workspace Slack.',
    icon: Slack,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envHints: ['SLACK_BOT_TOKEN=', 'SLACK_TEAM_ID='],
    needs: 'Precisa: bot token (xoxb-…) e team ID do workspace.',
  },
  {
    name: 'everything',
    title: 'Everything (demo)',
    description: 'Servidor de exemplo do MCP — mostra todas as capacidades. Bom pra testar.',
    icon: Sparkles,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  },
];

// ── Add modal ─────────────────────────────────────────────────────────────

function AddModal({
  onClose,
  preset,
}: {
  onClose: () => void;
  preset?: CatalogEntry | null;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState(preset?.name ?? '');
  const [command, setCommand] = React.useState(preset?.command ?? '');
  const [argsStr, setArgsStr] = React.useState((preset?.args ?? []).join(' '));
  const [envStr, setEnvStr] = React.useState((preset?.envHints ?? []).join('\n'));
  const [scope, setScope] = React.useState<'user' | 'project'>('user');

  const mut = useMutation({
    mutationFn: (req: McpAddRequestDTO) => mcpApi.add(req),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success('Servidor MCP adicionado');
        qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
        onClose();
      } else {
        toast.error(res.error ?? 'Falha ao adicionar');
      }
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  function parseEnv(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
  }

  function submit() {
    if (!name.trim() || !command.trim()) { toast.error('Nome e comando são obrigatórios'); return; }
    const args = argsStr.split(/\s+/).filter(Boolean);
    const env = envStr.trim() ? parseEnv(envStr) : undefined;
    mut.mutate({ name: name.trim(), command: command.trim(), args, env, scope });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] rounded-xl border border-border-subtle bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2">
            <Server size={14} className="text-primary" />
            <span className="text-[14px] font-semibold text-text">
              {preset ? `Adicionar: ${preset.title}` : 'Adicionar servidor MCP'}
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-dim hover:text-text"><XCircle size={16} /></button>
        </div>
        {preset?.needs && (
          <div className="flex items-start gap-2 border-b border-border-subtle bg-warning/[0.06] px-5 py-2.5 text-[11.5px] text-warning">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{preset.needs}</span>
          </div>
        )}
        <div className="flex flex-col gap-4 px-5 py-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Nome" required>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="my-mcp" className="w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary" />
            </Field>
            <Field label="Scope">
              <select value={scope} onChange={e => setScope(e.target.value as any)}
                className="w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary">
                <option value="user">user (~/.makestudio)</option>
                <option value="project">project (.makestudio/)</option>
              </select>
            </Field>
          </div>
          <Field label="Comando" required>
            <input value={command} onChange={e => setCommand(e.target.value)}
              placeholder="npx my-mcp-server" className="w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
          </Field>
          <Field label="Args extras (separados por espaço)">
            <input value={argsStr} onChange={e => setArgsStr(e.target.value)}
              placeholder="--port 3100 --verbose" className="w-full rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
          </Field>
          <Field label="Variáveis de ambiente (KEY=VALUE por linha)">
            <textarea value={envStr} onChange={e => setEnvStr(e.target.value)} rows={3}
              placeholder={'MCP_TOKEN=abc123\nDEBUG=1'}
              className="w-full resize-y rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-soft hover:text-text">Cancelar</button>
          <button type="button" onClick={submit} disabled={mut.isPending}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-50">
            {mut.isPending ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Adicionar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Detail panel ───────────────────────────────────────────────────────────

function DetailPanel({ name, onClose }: { name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = React.useState<'tools' | 'resources' | 'prompts' | 'logs'>('tools');
  const [pendingRemove, setPendingRemove] = React.useState(false);

  const detailQ = useQuery<McpServerDetailDTO | null>({
    queryKey: ['mcp', 'detail', name],
    queryFn: () => mcpApi.detail(name, 200),
    refetchInterval: 5_000,
  });

  const restartMut = useMutation({
    mutationFn: () => mcpApi.restart(name),
    onSuccess: (res) => {
      if (res.ok) { toast.success('Reiniciando…'); qc.invalidateQueries({ queryKey: ['mcp'] }); }
      else toast.error(res.error ?? 'Falha ao reiniciar');
    },
  });

  const removeMut = useMutation({
    mutationFn: () => mcpApi.remove(name),
    onSuccess: (res) => {
      if (res.ok) { toast.success('Servidor removido'); qc.invalidateQueries({ queryKey: ['mcp', 'list'] }); onClose(); }
      else toast.error(res.error ?? 'Falha ao remover');
    },
  });

  const d = detailQ.data;

  const tabs = [
    { id: 'tools', label: 'Tools', icon: <Wrench size={11} />, count: d?.tools.length ?? 0 },
    { id: 'resources', label: 'Resources', icon: <Layers size={11} />, count: d?.resources.length ?? 0 },
    { id: 'prompts', label: 'Prompts', icon: <BookOpen size={11} />, count: d?.prompts.length ?? 0 },
    { id: 'logs', label: 'Logs', icon: <Terminal size={11} />, count: d?.logs.length ?? 0 },
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex h-[600px] w-[720px] flex-col rounded-xl border border-border-subtle bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2">
            <Server size={14} className="text-primary" />
            <span className="text-[14px] font-semibold text-text">{name}</span>
            {d && <StatusBadge status={d.status} />}
          </div>
          <button type="button" onClick={onClose} className="text-dim hover:text-text"><XCircle size={16} /></button>
        </div>

        {d && (
          <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-2">
            <span className="font-mono text-[10px] text-dim">{d.command} {(d.args ?? []).join(' ')}</span>
          </div>
        )}

        <div className="flex border-b border-border-subtle px-5">
          {tabs.map(t => (
            <button key={t.id} type="button" onClick={() => setActiveTab(t.id as any)}
              className={clsx('flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[11px] transition-colors',
                activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-dim hover:text-text')}>
              {t.icon} {t.label}
              {t.count > 0 && <span className="rounded bg-surface-3 px-1 text-[9px] text-dim">{t.count}</span>}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-4">
          {!d && <div className="flex h-full items-center justify-center text-[12px] text-dim">Carregando…</div>}
          {d && activeTab === 'tools' && (
            <div className="flex flex-col gap-2">
              {d.tools.length === 0 && <span className="text-[12px] text-dim">Nenhuma tool disponível</span>}
              {d.tools.map(t => (
                <div key={t.name} className="rounded-md border border-border-subtle p-3">
                  <div className="font-mono text-[12px] font-medium text-text">{t.name}</div>
                  {t.description && <div className="mt-0.5 text-[11px] text-text-soft">{t.description}</div>}
                  {t.inputSchema && (
                    <pre className="mt-2 overflow-auto rounded bg-surface-2 p-2 text-[10px] text-dim">{JSON.stringify(t.inputSchema, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
          {d && activeTab === 'resources' && (
            <div className="flex flex-col gap-2">
              {d.resources.length === 0 && <span className="text-[12px] text-dim">Nenhum recurso disponível</span>}
              {d.resources.map(r => (
                <div key={r.uri} className="rounded-md border border-border-subtle p-3">
                  <div className="font-mono text-[11px] text-primary">{r.uri}</div>
                  {r.name && <div className="text-[12px] font-medium text-text">{r.name}</div>}
                  {r.description && <div className="text-[11px] text-text-soft">{r.description}</div>}
                  {r.mimeType && <div className="mt-1 font-mono text-[10px] text-dim">{r.mimeType}</div>}
                </div>
              ))}
            </div>
          )}
          {d && activeTab === 'prompts' && (
            <div className="flex flex-col gap-2">
              {d.prompts.length === 0 && <span className="text-[12px] text-dim">Nenhum prompt disponível</span>}
              {d.prompts.map(p => (
                <div key={p.name} className="rounded-md border border-border-subtle p-3">
                  <div className="font-mono text-[12px] font-medium text-text">{p.name}</div>
                  {p.description && <div className="mt-0.5 text-[11px] text-text-soft">{p.description}</div>}
                  {p.arguments && (
                    <pre className="mt-2 overflow-auto rounded bg-surface-2 p-2 text-[10px] text-dim">{JSON.stringify(p.arguments, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
          {d && activeTab === 'logs' && (
            <pre className="h-full overflow-auto rounded-md bg-surface-0 p-3 font-mono text-[10px] leading-relaxed text-text-soft">
              {d.logs.length === 0 ? '(sem logs de stderr)' : d.logs.join('\n')}
            </pre>
          )}
          {d?.lastError && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-error/30 bg-error/5 p-3">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-error" />
              <span className="font-mono text-[11px] text-error">{d.lastError}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3">
          <div className="flex items-center gap-2">
            {pendingRemove ? (
              <>
                <span className="text-[11px] text-error">Confirmar remoção?</span>
                <button type="button" onClick={() => removeMut.mutate()}
                  className="rounded bg-error/10 px-2 py-1 text-[11px] text-error hover:bg-error/20">Sim, remover</button>
                <button type="button" onClick={() => setPendingRemove(false)}
                  className="text-[11px] text-dim hover:text-text">Cancelar</button>
              </>
            ) : (
              <button type="button" onClick={() => setPendingRemove(true)}
                className="flex items-center gap-1.5 text-[11px] text-error hover:text-error/80">
                <Trash2 size={11} /> Remover
              </button>
            )}
          </div>
          <button type="button" onClick={() => restartMut.mutate()} disabled={restartMut.isPending}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-soft hover:text-text disabled:opacity-50">
            <RefreshCw size={11} className={clsx(restartMut.isPending && 'animate-spin')} /> Reiniciar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Catálogo: empty state com cards ───────────────────────────────────────

function EmptyStateWithCatalog({
  onPick,
  onCustom,
}: {
  onPick: (entry: CatalogEntry) => void;
  onCustom: () => void;
}): React.ReactElement {
  return (
    <div className="mx-auto max-w-[1100px]">
      {/* Header amigável */}
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Server size={20} strokeWidth={1.8} />
        </div>
        <h2 className="text-[18px] font-semibold text-text">
          Adicione seu primeiro servidor MCP
        </h2>
        <p className="max-w-[560px] text-[12.5px] leading-relaxed text-dim-soft">
          MCP servers dão ao agente acesso a ferramentas externas — arquivos,
          web, bancos de dados, GitHub, Slack… Comece com um popular abaixo
          (1 clique) ou configure manualmente.
        </p>
      </div>

      {/* Banner explicativo */}
      <div className="mb-6 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/[0.04] px-4 py-3 text-[12px] leading-relaxed text-text-soft">
        <Lightbulb size={13} className="mt-0.5 shrink-0 text-primary" strokeWidth={2} />
        <p>
          <span className="font-medium text-text">O que isso faz:</span> ao
          adicionar um servidor MCP, o agente ganha novas ferramentas. Ex.:
          adicione "Filesystem" → ele pode ler/escrever arquivos numa pasta.
          Adicione "GitHub" → ele consegue ver issues e PRs do seu repo.
        </p>
      </div>

      {/* Grid de cards */}
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[12px] font-medium uppercase tracking-[0.1em] text-dim/80">
          Sugestões populares
        </h3>
        <button
          type="button"
          onClick={onCustom}
          className="text-[11.5px] text-dim hover:text-text-soft"
        >
          ou adicionar manualmente →
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {MCP_CATALOG.map((entry) => (
          <CatalogCard key={entry.name} entry={entry} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

/** Linha horizontal com sugestões — aparece quando já existem servidores instalados. */
function SuggestionsRow({
  installed,
  onPick,
}: {
  installed: Set<string>;
  onPick: (entry: CatalogEntry) => void;
}): React.ReactElement | null {
  const remaining = MCP_CATALOG.filter((e) => !installed.has(e.name));
  if (remaining.length === 0) return null;
  // Mostra os 4 primeiros não instalados como sugestões compactas.
  const top = remaining.slice(0, 4);
  return (
    <div className="mb-4 rounded-lg border border-border-subtle/60 bg-surface-1/30 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-dim/70">
        <Lightbulb size={11} className="text-primary" />
        Sugestões pra adicionar
      </div>
      <div className="flex flex-wrap gap-2">
        {top.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.name}
              type="button"
              onClick={() => onPick(entry)}
              title={entry.description}
              className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft transition-colors hover:border-primary/40 hover:bg-surface-3 hover:text-text"
            >
              <Icon size={12} className="text-primary" strokeWidth={1.8} />
              {entry.title}
              <Plus size={11} className="text-dim" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CatalogCard({
  entry,
  onPick,
}: {
  entry: CatalogEntry;
  onPick: (e: CatalogEntry) => void;
}): React.ReactElement {
  const Icon = entry.icon;
  return (
    <button
      type="button"
      onClick={() => onPick(entry)}
      className="group flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-1/40 p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-surface-2/40"
    >
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon size={14} strokeWidth={1.8} />
        </div>
        <div className="flex-1">
          <div className="text-[13px] font-medium text-text group-hover:text-primary">
            {entry.title}
          </div>
          <div className="font-mono text-[10px] text-dim/70">{entry.name}</div>
        </div>
      </div>
      <p className="line-clamp-2 text-[11.5px] leading-relaxed text-text-soft">
        {entry.description}
      </p>
      {entry.needs && (
        <div className="flex items-start gap-1 rounded border border-warning/25 bg-warning/[0.06] px-2 py-1 text-[10.5px] leading-snug text-warning/90">
          <AlertCircle size={10} className="mt-0.5 shrink-0" />
          <span className="line-clamp-1">{entry.needs}</span>
        </div>
      )}
    </button>
  );
}

// ── Field helper ──────────────────────────────────────────────────────────

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-text-soft">
        {label}{required && <span className="ml-0.5 text-error">*</span>}
      </label>
      {children}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function McpPage(): React.ReactElement {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = React.useState(false);
  const [presetEntry, setPresetEntry] = React.useState<CatalogEntry | null>(null);
  const [detail, setDetail] = React.useState<string | null>(null);

  const openAdd = (preset: CatalogEntry | null = null): void => {
    setPresetEntry(preset);
    setShowAdd(true);
  };
  const closeAdd = (): void => {
    setShowAdd(false);
    setPresetEntry(null);
  };

  const listQ = useQuery<McpServerListItemDTO[]>({
    queryKey: ['mcp', 'list'],
    queryFn: () => mcpApi.list(),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  React.useEffect(() => {
    const off = mcpApi.onStatus((ev) => {
      qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
      qc.invalidateQueries({ queryKey: ['mcp', 'detail', ev.name] });
    });
    return off;
  }, [qc]);

  const servers = listQ.data ?? [];
  const total = servers.length;
  const ready = servers.filter((s) => s.status === 'ready').length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <Server size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">MCP Servers</h1>
          {total > 0 && (
            <span className="text-[11px] text-dim">
              {ready}/{total} online
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => qc.invalidateQueries({ queryKey: ['mcp', 'list'] })}
            className="rounded p-1.5 text-dim hover:text-text">
            <RefreshCw size={13} className={clsx(listQ.isFetching && 'animate-spin')} />
          </button>
          <button type="button" onClick={() => openAdd()}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft">
            <Plus size={12} /> Adicionar
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-5">
        {servers.length === 0 && !listQ.isFetching && (
          <EmptyStateWithCatalog onPick={(p) => openAdd(p)} onCustom={() => openAdd()} />
        )}

        {servers.length > 0 && (
          <SuggestionsRow
            installed={new Set(servers.map((s) => s.name))}
            onPick={(p) => openAdd(p)}
          />
        )}

        {servers.length > 0 && (
          <div className="overflow-hidden rounded-md border border-border-subtle">
            <table className="w-full">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Nome</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Status</th>
                  <th className="px-4 py-2.5 text-center text-[10px] font-medium uppercase tracking-wider text-dim">Tools</th>
                  <th className="px-4 py-2.5 text-center text-[10px] font-medium uppercase tracking-wider text-dim">Resources</th>
                  <th className="px-4 py-2.5 text-center text-[10px] font-medium uppercase tracking-wider text-dim">Prompts</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Comando</th>
                  <th className="w-[50px] px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.name} className="cursor-pointer border-t border-border-subtle hover:bg-surface-2/50"
                    onClick={() => setDetail(s.name)}>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[12px] font-medium text-text">{s.name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-4 py-3 text-center text-[12px] text-text-soft">{s.tools}</td>
                    <td className="px-4 py-3 text-center text-[12px] text-text-soft">{s.resources}</td>
                    <td className="px-4 py-3 text-center text-[12px] text-text-soft">{s.prompts}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-[10px] text-dim truncate max-w-[200px] block">{s.command ?? '—'}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChevronRight size={13} className="text-dim" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAdd && <AddModal preset={presetEntry} onClose={closeAdd} />}
      {detail && <DetailPanel name={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
