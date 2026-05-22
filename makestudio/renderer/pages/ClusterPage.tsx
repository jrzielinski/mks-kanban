import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Network, RefreshCw, Shield, ShieldCheck, ShieldX, Clock,
  AlertTriangle, CheckCircle2, XCircle, ToggleLeft, ToggleRight, Wifi
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from '../lib/clientToast';
import { clusterApi } from '../ipc/client';
import type { ClusterSnapshotDTO, ClusterPeerDTO, ClusterTrustSetRequestDTO } from '@shared/types';

// ── Swim state badge ──────────────────────────────────────────────────────

function SwimBadge({ state }: { state: ClusterPeerDTO['swimState'] }) {
  const map = {
    alive:   { icon: <CheckCircle2 size={11} />, label: 'alive',   cls: 'text-success bg-success/10' },
    suspect: { icon: <AlertTriangle size={11} />, label: 'suspect', cls: 'text-warning bg-warning/10' },
    faulty:  { icon: <XCircle size={11} />,      label: 'faulty',  cls: 'text-error bg-error/10' },
    unknown: { icon: <Clock size={11} />,         label: 'unknown', cls: 'text-dim bg-surface-2' },
  };
  const s = map[state] ?? map.unknown;
  return (
    <span className={clsx('flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium', s.cls)}>
      {s.icon} {s.label}
    </span>
  );
}

// ── Trust toggle button ───────────────────────────────────────────────────

function TrustToggle({
  peerId, field, value, onToggle,
}: { peerId: string; field: 'allowBash' | 'allowWrite'; value: boolean; onToggle: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!value)}
      title={`${field}: ${value ? 'permitido' : 'negado'}`}
      className={clsx('transition-colors', value ? 'text-success' : 'text-dim hover:text-text-soft')}
    >
      {value ? <ShieldCheck size={14} /> : <ShieldX size={14} />}
    </button>
  );
}

// ── Peer detail row ───────────────────────────────────────────────────────

function PeerRow({
  peer,
  trust,
  onSyncNow,
  onTrustChange,
}: {
  peer: ClusterPeerDTO;
  trust: { allowBash: boolean; allowWrite: boolean } | undefined;
  onSyncNow: () => void;
  onTrustChange: (req: ClusterTrustSetRequestDTO) => void;
}) {
  const allowBash = trust?.allowBash ?? false;
  const allowWrite = trust?.allowWrite ?? false;
  const [syncing, setSyncing] = React.useState(false);

  function handleSync() {
    setSyncing(true);
    onSyncNow();
    setTimeout(() => setSyncing(false), 2000);
  }

  function lastSeen(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return `${Math.round(diff / 1000)}s atrás`;
    if (diff < 3600_000) return `${Math.round(diff / 60_000)}min atrás`;
    return `${Math.round(diff / 3600_000)}h atrás`;
  }

  return (
    <tr className="border-t border-border-subtle">
      <td className="px-4 py-3">
        <div className="font-mono text-[11px] text-text">{peer.peerId.slice(0, 16)}…</div>
        {peer.hostname && <div className="text-[10px] text-dim">{peer.hostname}</div>}
      </td>
      <td className="px-4 py-3">
        <SwimBadge state={peer.swimState} />
      </td>
      <td className="px-4 py-3">
        <span className="font-mono text-[11px] text-text-soft">
          {peer.address ?? '—'}{peer.wsPort ? `:${peer.wsPort}` : ''}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        {peer.latencyMs != null ? (
          <span className={clsx('text-[11px]', peer.latencyMs < 50 ? 'text-success' : peer.latencyMs < 200 ? 'text-warning' : 'text-error')}>
            {peer.latencyMs}ms
          </span>
        ) : <span className="text-dim text-[11px]">—</span>}
      </td>
      <td className="px-4 py-3 text-[11px] text-dim">{lastSeen(peer.lastSeen)}</td>
      <td className="px-4 py-3 text-[11px] text-dim">
        {peer.lastSyncAt ? lastSeen(peer.lastSyncAt) : '—'}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="text-[9px] uppercase tracking-wider text-dim">bash</span>
            <TrustToggle peerId={peer.peerId} field="allowBash" value={allowBash}
              onToggle={v => onTrustChange({ peerId: peer.peerId, global: { allowBash: v, allowWrite } })} />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[9px] uppercase tracking-wider text-dim">write</span>
            <TrustToggle peerId={peer.peerId} field="allowWrite" value={allowWrite}
              onToggle={v => onTrustChange({ peerId: peer.peerId, global: { allowBash, allowWrite: v } })} />
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        <button type="button" onClick={handleSync} disabled={syncing || peer.swimState !== 'alive'}
          title="Sincronizar memória agora"
          className="rounded p-1 text-dim hover:text-text disabled:opacity-30">
          <RefreshCw size={12} className={clsx(syncing && 'animate-spin')} />
        </button>
      </td>
    </tr>
  );
}

