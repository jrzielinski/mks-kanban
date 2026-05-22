import React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Shield, ShieldAlert, RefreshCw, Download, ChevronDown, ChevronUp, AlertTriangle, Info } from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { securityApi } from '../ipc/client';
import type { SecurityReviewDTO, SecurityIssueDTO } from '@shared/types';

const SEV_STYLES: Record<SecurityIssueDTO['severity'], { bg: string; text: string; border: string }> = {
  High:   { bg: 'bg-error/10',   text: 'text-error',   border: 'border-error/40' },
  Medium: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/40' },
  Low:    { bg: 'bg-dim/10',     text: 'text-dim',     border: 'border-dim/30' },
};

function SeverityBadge({ sev }: { sev: SecurityIssueDTO['severity'] }) {
  const s = SEV_STYLES[sev];
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', s.bg, s.text)}>
      {sev}
    </span>
  );
}

function IssueRow({ issue }: { issue: SecurityIssueDTO }) {
  const [expanded, setExpanded] = React.useState(false);
  const s = SEV_STYLES[issue.severity];

  return (
    <div className={clsx('rounded-md border p-3 mb-2', s.border, s.bg + '/20')}>
      <div className="flex items-start gap-3 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <SeverityBadge sev={issue.severity} />
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-text line-clamp-2">{issue.description}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-dim">{issue.category}</span>
            {issue.file && <span className="font-mono text-[10px] text-dim">{issue.file}{issue.line ? `:${issue.line}` : ''}</span>}
            <span className="text-[10px] text-dim ml-auto">conf: {(issue.confidence * 100).toFixed(0)}%</span>
          </div>
        </div>
        {expanded ? <ChevronUp size={13} className="text-dim shrink-0" /> : <ChevronDown size={13} className="text-dim shrink-0" />}
      </div>
      {expanded && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-2">
          {issue.exploit && (
            <div>
              <p className="text-[10px] font-medium text-text-soft mb-0.5">Exploit</p>
              <p className="text-[11px] text-text">{issue.exploit}</p>
            </div>
          )}
          <div>
            <p className="text-[10px] font-medium text-text-soft mb-0.5">Recomendação</p>
            <p className="text-[11px] text-text">{issue.recommendation}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function SecurityReviewPage(): React.ReactElement {
  const [cli, setCli] = React.useState('claude');
  const [base, setBase] = React.useState('');
  const [filter, setFilter] = React.useState<'all' | 'High' | 'Medium' | 'Low'>('all');
  const [result, setResult] = React.useState<SecurityReviewDTO | null>(null);

  const scanMut = useMutation({
    mutationFn: () => securityApi.run({ cli, base: base.trim() || undefined }),
    onSuccess: (data) => {
      setResult(data);
      const total = data.summary.high + data.summary.medium + data.summary.low;
      if (total === 0) toast.success('Nenhuma vulnerabilidade detectada');
      else toast.warn(`${total} vulnerabilidade(s) detectada(s)`);
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  const issues = result?.issues ?? [];
  const filtered = filter === 'all' ? issues : issues.filter((i) => i.severity === filter);

  function exportJson() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `security-review-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportMarkdown() {
    if (!result?.reportPath) return;
    toast.info(`Relatório salvo em: ${result.reportPath}`);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <Shield size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Security Review</h1>
        </div>
        {result && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={exportMarkdown}
              className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-soft hover:text-text flex items-center gap-1">
              <Download size={11} /> MD
            </button>
            <button type="button" onClick={exportJson}
              className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-soft hover:text-text flex items-center gap-1">
              <Download size={11} /> JSON
            </button>
          </div>
        )}
      </header>

      {/* Config panel */}
      <div className="border-b border-border-subtle bg-surface-2/40 px-6 py-4">
        <div className="flex items-start gap-3 mb-3">
          <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
          <p className="text-[12px] text-text-soft">
            O security review envia o diff completo do repositório para um LLM.
            Pode levar vários minutos. Não usar em repositórios com dados sensíveis sem política de privacidade com o provedor.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-soft">CLI</label>
            <select value={cli} onChange={e => setCli(e.target.value)}
              className="rounded-md border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-[12px] text-text outline-none focus:border-primary">
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="gemini">gemini</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-soft">Base ref (opcional)</label>
            <input value={base} onChange={e => setBase(e.target.value)} placeholder="origin/main"
              className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary w-[180px]" />
          </div>
          <button type="button" onClick={() => scanMut.mutate()} disabled={scanMut.isPending}
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-50">
            {scanMut.isPending ? <RefreshCw size={12} className="animate-spin" /> : <Shield size={12} />}
            {scanMut.isPending ? 'Analisando…' : 'Run scan'}
          </button>
        </div>
      </div>

      {/* Loading state */}
      {scanMut.isPending && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <RefreshCw size={28} className="text-primary animate-spin" />
          <p className="text-[13px] text-text-soft">Executando security review…</p>
          <p className="text-[11px] text-dim">Isso pode levar vários minutos dependendo do tamanho do diff</p>
        </div>
      )}

      {/* Results */}
      {!scanMut.isPending && result && (
        <div className="flex-1 overflow-auto px-6 py-5">
          {/* Summary strip */}
          <div className="mb-5 flex items-center gap-4 rounded-md border border-border-subtle bg-surface-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <ShieldAlert size={16} className={result.summary.high > 0 ? 'text-error' : 'text-success'} />
              <span className="text-[13px] font-medium text-text">
                {result.issues.length === 0 ? 'Sem vulnerabilidades detectadas' : `${result.issues.length} vulnerabilidade(s)`}
              </span>
            </div>
            <div className="flex items-center gap-3 ml-auto text-[11px]">
              {result.summary.high > 0 && <span className="text-error font-medium">HIGH: {result.summary.high}</span>}
              {result.summary.medium > 0 && <span className="text-warning">MED: {result.summary.medium}</span>}
              {result.summary.low > 0 && <span className="text-dim">LOW: {result.summary.low}</span>}
              <span className="text-dim">{(result.durationMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          {/* Filter pills */}
          {result.issues.length > 0 && (
            <div className="mb-4 flex items-center gap-2">
              {(['all', 'High', 'Medium', 'Low'] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)}
                  className={clsx('rounded-md px-2.5 py-1 text-[11px] transition-colors',
                    filter === f ? 'bg-primary/10 text-primary' : 'text-dim hover:text-text')}>
                  {f === 'all' ? 'Todos' : f}
                  {f !== 'all' && ` (${result.summary[f.toLowerCase() as 'high' | 'medium' | 'low']})`}
                </button>
              ))}
            </div>
          )}

          {/* Issues list */}
          {filtered.length === 0 && result.issues.length > 0 && (
            <p className="text-center text-[13px] text-dim py-6">Nenhum resultado para o filtro selecionado</p>
          )}
          {filtered.map((issue) => <IssueRow key={issue.id} issue={issue} />)}

          {result.truncated && (
            <div className="flex items-center gap-2 mt-4 rounded-md border border-warning/30 bg-warning/10 px-4 py-3">
              <Info size={13} className="text-warning shrink-0" />
              <p className="text-[12px] text-warning">Diff truncado em 120 KB — review incompleto. Use base ref mais recente.</p>
            </div>
          )}
        </div>
      )}

      {!scanMut.isPending && !result && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <Shield size={40} className="text-dim/30" />
          <p className="text-[13px] text-dim">Configure e execute o scan para ver os resultados</p>
        </div>
      )}
    </div>
  );
}
