import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  User,
  Mail,
  Globe,
  Clock,
  RefreshCw,
  LogOut,
  AlertTriangle,
  X,
  Hash,
  Building2,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Award,
} from 'lucide-react';
import clsx from 'clsx';
import { authApi } from '../ipc/client';
import { useAuth } from '../hooks/useAuth';
import type { LicenseInfoDTO } from '@shared/types';

export function AccountPage(): React.ReactElement {
  const auth = useAuth();
  const qc = useQueryClient();
  const [confirmLogout, setConfirmLogout] = React.useState(false);

  const refreshMut = useMutation({
    mutationFn: () => authApi.refresh(),
    onSuccess: (res) => {
      if (res.ok) qc.invalidateQueries({ queryKey: ['auth'] });
    },
  });

  const logoutMut = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      setConfirmLogout(false);
      qc.invalidateQueries({ queryKey: ['auth'] });
    },
  });

  const data = auth.data;
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-dim-soft">
        <span className="animate-pulse text-[12.5px]">carregando…</span>
      </div>
    );
  }

  const expRel = data.expiresAt
    ? formatExpiry(data.expiresAt)
    : { label: '—', tone: 'dim' as const };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-text">Conta · licença</h1>
          <p className="mt-0.5 text-[12.5px] text-dim-soft">
            Status da autenticação e do servidor MakeStudio.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refreshMut.mutate()}
            disabled={refreshMut.isPending}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
            title="Refresh do token via refreshToken"
          >
            <RefreshCw
              size={13}
              className={clsx(refreshMut.isPending && 'animate-spin')}
            />
            Refresh token
          </button>
          <button
            type="button"
            onClick={() => setConfirmLogout(true)}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 text-[12.5px] text-text-soft hover:bg-danger/15 hover:text-danger"
          >
            <LogOut size={13} />
            Sair
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {/* Status card */}
          <div className="rounded-lg border border-border-subtle bg-surface-1/60 p-5">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary">
                <User size={16} strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-text">
                  {data.email ?? <span className="italic text-dim">— sem email salvo</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-success">
                  <ShieldCheck size={11} />
                  Autenticado
                </div>
              </div>
            </div>

            <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-[12.5px]">
              <Field icon={Mail} label="Email" value={data.email ?? '—'} mono />
              <Field
                icon={Globe}
                label="Servidor"
                value={data.serverUrl ?? '—'}
                mono
              />
              <Field
                icon={Hash}
                label="User ID"
                value={data.userId != null ? String(data.userId) : '—'}
                mono
              />
              <Field
                icon={Building2}
                label="Tenant ID"
                value={data.tenantId ?? '—'}
                mono
              />
              <Field
                icon={Clock}
                label="Token expira"
                value={expRel.label}
                tone={expRel.tone}
              />
            </dl>
          </div>

          {/* Agent status */}
          <div className="rounded-lg border border-border-subtle bg-surface-1/60 p-5">
            <h2 className="mb-3 text-[13px] font-semibold text-text">
              Estado do agente
            </h2>
            {data.agentInitialized ? (
              <div className="flex items-center gap-2 text-[12.5px] text-success">
                <span className="h-2 w-2 rounded-full bg-success" />
                Contexto inicializado · pronto pra uso.
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[12.5px] text-warning">
                <span className="h-2 w-2 animate-pulse rounded-full bg-warning" />
                Contexto não inicializado. Reinicie o app pra ativar.
              </div>
            )}
            <p className="mt-2 text-[11.5px] text-dim-soft">
              O agente roda no main process do Electron. Heartbeat envia
              telemetria a cada 5 minutos pro <span className="font-mono text-dim">/cli-agent/heartbeat</span>.
            </p>
          </div>

          {/* License panel — Phase 11 */}
          <LicensePanel />

          {/* CLI fallback */}
          <div className="rounded-lg border border-dashed border-border-subtle bg-surface-1/30 p-5 text-[12.5px] text-dim-soft">
            <div className="mb-1 font-semibold text-text-soft">Fallback CLI</div>
            <p>
              Pra fazer login pelo terminal: <span className="font-mono text-text">makestudio login</span>.
              Pra sair: <span className="font-mono text-text">makestudio logout</span>.
              Configurações ficam em <span className="font-mono">~/.makestudio/config.json</span>.
            </p>
          </div>
        </div>
      </div>

      {/* Confirm logout */}
      <Dialog.Root open={confirmLogout} onOpenChange={setConfirmLogout}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle bg-surface-1 p-5 shadow-elev focus:outline-none">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle
                size={16}
                strokeWidth={2}
                className="shrink-0 text-warning"
              />
              <Dialog.Title className="text-[14px] font-semibold text-text">
                Sair da conta?
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-surface-3 hover:text-text"
                >
                  <X size={12} />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="text-[13px] text-text-soft">
              O token será removido de{' '}
              <span className="font-mono text-dim">~/.makestudio/config.json</span>{' '}
              e a janela voltará pra tela de login. Sessões salvas continuam
              intactas.
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12.5px] text-text-soft hover:bg-surface-3"
                >
                  Cancelar
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => logoutMut.mutate()}
                disabled={logoutMut.isPending}
                className="rounded-md bg-danger px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-danger/90 disabled:opacity-60"
              >
                {logoutMut.isPending ? 'Saindo…' : 'Sair'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

// lucide-react icons são ForwardRefExoticComponent — declarar o tipo
// alargado evita TS2322 com size/strokeWidth como Validator<string|number>.
type IconLike = React.ComponentType<{
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
}>;

interface FieldProps {
  icon: IconLike;
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'default' | 'warning' | 'danger' | 'dim';
}

function Field({
  icon: Icon,
  label,
  value,
  mono,
  tone = 'default',
}: FieldProps): React.ReactElement {
  const toneClass =
    tone === 'warning'
      ? 'text-warning'
      : tone === 'danger'
        ? 'text-danger'
        : tone === 'dim'
          ? 'text-dim'
          : 'text-text-soft';
  return (
    <>
      <dt className="flex items-center gap-2 text-dim-soft">
        <Icon size={12} strokeWidth={1.8} className="shrink-0 text-dim" />
        {label}
      </dt>
      <dd className={clsx(mono && 'font-mono text-[12px]', toneClass)}>
        {value}
      </dd>
    </>
  );
}

function LicensePanel(): React.ReactElement {
  const license = useQuery<LicenseInfoDTO | null>({
    queryKey: ['auth', 'heartbeat'],
    queryFn: () => authApi.heartbeat(),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const data = license.data;
  if (!data) {
    return (
      <div className="rounded-lg border border-dashed border-border-subtle bg-surface-1/30 p-5 text-[12.5px] text-dim-soft">
        <div className="mb-1 font-semibold text-text-soft">Licença</div>
        <p>Aguardando primeiro heartbeat ({license.isFetching ? 'carregando…' : 'até 5min'}). Status do servidor aparece aqui.</p>
      </div>
    );
  }
  const heartbeatLabel = data.lastHeartbeatAt
    ? formatRelativePast(data.lastHeartbeatAt)
    : '—';
  const nextLabel = data.nextHeartbeatAt
    ? formatRelativeFuture(data.nextHeartbeatAt)
    : '—';
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2/30 p-5 text-[12.5px]">
      <div className="mb-3 flex items-center gap-2">
        <Award size={14} className="text-primary" />
        <span className="font-semibold text-text">Licença</span>
        <span className="ml-auto flex items-center gap-1.5">
          {data.valid ? (
            <>
              <CheckCircle2 size={12} className="text-success" />
              <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.05em] text-success">válida</span>
            </>
          ) : (
            <>
              <XCircle size={12} className="text-danger" />
              <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.05em] text-danger">inválida</span>
            </>
          )}
        </span>
      </div>
      {!data.valid && data.reason && (
        <div className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11.5px] text-danger">
          {data.reason}
        </div>
      )}
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-text">
        <dt className="text-dim-soft">Plan</dt>
        <dd className="font-mono">{data.plan ?? '—'}</dd>
        <dt className="text-dim-soft">Seats</dt>
        <dd className="font-mono">
          {data.seats ? `${data.seats.used}/${data.seats.total}` : '—'}
        </dd>
        <dt className="text-dim-soft">Tasks (mês)</dt>
        <dd className="font-mono">
          {data.tasks ? `${data.tasks.used}/${data.tasks.limit}` : '—'}
        </dd>
        <dt className="text-dim-soft">Último heartbeat</dt>
        <dd className="font-mono">{heartbeatLabel}</dd>
        <dt className="text-dim-soft">Próximo</dt>
        <dd className="font-mono">{nextLabel}</dd>
      </dl>
    </div>
  );
}

