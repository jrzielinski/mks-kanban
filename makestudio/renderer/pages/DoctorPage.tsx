import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Stethoscope,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Layers,
  Play,
  Wrench,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { healthApi, doctorApi } from '../ipc/client';
import type {
  HealthReportDTO,
  HealthCheckDTO,
  DoctorReportDTO,
  DoctorCheckDTO,
  DoctorRunOptionsDTO,
} from '@shared/types';

type Tab = 'health' | 'stacks';

export function DoctorPage(): React.ReactElement {
  const [tab, setTab] = React.useState<Tab>('health');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-2">
          <Stethoscope size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Doctor</h1>
        </div>
        <p className="mt-0.5 text-[12.5px] text-dim-soft">
          Health rápido + verificação completa de stacks (install/build/start) com auto-fix opcional.
        </p>
      </header>

      <nav className="flex items-center gap-1 border-b border-border-subtle bg-surface-1/40 px-6 py-2">
        <TabBtn label="Health" active={tab === 'health'} onClick={() => setTab('health')} />
        <TabBtn label="Stacks" active={tab === 'stacks'} onClick={() => setTab('stacks')} />
      </nav>

      <div className="flex-1 overflow-auto px-6 py-5">
        {tab === 'health' ? <HealthTab /> : <StacksTab />}
      </div>
    </div>
  );
}

function TabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-md px-3 py-1 font-mono text-[12px] transition-colors',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-text-soft hover:bg-surface-2 hover:text-text',
      )}
    >
      {label}
    </button>
  );
}

// ── Health tab ────────────────────────────────────────────────────────

function HealthTab(): React.ReactElement {
  const qc = useQueryClient();
  const query = useQuery<HealthReportDTO>({
    queryKey: ['health'],
    queryFn: () => healthApi.check(),
    staleTime: 10_000,
  });

  const data = query.data;
  const ranAt = data ? new Date(data.ranAt).toLocaleTimeString() : null;

  const passCount = data?.checks.filter((c) => c.status === 'pass').length ?? 0;
  const warnCount = data?.checks.filter((c) => c.status === 'warn').length ?? 0;
  const failCount = data?.checks.filter((c) => c.status === 'fail').length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          {data ? (
            <>
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 size={13} /> {passCount} OK
              </span>
              {warnCount > 0 && (
                <span className="flex items-center gap-1.5 text-warning">
                  <AlertTriangle size={13} /> {warnCount} avisos
                </span>
              )}
              {failCount > 0 && (
                <span className="flex items-center gap-1.5 text-danger">
                  <XCircle size={13} /> {failCount} falhas
                </span>
              )}
              {ranAt && <span className="text-dim/70">· {ranAt} · {data.durationMs}ms</span>}
            </>
          ) : query.isLoading ? (
            <span className="flex items-center gap-1.5 text-dim-soft">
              <Loader2 size={13} className="animate-spin" /> Rodando checks…
            </span>
          ) : (
            <span className="text-dim-soft">Pronto pra rodar</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => qc.invalidateQueries({ queryKey: ['health'] })}
          disabled={query.isFetching}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
        >
          <RefreshCw size={12} className={query.isFetching ? 'animate-spin' : ''} />
          Recheck
        </button>
      </div>

      <div className="overflow-hidden rounded-md border border-border-subtle">
        {data?.checks.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-dim/70">
            Nenhum check disponível.
          </div>
        )}
        {data?.checks.map((c, i) => <CheckRow key={i} check={c} />)}
        {!data && query.isLoading && (
          <div className="px-4 py-8 text-center text-[12px] text-dim/70">
            <Loader2 size={14} className="mx-auto mb-2 animate-spin" />
            Verificando ambiente…
          </div>
        )}
      </div>
    </div>
  );
}