// ── Config panel ───────────────────────────────────────────────────────────

function ConfigPanel({ snap }: { snap: ClusterSnapshotDTO }) {
  const qc = useQueryClient();
  const [port, setPort] = React.useState(String(snap.listenPort));
  const [group, setGroup] = React.useState(snap.multicastGroup);

  const enableMut = useMutation({
    mutationFn: (enable: boolean) => clusterApi.enable(enable),
    onSuccess: (res) => {
      if (res.ok) { toast.success(snap.enabled ? 'Cluster desativado' : 'Cluster ativado'); qc.invalidateQueries({ queryKey: ['cluster'] }); }
      else toast.error(res.error ?? 'Falha');
    },
  });

  const saveMut = useMutation({
    mutationFn: () => {
      const portNum = parseInt(port, 10);
      if (!Number.isInteger(portNum) || portNum < 1024 || portNum > 65535) {
        return Promise.reject(new Error('Porta deve ser um número entre 1024 e 65535'));
      }
      return clusterApi.setConfig({ listenPort: portNum, multicastGroup: group });
    },
    onSuccess: (res: any) => {
      if (res?.ok === false) { toast.error(res.error ?? 'Falha ao salvar'); return; }
      toast.success('Configuração salva');
      qc.invalidateQueries({ queryKey: ['cluster'] });
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-[13px] font-semibold text-text">Cluster P2P</div>
          <div className="text-[11px] text-dim">Sincronização de memórias entre máquinas da equipe</div>
        </div>
        <button type="button" onClick={() => enableMut.mutate(!snap.enabled)}
          disabled={enableMut.isPending}
          className={clsx('flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors',
            snap.enabled ? 'bg-success/15 text-success hover:bg-success/25' : 'bg-surface-3 text-dim hover:text-text')}>
          {snap.enabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
          {snap.enabled ? 'Ativo' : 'Inativo'}
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4">
        <div className="rounded-md bg-surface-2 p-3">
          <div className="text-[9px] uppercase tracking-wider text-dim">Peer ID</div>
          <div className="mt-0.5 break-all font-mono text-[10px] text-text-soft">{snap.selfPeerId}</div>
        </div>
        <div className="rounded-md bg-surface-2 p-3">
          <div className="text-[9px] uppercase tracking-wider text-dim">Chave pública</div>
          <div className="mt-0.5 break-all font-mono text-[10px] text-text-soft">{snap.selfPubkey?.slice(0, 40) ?? '—'}…</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-soft">Porta (TCP/UDP)</label>
          <input type="number" min={1024} max={65535} value={port} onChange={e => setPort(e.target.value)}
            className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] text-text outline-none focus:border-primary" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-text-soft">Multicast group</label>
          <input value={group} onChange={e => setGroup(e.target.value)}
            className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[12px] text-text outline-none focus:border-primary" />
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <button type="button" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-surface-0 hover:bg-primary-soft disabled:opacity-50">
          Salvar
        </button>
      </div>
    </div>
  );
}

// ── Stats strip ───────────────────────────────────────────────────────────

function StatsStrip({ snap }: { snap: ClusterSnapshotDTO }) {
  const stats = [
    { label: 'Alive', value: snap.swimStats.alive, cls: 'text-success' },
    { label: 'Suspect', value: snap.swimStats.suspect, cls: 'text-warning' },
    { label: 'Faulty', value: snap.swimStats.faulty, cls: 'text-error' },
    { label: 'Pings', value: snap.swimStats.pings, cls: 'text-text-soft' },
    { label: 'SWIM', value: snap.swimRunning ? 'on' : 'off', cls: snap.swimRunning ? 'text-success' : 'text-dim' },
    { label: 'Auto-sync', value: snap.autoSyncRunning ? 'on' : 'off', cls: snap.autoSyncRunning ? 'text-success' : 'text-dim' },
    { label: 'Último sync', value: snap.lastSyncAt ? new Date(snap.lastSyncAt).toLocaleTimeString() : '—', cls: 'text-text-soft' },
  ];
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 py-2">
      {stats.map(s => (
        <div key={s.label} className="flex items-baseline gap-1.5">
          <span className="text-[9px] uppercase tracking-wider text-dim">{s.label}</span>
          <span className={clsx('text-[13px] font-semibold tabular-nums', s.cls)}>{s.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function ClusterPage(): React.ReactElement {
  const qc = useQueryClient();

  const snapQ = useQuery<ClusterSnapshotDTO>({
    queryKey: ['cluster', 'snapshot'],
    queryFn: () => clusterApi.snapshot(),
    refetchInterval: 8_000,
    staleTime: 4_000,
  });

  const trustMut = useMutation({
    mutationFn: (req: ClusterTrustSetRequestDTO) => clusterApi.trustSet(req),
    onSuccess: () => { toast.success('Trust atualizado'); qc.invalidateQueries({ queryKey: ['cluster'] }); },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  const syncMut = useMutation({
    mutationFn: (peerId: string) => clusterApi.syncNow(peerId),
    onSuccess: (res) => {
      if (res.ok) toast.success(`Sync concluído · ${res.pulled ?? 0} entradas`);
      else toast.error(res.error ?? 'Falha no sync');
      qc.invalidateQueries({ queryKey: ['cluster'] });
    },
    onError: (e: any) => toast.error(e?.message ?? String(e)),
  });

  React.useEffect(() => {
    const off = clusterApi.onPeersUpdate(() => {
      qc.invalidateQueries({ queryKey: ['cluster', 'snapshot'] });
    });
    return off;
  }, [qc]);

  const snap = snapQ.data;

  const trustMap = React.useMemo(() => {
    const m = new Map<string, { allowBash: boolean; allowWrite: boolean }>();
    if (snap) {
      for (const t of snap.trust) m.set(t.peerId, t.global);
    }
    return m;
  }, [snap]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <Network size={16} className="text-primary" />
          <h1 className="text-[18px] font-semibold text-text">Cluster</h1>
          {snap && snap.peers.length > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-dim">
              <Wifi size={11} />
              {snap.swimStats.alive}/{snap.peers.length} peers
            </span>
          )}
        </div>
        <button type="button" onClick={() => qc.invalidateQueries({ queryKey: ['cluster'] })}
          className="rounded p-1.5 text-dim hover:text-text">
          <RefreshCw size={13} className={clsx(snapQ.isFetching && 'animate-spin')} />
        </button>
      </header>

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="flex flex-col gap-6">
          {snap && <ConfigPanel snap={snap} />}

          {snap && (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <Shield size={13} className="text-dim" />
                <span className="text-[12px] font-medium text-text-soft">Status da rede</span>
              </div>
              <StatsStrip snap={snap} />
            </div>
          )}

          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Network size={13} className="text-dim" />
                <span className="text-[12px] font-medium text-text-soft">Peers descobertos</span>
              </div>
              <span className="text-[11px] text-dim">{snap?.peers.length ?? 0} peer(s)</span>
            </div>

            {(!snap || snap.peers.length === 0) && (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border-subtle py-12 text-center">
                <Network size={28} className="text-dim/40" />
                <p className="text-[13px] text-dim">Nenhum peer detectado</p>
                <p className="text-[11px] text-dim/60">
                  {snap?.enabled
                    ? 'Aguardando peers na rede local…'
                    : 'Ative o cluster para começar a descobrir peers'}
                </p>
              </div>
            )}

            {snap && snap.peers.length > 0 && (
              <div className="overflow-hidden rounded-md border border-border-subtle">
                <table className="w-full">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Peer</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Estado</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Endereço</th>
                      <th className="px-4 py-2.5 text-center text-[10px] font-medium uppercase tracking-wider text-dim">Latência</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Visto</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Sync</th>
                      <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-dim">Trust</th>
                      <th className="w-[50px] px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {snap.peers.map(p => (
                      <PeerRow
                        key={p.peerId}
                        peer={p}
                        trust={trustMap.get(p.peerId)}
                        onSyncNow={() => syncMut.mutate(p.peerId)}
                        onTrustChange={req => trustMut.mutate(req)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