function formatRelativePast(at: number): string {
  const diff = Date.now() - at;
  if (diff < 0) return 'agora';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s atrás`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}min atrás`;
  return `${Math.round(diff / 3_600_000)}h atrás`;
}

function formatRelativeFuture(at: number): string {
  const diff = at - Date.now();
  if (diff <= 0) return 'agora';
  if (diff < 60_000) return `em ${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `em ${Math.round(diff / 60_000)}min`;
  return `em ${Math.round(diff / 3_600_000)}h`;
}

function formatExpiry(ms: number): {
  label: string;
  tone: 'default' | 'warning' | 'danger' | 'dim';
} {
  const diff = ms - Date.now();
  if (diff <= 0) return { label: 'expirado', tone: 'danger' };
  if (diff < 5 * 60_000)
    return {
      label: `em ${Math.round(diff / 60_000)}min · refresh próximo`,
      tone: 'warning',
    };
  if (diff < 60 * 60_000)
    return { label: `em ${Math.round(diff / 60_000)}min`, tone: 'default' };
  if (diff < 24 * 3_600_000)
    return { label: `em ${Math.round(diff / 3_600_000)}h`, tone: 'default' };
  return {
    label: `em ${Math.round(diff / (24 * 3_600_000))}d · ${new Date(ms).toLocaleString('pt-BR')}`,
    tone: 'default',
  };
}
