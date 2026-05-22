import * as React from 'react';
import { Box, Text, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { ReplContext } from '../context';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { colors: themeColors } = require('../theme');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadSettings } = require('../settings');

const SCANNER_FACE  = ['░', '▒', '▓', '█', '▓', '▒', '░'] as const;
const SCANNER_WIDTH = SCANNER_FACE.length;  // 7
const SCANNER_BG    = '·';
const SCANNER_TOTAL = 22;  // visible chars in the bar (~30% narrower than original 32)
const SCANNER_RANGE = SCANNER_TOTAL - SCANNER_WIDTH;  // 15
const SCANNER_MS    = 60;  // ms per frame → full sweep ≈ 3s

function buildScannerFrame(frame: number, primaryHex: string, dimHex: string): React.ReactElement {
  // Bounce: frame goes 0→RANGE→0→RANGE...
  const period = SCANNER_RANGE * 2;
  const t = frame % period;
  const pos = t <= SCANNER_RANGE ? t : period - t;

  const chars: React.ReactElement[] = [];
  for (let i = 0; i < SCANNER_TOTAL; i++) {
    const scanIdx = i - pos;
    if (scanIdx >= 0 && scanIdx < SCANNER_WIDTH) {
      chars.push(
        <Text key={i} color={primaryHex}>{SCANNER_FACE[scanIdx]}</Text>,
      );
    } else {
      chars.push(
        <Text key={i} color={dimHex}>{SCANNER_BG}</Text>,
      );
    }
  }
  return <>{chars}</>;
}

function KittScanner({ busy, primaryHex, dimHex }: { busy: boolean; primaryHex: string; dimHex: string }): React.ReactElement | null {
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    if (!busy) { setFrame(0); return; }
    const id = setInterval(() => setFrame((f) => f + 1), SCANNER_MS);
    return () => clearInterval(id);
  }, [busy]);

  if (!busy) return null;
  return (
    <Box>
      {buildScannerFrame(frame, primaryHex, dimHex)}
    </Box>
  );
}

