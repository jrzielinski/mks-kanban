import React from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare, FolderGit2, Brain, Sparkles, Plug, Zap,
  Terminal, Webhook, BarChart3, Cable, Shield, GitBranch,
  Settings, Lightbulb, Search,
} from 'lucide-react';
import clsx from 'clsx';
import { subscribe } from '../ipc/client';
import * as CH from '@shared/channels';

interface CommandItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path: string;
  keywords?: string[];
}

const COMMANDS: CommandItem[] = [
  { id: 'chat',         label: 'Novo bate-papo',        icon: <MessageSquare size={14} />, path: '/',                         keywords: ['chat', 'conversa', 'novo'] },
  { id: 'projects',     label: 'Projetos',               icon: <FolderGit2 size={14} />,    path: '/projects',                  keywords: ['project', 'kanban'] },
  { id: 'memory',       label: 'Memória',                icon: <Brain size={14} />,          path: '/memory',                    keywords: ['memory', 'lembrar'] },
  { id: 'skills',       label: 'Skills',                 icon: <Sparkles size={14} />,       path: '/agents/skills',             keywords: ['skill', 'slash'] },
  { id: 'plugins',      label: 'Plugins',                icon: <Plug size={14} />,           path: '/agents/plugins',            keywords: ['plugin', 'extensao'] },
  { id: 'schedule',     label: 'Agenda',                 icon: <Zap size={14} />,            path: '/automation/schedule',       keywords: ['schedule', 'agendar', 'cron'] },
  { id: 'headless',     label: 'Headless runner',        icon: <Terminal size={14} />,       path: '/automation/headless',       keywords: ['headless', 'runner', 'batch'] },
  { id: 'hooks',        label: 'Hooks',                  icon: <Webhook size={14} />,        path: '/automation/hooks',          keywords: ['hook', 'evento'] },
  { id: 'security',     label: 'Security review',        icon: <Shield size={14} />,         path: '/automation/security-review', keywords: ['security', 'seguranca', 'vulnerabilidade'] },
  { id: 'git',          label: 'Git & PR',               icon: <GitBranch size={14} />,      path: '/integrations/git',          keywords: ['git', 'pr', 'branch', 'commit'] },
  { id: 'mcp',          label: 'MCP servers',            icon: <Cable size={14} />,          path: '/integrations/mcp',          keywords: ['mcp', 'server'] },
  { id: 'cluster',      label: 'Cluster',                icon: <Cable size={14} />,          path: '/integrations/cluster',      keywords: ['cluster', 'peers'] },
  { id: 'usage',        label: 'Uso e custo',            icon: <BarChart3 size={14} />,      path: '/monitor/usage',             keywords: ['usage', 'custo', 'tokens'] },
  { id: 'tips',         label: 'Dicas',                  icon: <Lightbulb size={14} />,      path: '/monitor/tips',              keywords: ['tip', 'dica'] },
  { id: 'settings',     label: 'Aparência',              icon: <Settings size={14} />,       path: '/settings/appearance',       keywords: ['settings', 'ajustes', 'tema', 'theme'] },
  { id: 'keybindings',  label: 'Atalhos de teclado',     icon: <Settings size={14} />,       path: '/settings/keybindings',      keywords: ['keybind', 'shortcut', 'atalho'] },
  { id: 'permissions',  label: 'Permissões',             icon: <Settings size={14} />,       path: '/settings/permissions',      keywords: ['permission', 'permissao'] },
];

export function useCommandPalette(): { open: boolean; setOpen: (v: boolean) => void } {
  const [open, setOpen] = React.useState(false);
  return { open, setOpen };
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: Props): React.ReactElement | null {
  const navigate = useNavigate();

  const handleSelect = (path: string): void => {
    navigate(path);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative w-full max-w-lg rounded-xl border border-border-subtle bg-surface-1 shadow-2xl">
        <Command className="overflow-hidden rounded-xl" loop>
          <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
            <Search size={14} className="shrink-0 text-dim" />
            <Command.Input
              autoFocus
              placeholder="Ir para…"
              className="flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-dim"
              aria-label="Buscar páginas e ações"
            />
            <kbd className="rounded border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] text-dim">
              esc
            </kbd>
          </div>

          <Command.List
            className="max-h-[360px] overflow-y-auto px-2 py-2"
            aria-label="Sugestões"
          >
            <Command.Empty className="px-4 py-6 text-center text-[12px] text-dim">
              Nenhum resultado encontrado.
            </Command.Empty>

            <Command.Group
              heading="Navegar"
              className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:font-semibold [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-widest [&>[cmdk-group-heading]]:text-dim/60"
            >
              {COMMANDS.map((cmd) => (
                <Command.Item
                  key={cmd.id}
                  value={`${cmd.label} ${cmd.keywords?.join(' ') ?? ''}`}
                  onSelect={() => handleSelect(cmd.path)}
                  className={clsx(
                    'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[12.5px] text-text-soft outline-none',
                    'data-[selected=true]:bg-surface-2 data-[selected=true]:text-text',
                  )}
                >
                  <span className="text-dim-soft">{cmd.icon}</span>
                  {cmd.label}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

/** Hook that wires EVT_NAVIGATE from main-process tray → React Router. */
export function useNavigateFromMain(): void {
  const navigate = useNavigate();
  React.useEffect(() => {
    const off = subscribe<{ path: string }>(CH.EVT_NAVIGATE, ({ path }) => {
      navigate(path);
    });
    return () => off();
  }, [navigate]);
}
