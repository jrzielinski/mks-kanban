import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import {
  Plus,
  MessageSquare,
  ChevronsLeft,
  ChevronDown,
  Search,
  FolderGit2,
  Settings,
  PenLine,
  Sparkles,
  Plug,
  Brain,
  Zap,
  Terminal,
  Webhook,
  BarChart3,
  Cable,
  MoreHorizontal,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import logoIcon from '../../assets/makestudioicon.png';
import { ThemeSwitcher } from './ThemeSwitcher';
import { sessionsApi, invoke, subscribe, authApi } from '../../ipc/client';
import * as CH from '@shared/channels';
import type { SessionSummaryDTO, AuthStatusDTO } from '@shared/types';

const MAX_RECENT = 8;

function sessionLabel(s: SessionSummaryDTO): string {
  if (s.title?.trim()) return s.title.trim();
  if (s.summary?.trim()) return s.summary.trim().slice(0, 50);
  if (s.firstUserMessage?.trim()) {
    const first = s.firstUserMessage.trim().split('\n')[0];
    return first.length > 50 ? first.slice(0, 47) + '…' : first;
  }
  const cwdLeaf = s.cwd?.replace(/\/+$/, '').split('/').pop();
  if (cwdLeaf) return cwdLeaf;
  return `Sessão ${s.sessionId.slice(0, 6)}`;
}

function initials(email?: string): string {
  if (!email) return '?';
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._\-+]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function displayName(email?: string): string {
  if (!email) return '';
  return email.split('@')[0]?.replace(/[._+]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? email;
}

interface MoreItem {
  to: string;
  label: string;
  icon: LucideIcon;
}
const MORE_ITEMS: MoreItem[] = [
  { to: '/agents/skills', label: 'Skills', icon: Sparkles },
  { to: '/memory', label: 'Memória', icon: Brain },
  { to: '/agents/plugins', label: 'Plugins', icon: Plug },
  { to: '/automation/schedule', label: 'Agenda', icon: Zap },
  { to: '/automation/headless', label: 'Headless', icon: Terminal },
  { to: '/automation/hooks', label: 'Hooks', icon: Webhook },
  { to: '/integrations/mcp', label: 'MCP servers', icon: Cable },
  { to: '/monitor/usage', label: 'Uso · custo', icon: BarChart3 },
];

export function Sidebar(): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [moreOpen, setMoreOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Sidebar collapsed state has THREE layers:
  //   - userOverride: the user clicked the chevron — pins the state
  //     until the user clicks it again, regardless of viewport changes.
  //   - autoCollapsed: viewport <= COLLAPSE_AT_PX, set by a resize
  //     observer. Drives the rendered state when there's no override.
  //   - collapsed: derived. What actually controls the layout.
  // This lets the user expand on a tiny screen if they want, AND lets
  // the layout protect itself from overflow on a default-launched app.
  const COLLAPSE_AT_PX = 900;
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const [autoCollapsed, setAutoCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= COLLAPSE_AT_PX,
  );
  useEffect(() => {
    const onResize = (): void => {
      setAutoCollapsed(window.innerWidth <= COLLAPSE_AT_PX);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const collapsed = userOverride ?? autoCollapsed;
  const setCollapsed = (next: boolean | ((prev: boolean) => boolean)): void => {
    const value = typeof next === 'function' ? (next as (p: boolean) => boolean)(collapsed) : next;
    setUserOverride(value);
  };

  const authQ = useQuery<AuthStatusDTO>({
    queryKey: ['auth', 'status'],
    queryFn: () => authApi.status(),
    staleTime: 60_000,
  });
  const email = authQ.data?.email;

  const sessionsQuery = useQuery<SessionSummaryDTO[]>({
    queryKey: ['sessions', 'recent'],
    queryFn: () => sessionsApi.list({ limit: MAX_RECENT }),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const sessions = (sessionsQuery.data ?? []).slice(0, MAX_RECENT);

  const resumeMut = useMutation({
    mutationFn: (sessionId: string) => sessionsApi.resume(sessionId),
    onSuccess: (res, sessionId) => {
      if (res.ok) {
        setActiveId(sessionId);
        navigate('/');
        qc.invalidateQueries({ queryKey: ['sessions'] });
      }
    },
  });

  const newChatMut = useMutation({
    mutationFn: () => invoke<void, { ok: boolean }>(CH.AGENT_CLEAR),
    onSuccess: () => {
      setActiveId(null);
      navigate('/');
    },
  });

  useEffect(() => {
    const off = subscribe<{ reason?: string; sessionId?: string }>(
      CH.EVT_SESSIONS_UPDATED,
      (payload) => {
        qc.invalidateQueries({ queryKey: ['sessions'] });
        if (payload?.reason === 'new-session' && payload.sessionId) {
          setActiveId(payload.sessionId);
        }
      },
    );
    return () => off();
  }, [qc]);

  const startNewChat = (): void => {
    if (newChatMut.isPending) return;
    newChatMut.mutate();
  };

  return (
    <aside
      className={clsx(
        'relative flex h-full shrink-0 flex-col bg-surface-1 overflow-hidden transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-[48px]' : 'w-[260px]',
      )}
    >
      {/* ─── Header — pt-8 para não sobrepor traffic-lights do macOS ──── */}
      <div className="flex items-center justify-between px-4 pt-8 pb-3">
        <div className={clsx('flex items-center gap-2.5 overflow-hidden transition-[opacity,max-width] duration-200', collapsed ? 'max-w-0 opacity-0' : 'max-w-full opacity-100')}>
          <img
            src={logoIcon}
            alt="MakeStudio"
            className="h-9 w-9 shrink-0 object-contain drop-shadow-[0_0_10px_rgba(232,93,39,0.25)]"
          />
          <span className="bg-gradient-to-r from-secondary via-primary to-primary-soft bg-clip-text text-[20px] font-bold tracking-tight text-transparent whitespace-nowrap leading-none">
            MakeStudio
          </span>
        </div>
        <button
          type="button"
          title={collapsed ? 'Expandir painel' : 'Recolher painel'}
          aria-label={collapsed ? 'Expandir painel' : 'Recolher painel'}
          onClick={() => setCollapsed((v) => !v)}
          className="ml-auto rounded-md p-1 text-dim-soft transition-colors hover:bg-surface-2 hover:text-text"
        >
          <ChevronsLeft
            size={14}
            strokeWidth={2}
            className={clsx('transition-transform duration-200', collapsed ? 'rotate-180' : '')}
          />
        </button>
      </div>

      {/* ─── Conteúdo principal (oculto quando colapsado) ─────────────── */}
      <div className={clsx('flex min-h-0 flex-1 flex-col transition-[opacity] duration-150', collapsed ? 'pointer-events-none opacity-0' : 'opacity-100')}>

        {/* ─── + Novo bate-papo ─────────────────────────────────────────── */}
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={startNewChat}
            disabled={newChatMut.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-border-soft bg-transparent px-4 py-2 text-[13px] font-medium text-text-soft transition-all hover:border-primary/50 hover:bg-surface-2/60 hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={14} strokeWidth={2.2} className="text-primary" />
            {newChatMut.isPending ? 'Limpando…' : 'Novo bate-papo'}
          </button>
        </div>

        {/* ─── Recentes ─────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-dim/70">
              Recentes
            </span>
            <button
              type="button"
              title="Nova conversa"
              onClick={startNewChat}
              disabled={newChatMut.isPending}
              className="rounded-md p-0.5 text-dim-soft transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-60"
            >
              <Plus size={12} strokeWidth={2} />
            </button>
          </div>

          <div className="flex flex-col gap-0.5">
            {sessionsQuery.isLoading && (
              <div className="px-2.5 py-2 text-[12px] text-dim/70">Carregando…</div>
            )}
            {!sessionsQuery.isLoading && sessions.length === 0 && (
              <div className="px-2.5 py-2 text-[12px] text-dim/70">Sem conversas recentes.</div>
            )}
            {sessions.map((s) => {
              const isActive = activeId === s.sessionId && location.pathname === '/';
              const isPending = resumeMut.isPending && resumeMut.variables === s.sessionId;
              const handleOpen = (): void => {
                if (activeId === s.sessionId) { navigate('/'); return; }
                resumeMut.mutate(s.sessionId);
              };
              const handleDeleted = (): void => {
                if (activeId === s.sessionId) {
                  setActiveId(null);
                  invoke<void, { ok: boolean }>(CH.AGENT_CLEAR).catch(() => { /* */ });
                  navigate('/');
                }
              };
              return (
                <SessionRow
                  key={s.sessionId}
                  session={s}
                  isActive={isActive}
                  isPending={isPending}
                  onOpen={handleOpen}
                  onDeleted={handleDeleted}
                />
              );
            })}
          </div>

          {/* "Mais" */}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className={clsx(
                'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                moreOpen ? 'text-text' : 'text-dim-soft hover:bg-surface-2/50 hover:text-text-soft',
              )}
            >
              <span>Mais</span>
              <ChevronDown
                size={13}
                strokeWidth={2}
                className={clsx('transition-transform', moreOpen ? '' : '-rotate-90')}
              />
            </button>
            {moreOpen && (
              <div className="mt-0.5 flex flex-col gap-px">
                {MORE_ITEMS.map((it) => (
                  <button
                    key={it.to}
                    type="button"
                    onClick={() => navigate(it.to)}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-text-soft transition-colors hover:bg-surface-2/50 hover:text-text"
                  >
                    <it.icon size={13} strokeWidth={1.8} className="shrink-0 text-dim-soft" />
                    <span className="truncate">{it.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ─── Footer ───────────────────────────────────────────────────── */}
        <div className="px-2 py-2">
          <div className="mb-1 flex items-center justify-around px-1">
            <FooterIcon icon={Search} title="Procurar (⌘K)" onClick={() => window.dispatchEvent(new CustomEvent('makestudio:openPalette'))} />
            <FooterIcon icon={FolderGit2} title="Projetos" onClick={() => navigate('/projects')} />
            <ThemeSwitcher />
            <FooterIcon icon={Settings} title="Ajustes" onClick={() => navigate('/settings/appearance')} />
            <FooterIcon icon={PenLine} title="Feedback" onClick={() => navigate('/monitor/feedback')} />
          </div>

          <button
            type="button"
            onClick={() => navigate('/integrations/auth')}
            className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2/60"
            title={email ?? 'Conta'}
            aria-label="Ir para conta"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-secondary to-tertiary text-[11px] font-bold text-text shadow-sm">
              {initials(email)}
            </div>
            <div className="min-w-0 flex-1 text-left">
              {email ? (
                <>
                  <div className="truncate text-[12.5px] font-medium text-text">{displayName(email)}</div>
                  <div className="truncate text-[10.5px] text-dim">{email}</div>
                </>
              ) : (
                <div className="truncate text-[12px] text-dim">Não autenticado</div>
              )}
            </div>
          </button>
        </div>
      </div>
    </aside>
  );
}

interface FooterIconProps {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
}
function FooterIcon({ icon: Icon, title, onClick }: FooterIconProps): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-dim-soft transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

// ─── Linha de sessão com menu de ações ────────────────────────────────────
interface SessionRowProps {
  session: SessionSummaryDTO;
  isActive: boolean;
  isPending: boolean;
  onOpen: () => void;
  onDeleted: () => void;
}
function SessionRow({ session, isActive, isPending, onOpen, onDeleted }: SessionRowProps): React.ReactElement {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const renameMut = useMutation({
    mutationFn: (title: string) => sessionsApi.rename(session.file, title.trim()),
    onSuccess: () => {
      setRenaming(false);
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => sessionsApi.delete(session.file),
    onSuccess: () => {
      setConfirmDelete(false);
      onDeleted();
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const label = sessionLabel(session);

  const submitRename = (): void => {
    const next = renameValue.trim();
    if (!next || next === (session.title ?? '')) {
      setRenaming(false);
      setRenameValue(session.title ?? '');
      return;
    }
    renameMut.mutate(next);
  };

  return (
    <div
      className={clsx(
        'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-all',
        isActive
          ? 'border border-secondary/35 bg-surface-2 text-text shadow-[0_0_24px_-12px_rgba(46,125,215,0.65)]'
          : 'border border-transparent text-text-soft hover:bg-surface-2/50 hover:text-text',
      )}
      title={isPending ? 'Carregando…' : label}
    >
      <MessageSquare
        size={13}
        strokeWidth={1.8}
        className={clsx(
          'shrink-0 transition-colors',
          isActive ? 'text-secondary' : 'text-dim-soft group-hover:text-text-soft',
          isPending && 'animate-pulse',
        )}
      />
      {renaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRename();
            if (e.key === 'Escape') { setRenaming(false); setRenameValue(session.title ?? ''); }
          }}
          className="min-w-0 flex-1 rounded bg-surface-3 px-1.5 py-0.5 text-[13px] text-text outline-none ring-1 ring-secondary/40 focus:ring-secondary"
        />
      ) : (
        <button
          type="button"
          disabled={isPending}
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left disabled:opacity-60"
        >
          {label}
        </button>
      )}

      {/*
        modal=false: without it, Radix mounts a full-viewport pointer-trap
        while the menu is open. With our auto-collapse sidebar listener +
        the AppLayout's nested overflow-auto containers, that trap was
        intercepting the click on the menu item itself and dismissing
        before onSelect ran — visible to the user as "menu disappears
        without doing anything".

        onCloseAutoFocus.preventDefault: Radix tries to refocus the
        trigger on close. The trigger has `opacity-0 group-hover:opacity-100`,
        so when the cursor leaves the row to reach the menu item, the
        trigger goes invisible. Refocusing an invisible button with our
        focus-visible ring style produces a flash and, on some setups,
        triggers the same dismiss path. Skipping the autofocus avoids it.
      */}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            title="Mais"
            // Stop pointerdown — not click — because Radix opens/closes on
            // pointerdown internally. stopping click() let pointerdown bubble
            // and a parent listener could close the menu before openness was
            // committed.
            onPointerDown={(e) => e.stopPropagation()}
            className={clsx(
              'shrink-0 rounded p-1 text-dim-soft outline-none transition-opacity hover:bg-surface-3 hover:text-text data-[state=open]:bg-surface-3 data-[state=open]:text-text data-[state=open]:opacity-100',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            <MoreHorizontal size={13} strokeWidth={1.8} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="right"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            onCloseAutoFocus={(e) => e.preventDefault()}
            className="z-50 min-w-[160px] overflow-hidden rounded-lg border border-border-soft bg-surface-1 p-1 shadow-elev"
          >
            <DropdownMenu.Item
              onSelect={() => { setRenameValue(session.title ?? label); setRenaming(true); }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-text-soft outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
            >
              <PenLine size={12} strokeWidth={1.8} />
              Renomear
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => setConfirmDelete(true)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-danger outline-none data-[highlighted]:bg-danger/10"
            >
              <Trash2 size={12} strokeWidth={1.8} />
              Excluir
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Dialog.Root open={confirmDelete} onOpenChange={setConfirmDelete}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev focus:outline-none">
            <Dialog.Title className="text-[14px] font-semibold text-text">
              Excluir conversa
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-[13px] text-text-soft">
              "{label}" será apagada permanentemente do disco. Essa ação não pode ser desfeita.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md border border-border-soft px-3 py-1.5 text-[12.5px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
                >
                  Cancelar
                </button>
              </Dialog.Close>
              <button
                type="button"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate()}
                className="rounded-md bg-danger px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-danger/90 disabled:opacity-60"
              >
                {deleteMut.isPending ? 'Excluindo…' : 'Excluir'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