interface StatusLineProps {
  ctx: ReplContext;
  busy: boolean;
  busyLabel: string;
  /** Seconds since busy flipped true. Only used while `busy`. */
  elapsedSec: number;
  /** Live estimate of output tokens streamed so far this turn. */
  streamTokens: number;
  contextPct: number;
  msgsCount: number;
  totalTokens: number;
  /** Session-cumulative input tokens sent to the LLM (↑ uplink). For
   *  Anthropic this includes fresh + cache_read + cache_write. */
  sessionPromptTokens: number;
  /** Session-cumulative output tokens received from the LLM (↓ downlink). */
  sessionCompletionTokens: number;
  /** Session-cumulative cache_read tokens — used to render the `(Y% cache)`
   *  ratio alongside the ↑ figure so the user sees how much of the input
   *  was billed at the cheap rate. */
  sessionCacheReads: number;
  cacheReads: number;
  todos?: { total: number; done: number; inProgress?: string };
  /** Incremented whenever coordinator state mutates so memo comparator can detect the change. */
  coordinatorTick: number;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/** Compact a token count into 1.4M / 97.6k / 850 — same scale as
 *  `tokens` field in many cloud dashboards. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return String(n);
}

function buildCoordinatorSummary(ctx: ReplContext): string | null {
  if (!ctx.coordinatorActive) return null;
  if (ctx.coordinatorMonitor === 'silent') return null;

  let running = 0;
  let done = 0;
  let failed = 0;
  let totalTokens = 0;

  for (const w of ctx.coordinatorWorkers.values()) {
    if (w.status === 'running') running++;
    else if (w.status === 'done') done++;
    else failed++; // 'failed' | 'timeout'
    totalTokens += w.tokens?.total || 0;
  }

  const parts: string[] = [];
  if (running > 0) parts.push(`${running}~`);
  if (done > 0) parts.push(`${done}v`);
  if (failed > 0) parts.push(`${failed}!`);

  const counts = parts.length > 0 ? parts.join(' ') : 'idle';
  const sessionShort = ctx.coordinatorSessionId
    ? ctx.coordinatorSessionId.slice(0, 8)
    : '';
  const tokenSuffix = totalTokens > 0
    ? ` · ${totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + 'k' : String(totalTokens)} tok`
    : '';
  return sessionShort
    ? `coord[${sessionShort}] ${counts}${tokenSuffix}`
    : `coord ${counts}${tokenSuffix}`;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function StatusLineImpl({ ctx, busy, busyLabel, elapsedSec, streamTokens, contextPct, msgsCount, totalTokens, sessionPromptTokens, sessionCompletionTokens, sessionCacheReads, cacheReads, todos, coordinatorTick: _coordinatorTick }: StatusLineProps): React.ReactElement {
  const { stdout } = useStdout();
  const palette = themeColors();
  const settings = loadSettings();
  const enabledFields = settings.statusline.fields as string[];

  // Subscribe to transient status changes so housekeeping events
  // (microCompact freed X chars, auto-sync pulled Y topics, etc) show up
  // on the StatusLine rather than as a floating toast. Render-state is
  // a plain string kept in sync via the bridge's pub/sub hook.
  const [transient, setTransient] = React.useState<string | null>(null);
  React.useEffect(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getTransientStatus, subscribeTransientStatus } = require('./bridge');
      setTransient(getTransientStatus());
      return subscribeTransientStatus(() => setTransient(getTransientStatus()));
    } catch { /* bridge may not be present — no-op */ }
    return undefined;
  }, []);

  const pctColor = contextPct > 80
    ? palette.danger
    : contextPct > 50
      ? palette.warning
      : palette.success;

  const showTodos = todos && todos.total > 0;

  // Render each configured field in order. Unknown fields silently skipped.
  const fieldElements: React.ReactElement[] = [];
  let first = true;
  const sep = () => {
    if (first) { first = false; return null; }
    return <Text key={`sep-${fieldElements.length}`} color={palette.dim}>{' · '}</Text>;
  };

  for (const field of enabledFields) {
    switch (field) {
      case 'msgs':
        fieldElements.push(
          <React.Fragment key="msgs">
            {sep()}
            <Text color={palette.dim}>{`${msgsCount} msgs`}</Text>
          </React.Fragment>,
        );
        break;
      case 'ctx':
        fieldElements.push(
          <React.Fragment key="ctx">
            {sep()}
            <Text color={pctColor}>{`${contextPct.toFixed(0)}% ctx`}</Text>
          </React.Fragment>,
        );
        break;
      case 'tokens': {
        // Cumulative session flow — NOT the last request. We spell out
        // "sess" because users kept reading ↑/↓ as per-turn usage when a
        // single agent turn can fan out into many LLM round-trips.
        //
        // The ↑ figure shows ONLY fresh (non-cache) input — cache reads
        // are billed at ~10% of the normal rate, so adding them into the
        // headline number makes the spend look 5-10× larger than it
        // really is. We show cached separately as `(Xk cached)` so the
        // user still sees how much of the input bypassed cache. When
        // there's no cache activity at all, fall back to raw ↑total.
        const fresh = Math.max(0, sessionPromptTokens - sessionCacheReads);
        const showCached = sessionCacheReads > 0;
        fieldElements.push(
          <React.Fragment key="tokens">
            {sep()}
            <Text color={palette.dim}>{'sess '}</Text>
            <Text color={palette.dim}>{'↑'}</Text>
            <Text color={palette.fg}>{compactTokens(showCached ? fresh : sessionPromptTokens)}</Text>
            {showCached ? (
              <Text color={palette.dim}>{` (${compactTokens(sessionCacheReads)} cached)`}</Text>
            ) : null}
            <Text color={palette.dim}>{' ↓'}</Text>
            <Text color={palette.success}>{compactTokens(sessionCompletionTokens)}</Text>
          </React.Fragment>,
        );
        break;
      }
      case 'cache':
        if (cacheReads > 0) {
          fieldElements.push(
            <React.Fragment key="cache">
              {sep()}
              <Text color={palette.success}>{`${cacheReads.toLocaleString()} cache`}</Text>
            </React.Fragment>,
          );
        }
        break;
      case 'cost': {
        // Live cost estimate (USD). Uses the central pricing table from
        // commands.ts so we don't duplicate rates. Model unknown → falls
        // back to 0; we hide the field rather than display "$0" which
        // would look like "free" when it's actually "no pricing data".
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { estimateCost } = require('../commands');
          const model = ctx.providerInfo?.model || '';
          const cost = estimateCost(model, sessionPromptTokens, sessionCompletionTokens);
          if (cost > 0) {
            const txt = cost >= 1
              ? `$${cost.toFixed(2)}`
              : cost >= 0.01 ? `¢${(cost * 100).toFixed(1)}` : `${(cost * 100_000).toFixed(0)}µ$`;
            const color = cost >= 1 ? palette.warning : palette.dim;
            fieldElements.push(
              <React.Fragment key="cost">
                {sep()}
                <Text color={color}>{txt}</Text>
              </React.Fragment>,
            );
          }
        } catch { /* */ }
        break;
      }
      case 'model':
        if (ctx.providerInfo?.model) {
          fieldElements.push(
            <React.Fragment key="model">
              {sep()}
              <Text color={palette.primary}>{ctx.providerInfo.model}</Text>
            </React.Fragment>,
          );
        }
        break;
      case 'cwd': {
        const short = ctx.cwd.length > 30 ? '…' + ctx.cwd.slice(-27) : ctx.cwd;
        fieldElements.push(
          <React.Fragment key="cwd">
            {sep()}
            <Text color={palette.dim}>{short}</Text>
          </React.Fragment>,
        );
        break;
      }
      case 'todos': {
        if (showTodos) {
          fieldElements.push(
            <React.Fragment key="todos">
              {sep()}
              <Text color={palette.accent}>{`todos ${todos!.done}/${todos!.total}`}</Text>
            </React.Fragment>,
          );
        }
        break;
      }
      case 'rules': {
        if (ctx.importedRules) {
          fieldElements.push(
            <React.Fragment key="rules">
              {sep()}
              <Text color={palette.success}>{'rules'}</Text>
            </React.Fragment>,
          );
        }
        break;
      }
      case 'perms': {
        if (ctx.autoApprove) {
          fieldElements.push(
            <React.Fragment key="perms">
              {sep()}
              <Text color={palette.warning} bold>{'bypass'}</Text>
            </React.Fragment>,
          );
        }
        break;
      }
      case 'mode': {
        // PermissionMode badge — only shows when not 'default'. Color hints
        // at danger level: bypassPermissions (red) > plan (yellow) > else cyan.
        const pm = settings.permissionMode;
        if (pm && pm !== 'default') {
          const c = pm === 'bypassPermissions' ? palette.danger
                  : pm === 'plan' ? palette.warning
                  : palette.primary;
          fieldElements.push(
            <React.Fragment key="mode">
              {sep()}
              <Text color={c}>{`mode:${pm}`}</Text>
            </React.Fragment>,
          );
        }
        break;
      }
      case 'style': {
        // OutputStyle badge — only shows when not 'default'.
        const os = settings.outputStyle;
        if (os && os !== 'default') {
          fieldElements.push(
            <React.Fragment key="style">
              {sep()}
              <Text color={palette.accent}>{`style:${os}`}</Text>
            </React.Fragment>,
          );
        }
        break;
      }
      // 'status' is rendered separately on the left; skip here
      case 'status':
      default:
        break;
    }
  }

  const coordinatorSummary = buildCoordinatorSummary(ctx);

  // Cluster peer count (when discovery is enabled). Stays silent when the
  // feature is off so users who never opt-in don't see anything new.
  const clusterSummary = (() => {
    try {
      const { isDiscoveryRunning, listPeers } = require('../cluster/discovery');
      if (!isDiscoveryRunning?.()) return null;
      const peers = listPeers?.() || [];
      // Number of reverse-dispatched worker runs this machine is servicing
      // for peers right now. Without surfacing this, the user sees their
      // computer burn CPU/tokens and can't tell why.
      let serving = 0;
      try {
        const { getClusterServingCount } = require('../cluster/client');
        serving = getClusterServingCount?.() || 0;
      } catch { /* */ }
      const base = peers.length === 0
        ? 'cluster: alone'
        : `cluster: ${peers.length} peer${peers.length === 1 ? '' : 's'}`;
      return serving > 0 ? `${base} · ${serving} serving` : base;
    } catch { return null; }
  })();

  return (
    <Box flexDirection="column">
      {transient ? (
        // Short-lived housekeeping note (microCompact, auto-sync, etc).
        // Dim + muted so it doesn't compete with the busy/ready status
        // below. Auto-clears after the ttl set by the caller.
        <Box paddingX={1}>
          <Text color={palette.dim}>{'↳ '}</Text>
          <Text color={palette.dim}>{transient}</Text>
        </Box>
      ) : null}
      {showTodos && todos!.inProgress ? (
        <Box paddingX={1}>
          <Text color={palette.accent}>{`todos ${todos!.done}/${todos!.total}`}</Text>
          <Text color={palette.dim}>{`  · ${todos!.inProgress}`}</Text>
        </Box>
      ) : null}
      <Box justifyContent="space-between" paddingX={1}>
        <Box>
          {coordinatorSummary ? (
            <>
              <Text color={palette.accent}>{coordinatorSummary}</Text>
              <Text color={palette.dim}>{' · '}</Text>
            </>
          ) : null}
          {clusterSummary ? (
            <>
              <Text color={palette.accent}>{clusterSummary}</Text>
              <Text color={palette.dim}>{' · '}</Text>
            </>
          ) : null}
          {enabledFields.includes('status') && busy ? (
            <>
              <Text color={palette.primary}>
                <Spinner type="dots" />
              </Text>
              {(() => {
                // Priority: currentTool (live) > lastTool (persisted) > agentSummary > busyLabel
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const bridge = require('./bridge');
                let agentSummary: string | null = null;
                let currentTool: string | null = null;
                let lastTool: string | null = null;
                try { agentSummary = bridge.getAgentSummary?.() ?? null; } catch { /* */ }
                try { currentTool = bridge.getCurrentTool?.() ?? null; } catch { /* */ }
                try { lastTool = bridge.getLastTool?.() ?? null; } catch { /* */ }

                // Left side: what the agent is doing right now.
                // Map technical tool names (dispatch_agent, dispatch_agents_parallel,
                // spawn_worker, …) to friendlier labels that read like verbs.
                const FRIENDLY_TOOL: Record<string, string> = {
                  dispatch_agent: 'dispatching subagent',
                  dispatch_agents_parallel: 'dispatching subagents in parallel',
                  spawn_worker: 'spawning worker',
                  send_message: 'sending worker message',
                  coordinator_activate: 'activating coordinator',
                  coordinator_deactivate: 'deactivating coordinator',
                  coordinator_status: 'checking coordinator status',
                  read_scratchpad: 'reading scratchpad',
                  write_scratchpad: 'writing scratchpad',
                  web_search: 'searching web',
                  web_fetch: 'fetching page',
                  find_references: 'finding references',
                  find_definition: 'finding definition',
                  get_symbols: 'listing symbols',
                };
                const prettyTool = (name: string | null): string | null => {
                  if (!name) return null;
                  return FRIENDLY_TOOL[name] || name;
                };
                const activeTool = prettyTool(currentTool) || prettyTool(lastTool);
                const activityLabel = activeTool || agentSummary || busyLabel;

                // Right side stats: elapsed + tokens
                const statParts: string[] = [];
                if (elapsedSec > 0) statParts.push(formatElapsed(elapsedSec));
                if (streamTokens > 0) statParts.push(`${streamTokens.toLocaleString()} tok`);
                const stats = statParts.length > 0 ? `  ${statParts.join(' · ')}` : '';

                return (
                  <>
                    <Text color={palette.primary}>{' ' + activityLabel}</Text>
                    {stats ? <Text color={palette.dim}>{stats}</Text> : null}
                  </>
                );
              })()}
            </>
          ) : enabledFields.includes('status') ? (
            <Text color={palette.dim}>{'ready'}</Text>
          ) : null}
        </Box>
        <Box flexGrow={1} />
        <Box>
          <KittScanner busy={busy} primaryHex={(() => { try { return require('../theme').inputBorderColor(); } catch { return palette.primary; } })()} dimHex={palette.dim} />
        </Box>
        <Box flexGrow={1} />
        <Box>
          {fieldElements}
        </Box>
      </Box>
    </Box>
  );
}

// Memoize so identical snapshots don't re-render (important because the
// parent App re-renders on every statsTick).
export const StatusLine = React.memo(StatusLineImpl, (prev, next) => {
  if (prev.busy !== next.busy) return false;
  if (prev.busyLabel !== next.busyLabel) return false;
  if (prev.elapsedSec !== next.elapsedSec) return false;
  if (prev.streamTokens !== next.streamTokens) return false;
  if (prev.contextPct !== next.contextPct) return false;
  if (prev.msgsCount !== next.msgsCount) return false;
  if (prev.totalTokens !== next.totalTokens) return false;
  if (prev.sessionPromptTokens !== next.sessionPromptTokens) return false;
  if (prev.sessionCompletionTokens !== next.sessionCompletionTokens) return false;
  if (prev.sessionCacheReads !== next.sessionCacheReads) return false;
  if (prev.cacheReads !== next.cacheReads) return false;
  // Coordinator state is on ctx (mutable object) — use tick counter to detect mutations
  if (prev.coordinatorTick !== next.coordinatorTick) return false;
  const a = prev.todos, b = next.todos;
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.total === b.total && a.done === b.done && a.inProgress === b.inProgress;
});
