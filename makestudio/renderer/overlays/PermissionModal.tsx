import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ShieldAlert,
  Terminal,
  Pencil,
  FileText,
  FilePlus,
  Layers,
  Wrench,
  Globe,
} from 'lucide-react';
import { subscribe, resolveRpc } from '../ipc/client';
import * as CH from '@shared/channels';
import type { PermissionRequest, PermissionChoice } from '@shared/types';

type Risk = 'neutral' | 'warning' | 'danger';

export function PermissionModal(): React.ReactElement | null {
  const [request, setRequest] = React.useState<PermissionRequest | null>(null);

  React.useEffect(() => {
    const offOpen = subscribe<PermissionRequest>(
      CH.EVT_PERMISSION_REQUEST,
      (req) => setRequest(req),
    );
    const offClose = subscribe<void>(CH.EVT_PERMISSION_CLOSE, () =>
      setRequest(null),
    );
    return () => {
      offOpen();
      offClose();
    };
  }, []);

  if (!request) return null;

  return (
    <PermissionView
      request={request}
      onResolve={(choice) => {
        resolveRpc(CH.AGENT_PERMISSION_RESOLVE, choice);
        setRequest(null);
      }}
    />
  );
}

interface ViewProps {
  request: PermissionRequest;
  onResolve: (choice: PermissionChoice) => void;
}