function CheckRow({ check }: { check: HealthCheckDTO }): React.ReactElement {
  const meta: Record<HealthCheckDTO['status'], { Icon: React.ElementType; cls: string }> = {
    pass: { Icon: CheckCircle2, cls: 'text-success' },
    warn: { Icon: AlertTriangle, cls: 'text-warning' },
    fail: { Icon: XCircle, cls: 'text-danger' },
  };
  const { Icon, cls } = meta[check.status] ?? { Icon: AlertTriangle, cls: 'text-dim-soft' };
  return (
    <div className="flex items-start gap-3 border-b border-border-subtle bg-surface-2/40 px-4 py-3 last:border-b-0">
      <Icon size={14} className={clsx('mt-0.5 shrink-0', cls)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12.5px] text-text">{check.name}</span>
          <span
            className={clsx(
              'rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.05em]',
              check.status === 'pass' && 'bg-success/15 text-success',
              check.status === 'warn' && 'bg-warning/15 text-warning',
              check.status === 'fail' && 'bg-danger/15 text-danger',
            )}
          >
            {check.status}
          </span>
        </div>
        {check.message && (
          <div className="mt-0.5 text-[11.5px] text-dim-soft">{check.message}</div>
        )}
        {check.fix && check.status !== 'pass' && (
          <div className="mt-1 flex items-start gap-1.5 rounded bg-surface-3/40 px-2 py-1 text-[11px] text-text-soft">
            <Wrench size={10} className="mt-0.5 shrink-0 text-dim-soft" />
            <span>{check.fix}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Stacks tab ────────────────────────────────────────────────────────

function StacksTab(): React.ReactElement {
  // Mantemos o report local: o handler `runDoctor` é caro (npm install +
  // build + possível auto-fix), nunca dispara automaticamente. O usuário
  // clica e o estado é guardado até a próxima rodada.
  const [report, setReport] = React.useState<DoctorReportDTO | null>(null);
  const [armedFix, setArmedFix] = React.useState(false);

  React.useEffect(() => {
    if (!armedFix) return;
    const t = setTimeout(() => setArmedFix(false), 5_000);
    return () => clearTimeout(t);
  }, [armedFix]);

  const detectMut = useMutation({
    mutationFn: () => doctorApi.run({ skipFix: true, maxPasses: 1 }),
    onSuccess: (r) => {
      setReport(r);
      if (r.stacks.length === 0) {
        toast.error('Nenhum stack detectado neste cwd');
      } else {
        toast.success(`${r.stacks.length} stack(s) detectado(s)`);
      }
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });
  const runMut = useMutation({
    mutationFn: (opts: DoctorRunOptionsDTO) => doctorApi.run(opts),
    onSuccess: (r) => {
      setReport(r);
      toast.success(r.passed ? 'Doctor: tudo passou' : `Doctor: ${r.finalResults.filter((x) => !x.success).length} falha(s)`);
    },
    onError: (e: any) => toast.error(`Falha: ${e?.message ?? e}`),
  });

  const isRunning = detectMut.isPending || runMut.isPending;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
        <div className="flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div>
            <strong>Doctor stack-runner</strong> executa <code className="rounded bg-warning/15 px-1 font-mono text-[11px]">npm install</code>,{' '}
            <code className="rounded bg-warning/15 px-1 font-mono text-[11px]">docker compose up -d</code> e{' '}
            <code className="rounded bg-warning/15 px-1 font-mono text-[11px]">npm run start</code> nos stacks detectados — pode levar 1-5min cada. Auto-fix
            invoca a CLI de IA escolhida e consome tokens.
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => detectMut.mutate()}
          disabled={isRunning}
          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text-soft hover:bg-surface-3 disabled:opacity-60"
        >
          {detectMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
          Detectar stacks
        </button>
        <button
          type="button"
          onClick={() => runMut.mutate({ skipFix: true, maxPasses: 1 })}
          disabled={isRunning || !report || report.stacks.length === 0}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-60"
        >
          {runMut.isPending && !armedFix ? <Loader2 size={12} className="animate-spin" /> : <Play size={11} fill="currentColor" />}
          Rodar checks (sem fix)
        </button>
        <button
          type="button"
          onClick={() => {
            if (armedFix) {
              setArmedFix(false);
              runMut.mutate({ cli: 'claude', maxPasses: 3 });
            } else {
              setArmedFix(true);
            }
          }}
          disabled={isRunning || !report || report.stacks.length === 0}
          className={clsx(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] disabled:opacity-60',
            armedFix
              ? 'border-danger bg-danger/15 text-danger'
              : 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/15',
          )}
          title={armedFix ? 'Clique de novo pra confirmar — vai consumir tokens' : 'Roda doctor com auto-fix via CLI de IA'}
        >
          <Wrench size={12} />
          {armedFix ? 'Confirmar auto-fix' : 'Auto-fix com claude'}
        </button>
      </div>

      {report && (
        <Section title={`Stacks detectados · ${report.stacks.length}`}>
          {report.stacks.length === 0 ? (
            <div className="rounded-md border border-dashed border-border-soft px-4 py-6 text-center text-[12px] text-dim/70">
              Nenhum stack — verifique se o cwd tem subpastas <code>api/</code>, <code>web/</code> ou <code>app/</code>.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {report.stacks.map((s, i) => (
                <div key={i} className="rounded-md border border-border-subtle bg-surface-2/40 p-3">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim/80">
                    {s.type}
                  </div>
                  <div className="mt-0.5 font-mono text-[12.5px] text-text">{s.label}</div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-dim-soft">{s.dir}</div>
                  {s.framework && (
                    <div className="mt-1 inline-block rounded bg-secondary/15 px-1.5 py-0.5 font-mono text-[10px] text-secondary">
                      {s.framework}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {report && report.finalResults.length > 0 && (
        <Section title={`Resultados — pass ${report.passes}`}>
          <div className="space-y-2">
            {report.finalResults.map((r, i) => <StackResultCard key={i} result={r} />)}
          </div>
        </Section>
      )}
    </div>
  );
}

function StackResultCard({ result }: { result: DoctorCheckDTO }): React.ReactElement {
  const Icon = result.success ? CheckCircle2 : XCircle;
  const cls = result.success ? 'text-success' : 'text-danger';
  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/40 p-3">
      <div className="flex items-center gap-2">
        <Icon size={14} className={cls} />
        <span className="font-mono text-[12.5px] text-text">{result.label}</span>
        <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-dim-soft">
          {result.phase}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-dim/70">
          {Math.round(result.durationMs / 1000)}s
        </span>
      </div>
      {result.errors.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11.5px] text-danger">
            {result.errors.length} erro(s) — clique pra ver
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-danger">
            {result.errors.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}