function PermissionView({ request, onResolve }: ViewProps): React.ReactElement {
  const risk: Risk = inferRisk(request);
  const Icon = pickIcon(request.toolName);

  const accept = React.useCallback(
    () => onResolve('allow'),
    [onResolve],
  );
  const acceptSession = React.useCallback(
    () => onResolve('allow-session'),
    [onResolve],
  );
  const addRule = React.useCallback(
    () => onResolve('allow-rule'),
    [onResolve],
  );
  const deny = React.useCallback(() => onResolve('deny'), [onResolve]);

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'enter' || k === 'y') {
        e.preventDefault();
        accept();
      } else if (k === 's') {
        e.preventDefault();
        acceptSession();
      } else if (k === 'r') {
        e.preventDefault();
        addRule();
      } else if (k === 'n' || k === 'escape') {
        e.preventDefault();
        deny();
      }
    },
    [accept, acceptSession, addRule, deny],
  );

  const RISK_BORDER: Record<Risk, string> = {
    neutral: 'border-border-subtle',
    warning: 'border-warning/60',
    danger: 'border-danger/60',
  };

  const RISK_HEADER: Record<Risk, string> = {
    neutral: 'bg-surface-2/60 text-text',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && deny()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={
            'fixed left-1/2 top-[14vh] z-50 w-[min(720px,94vw)] -translate-x-1/2 overflow-hidden rounded-xl border bg-surface-1 shadow-elev ' +
            RISK_BORDER[risk]
          }
          onOpenAutoFocus={(e) => {
            // Foca o conteúdo (não os botões) pra atalhos pegarem direto.
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
          onKeyDown={onKeyDown}
          tabIndex={-1}
        >
          <Dialog.Title className="sr-only">
            Permissão para {request.toolName}
          </Dialog.Title>

          {/* Header */}
          <div
            className={
              'flex items-center gap-3 border-b border-border-subtle/60 px-5 py-3 ' +
              RISK_HEADER[risk]
            }
          >
            <Icon size={16} strokeWidth={2.2} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold tracking-tight">
                  {request.toolName}
                </span>
                <RiskBadge risk={risk} />
              </div>
              {request.reason && (
                <div className="mt-0.5 truncate text-[12px] text-text-soft">
                  {request.reason}
                </div>
              )}
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[58vh] overflow-y-auto px-5 py-4">
            {request.warning && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[12.5px] text-warning">
                <ShieldAlert size={14} strokeWidth={2} className="mt-[2px] shrink-0" />
                <span className="whitespace-pre-wrap">{request.warning}</span>
              </div>
            )}

            {request.preview && (
              <pre className="mb-3 overflow-x-auto rounded-md border border-border-subtle bg-code-bg p-3 font-mono text-[12.5px] leading-snug text-text-soft">
                {request.preview}
              </pre>
            )}

            {request.toolInput != null && !request.preview && (
              <pre className="mb-3 overflow-x-auto rounded-md border border-border-subtle bg-code-bg p-3 font-mono text-[12.5px] leading-snug text-text-soft">
                {prettyInput(request.toolInput)}
              </pre>
            )}

            {request.diff && <DiffBlock diff={request.diff} />}
          </div>

          {/* Footer — botões */}
          <div className="flex items-center justify-end gap-2 border-t border-border-subtle/60 bg-surface-2/40 px-5 py-3">
            <FooterButton onClick={deny} variant="ghost" hint="n">
              Negar
            </FooterButton>
            <FooterButton onClick={addRule} variant="ghost" hint="r">
              Criar regra…
            </FooterButton>
            <FooterButton onClick={acceptSession} variant="soft" hint="s">
              Sessão
            </FooterButton>
            <FooterButton onClick={accept} variant="primary" hint="y / Enter">
              Permitir
            </FooterButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

function inferRisk(req: PermissionRequest): Risk {
  if (req.warning) return 'danger';
  const tool = req.toolName;
  if (
    tool === 'Bash' ||
    tool === 'shell_run' ||
    tool === 'Edit' ||
    tool === 'Write' ||
    tool === 'MultiEdit' ||
    tool === 'NotebookEdit'
  ) {
    return 'warning';
  }
  return 'neutral';
}

function pickIcon(toolName: string): typeof Wrench {
  switch (toolName) {
    case 'Bash':
    case 'shell_run':
      return Terminal;
    case 'Edit':
    case 'MultiEdit':
      return toolName === 'MultiEdit' ? Layers : Pencil;
    case 'Write':
      return FilePlus;
    case 'Read':
    case 'read_file':
      return FileText;
    case 'WebFetch':
    case 'web_fetch':
      return Globe;
    default:
      return Wrench;
  }
}

function prettyInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function RiskBadge({ risk }: { risk: Risk }): React.ReactElement | null {
  if (risk === 'neutral') return null;
  const label = risk === 'danger' ? 'risco alto' : 'cuidado';
  const cls =
    risk === 'danger'
      ? 'bg-danger/15 text-danger ring-1 ring-danger/30'
      : 'bg-warning/15 text-warning ring-1 ring-warning/30';
  return (
    <span
      className={
        'rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ' +
        cls
      }
    >
      {label}
    </span>
  );
}

interface FBProps {
  onClick: () => void;
  variant: 'primary' | 'soft' | 'ghost';
  hint: string;
  children: React.ReactNode;
}

function FooterButton({
  onClick,
  variant,
  hint,
  children,
}: FBProps): React.ReactElement {
  const base =
    'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors';
  const cls =
    variant === 'primary'
      ? base + ' bg-primary text-surface-0 hover:bg-primary-soft'
      : variant === 'soft'
        ? base + ' bg-surface-3 text-text hover:bg-surface-3/80'
        : base + ' text-text-soft hover:bg-surface-2/60 hover:text-text';
  return (
    <button type="button" onClick={onClick} className={cls}>
      <span>{children}</span>
      <kbd className="rounded bg-black/20 px-1 py-0.5 font-mono text-[10px] text-text-soft/80">
        {hint}
      </kbd>
    </button>
  );
}

// ── Diff block (parse +/− linhas pra colorir, sem dependência externa) ─

function DiffBlock({ diff }: { diff: string }): React.ReactElement {
  const lines = diff.split('\n');
  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-code-bg">
      <div className="border-b border-border-subtle/60 bg-surface-2/40 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-dim">
        diff
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12.5px] leading-snug">
        {lines.map((l, i) => {
          const tone = l.startsWith('+')
            ? 'text-success'
            : l.startsWith('-')
              ? 'text-danger'
              : l.startsWith('@@')
                ? 'text-secondary'
                : 'text-dim-soft';
          return (
            <div key={i} className={'whitespace-pre ' + tone}>
              {l || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
