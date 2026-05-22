/**
 * IPC DTOs shared between Electron main and renderer.
 *
 * Keep these shapes JSON-serializable — no functions, Date objects, or
 * Node Buffers. Binary blobs (images, attachments) are referenced by id,
 * not inlined.
 */

// ── Chat ────────────────────────────────────────────────────────────────

export type MessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'tool'
  | 'info'
  | 'warn'
  | 'error';

export interface TuiMessageDTO {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
  streaming?: boolean;
  preRendered?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolDurationMs?: number;
  startedAt?: number;
  liveLines?: string[];
  totalLiveLines?: number;
}

export interface AgentState {
  busy: boolean;
  busyLabel: string;
  contextPct: number;
  currentTool: string | null;
  lastTool: string | null;
  agentSummary: string | null;
  streamTokens: number;
  model: string | null;
  provider: string | null;
  totalTokens: number;
  cacheReads: number;
  messagesCount: number;
  importedRules: boolean;
  autoApprove: boolean;
  permissionMode: string;
  coordinatorActive: boolean;
  cwd: string;
  activeSessionId: string | null;
}

// ── Prompts (picker / permission / question) ──────────────────────────

export interface PickerItemDTO {
  label: string;
  detail?: string;
  /** Opaque payload echoed back on resolve. */
  value: unknown;
}

export interface PickerRequest {
  id: string;
  items: PickerItemDTO[];
  title: string;
  placeholder: string;
}

export type PermissionChoice =
  | 'allow'
  | 'allow-session'
  | 'allow-rule'
  | 'deny'
  | null;

export interface PermissionRequest {
  id: string;
  toolName: string;
  toolInput: unknown;
  reason: string;
  preview: string;
  diff?: string;
  warning?: string;
}

export interface QuestionRequest {
  id: string;
  placeholder?: string;
}

// ── Toasts / transient status ──────────────────────────────────────────

export type ToastKind = 'info' | 'warn' | 'error';

export interface ToastDTO {
  id: string;
  text: string;
  kind: ToastKind;
  expiresAt: number;
}

export interface TransientStatusDTO {
  text: string;
  ttlMs: number;
  setAt: number;
}

// ── Sessions ───────────────────────────────────────────────────────────

export interface SessionSummaryDTO {
  sessionId: string;
  file: string;
  startedAt: string;
  lastUpdatedAt: string;
  title?: string;
  summary?: string;
  tags?: string[];
  messageCount: number;
  cwd: string;
  /** Primeiros ~120 chars da 1ª user message — fallback de label quando
   *  title/summary ainda não foram gerados (sessão recém-criada ou sem
   *  auto-title persistido). */
  firstUserMessage?: string;
}

// ── Schedule ───────────────────────────────────────────────────────────

export interface ScheduleDTO {
  id: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface ScheduleRunDTO {
  runId: string;
  scheduleId: string;
  ranAt: string;          // ISO
  durationMs: number;
  exitCode: number | null;
  outputTail: string;
  error?: string;
  trigger: 'poller' | 'daemon' | 'manual';
}

// ── Daemon ─────────────────────────────────────────────────────────────

export interface DaemonStatusDTO {
  installed: boolean;
  running: boolean;
  message: string;
  cliBinary?: string;
  cliAvailable: boolean;
  platform: 'darwin' | 'linux' | 'other';
}

// ── Headless ───────────────────────────────────────────────────────────

export interface HeadlessRunStartDTO {
  runId: string;
  startedAt: string;
}

export interface HeadlessOutputDTO {
  runId: string;
  channel: 'info' | 'error' | 'assistant' | 'log';
  text: string;
  ts: number;
}

export interface HeadlessDoneDTO {
  runId: string;
  exitCode: number;
  durationMs: number;
  finalText?: string;
}

// ── Permissions ────────────────────────────────────────────────────────

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionRuleDTO {
  id?: string;
  tool: string;
  matcher?: string;
  pathPrefix?: string;
  domain?: string;
  action: PermissionAction;
  conditions?: string;
}

export interface PermissionPolicyDTO {
  policy: PermissionAction;
  mode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
  rules: PermissionRuleDTO[];
}

export interface ShadowWarningDTO {
  tool: string;
  earlier: { matcher: string; action: PermissionAction };
  shadowed: { matcher: string; action: PermissionAction };
  reason: string;
}

export interface PermissionTestRequestDTO {
  tool: string;
  command?: string;
  filePath?: string;
  domain?: string;
  cwd?: string;
  branch?: string;
  /** Override hour (0-23). When set together with `weekday`, both feed the
   *  same mocked Date so multi-condition rules evaluate consistently. */
  hour?: number;
  /** Override weekday (0=sun .. 6=sat). */
  weekday?: number;
}

export interface PermissionTestResultDTO {
  decision: PermissionAction;
  matchedRule?: {
    tool: string;
    matcher: string;
    action: PermissionAction;
    /** 0-based index into the active policy.rules. -1 when no rule matched
     *  (decision came from policy default OR a mode shortcut). */
    ruleIdx: number;
  };
  /** Where the decision came from: a specific rule, a mode shortcut, or the
   *  policy default. Lets the UI label the badge precisely. */
  source: 'rule' | 'mode' | 'policy-default';
  reason: string;
}

export interface TrustedFolderDTO {
  path: string;
}

// ── Hooks (Phase 8) ────────────────────────────────────────────────────

export type HookEventDTO =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'PostCompact'
  | 'Stop'
  | 'PermissionRequest'
  | 'Setup'
  // Legacy pipeline events kept for backwards compat with existing hook
  // files (loadHooks accepts both shapes).
  | 'pre-task'
  | 'post-task'
  | 'pre-commit'
  | 'post-commit'
  | 'pre-dum'
  | 'post-dum';

export type HookTypeDTO = 'command' | 'http' | 'prompt' | 'agent';

export interface HookDTO {
  /** Stable per-row identity (synthesized — not part of the JSON schema). */
  id: string;
  event: HookEventDTO;
  type: HookTypeDTO;
  if?: string;
  timeout?: number;
  async?: boolean;
  // Type-specific fields — populated only for the matching `type`.
  command?: string;
  url?: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  prompt?: string;
  model?: 'fast' | 'primary';
  vetoIfContains?: string;
  subagent_type?: string;
  task?: string;
}

export interface HookTestResultDTO {
  ok: boolean;
  hookType: HookTypeDTO;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  veto?: string;
  error?: string;
  /** True when the test path intentionally did NOT run the hook (e.g. http
   *  hooks aren't fired from the settings UI to avoid hitting external
   *  webhooks unintentionally). UI should show "skipped", not "OK". */
  skipped?: boolean;
  /** Optional human-readable note shown alongside skipped/short-circuit results. */
  note?: string;
}

// ── Memory ─────────────────────────────────────────────────────────────

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryTopicDTO {
  name: string;
  description?: string;
  type: MemoryType;
  tags: string[];
  accessCount: number;
  lastAccessedAt?: string;
  preview?: string;
  bodyLength: number;
}

// ── Providers ──────────────────────────────────────────────────────────

export type ProviderTier = 'fast' | 'default' | 'image';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface CatalogEntryDTO {
  tier: ProviderTier;
  provider: string;
  model: string;
  baseUrl?: string;
  hasKey: boolean;
  /** Phase 11 — whether this tier was overridden via overrideEntry. UI shows
   *  a "reset to server" button for overridden tiers. */
  overridden?: boolean;
  maxOutputTokens?: number;
}

// ── Phase 11: Providers extensions ─────────────────────────────────────

export type ProviderKeySource = 'session' | 'env' | 'store' | 'none';

export interface ProviderInfoDTO {
  name: string;
  hasKey: boolean;
  keyMasked?: string;
  source: ProviderKeySource;
  defaultBaseUrl?: string;
  /** True when the provider is referenced by at least one tier in the catalog. */
  referencedByCatalog: boolean;
}

export interface ProviderTestRequestDTO {
  provider: string;
  baseUrl?: string;
}

export interface ProviderTestResultDTO {
  ok: boolean;
  latencyMs?: number;
  modelEcho?: string;
  status?: number;
  error?: string;
}

export interface LicenseInfoDTO {
  valid: boolean;
  plan?: string;
  reason?: string;
  seats?: { used: number; total: number };
  tasks?: { used: number; limit: number };
  lastHeartbeatAt?: number;
  nextHeartbeatAt?: number;
}

export interface CatalogSetArgsDTO {
  tier: ProviderTier;
  provider: string;
  model: string;
  baseUrl?: string;
  maxOutputTokens?: number;
}

export interface ProviderKeySetArgsDTO {
  provider: string;
  /** Set the key. Mutually exclusive with `remove: true`. */
  key?: string;
  baseUrl?: string;
  /** When true, removes the persisted key for this provider. */
  remove?: boolean;
}

export interface ProvidersSetRequestDTO {
  catalog?: CatalogSetArgsDTO;
  /** Reset a specific tier back to "server-managed" (clears override flag). */
  resetCatalogTier?: ProviderTier;
  key?: ProviderKeySetArgsDTO;
  /** Force re-fetch from /cli-catalog/models. Otherwise the server response
   *  may not arrive for up to 1h (in-process catalog cache). */
  refreshFromServer?: boolean;
}

export interface ProviderCostBreakdownDTO {
  tier: ProviderTier;
  provider: string;
  model: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
  hasPricing: boolean;
}

export interface ProvidersSnapshotDTO {
  entries: CatalogEntryDTO[];
  providers: ProviderInfoDTO[];
  effort: EffortLevel;
  costs: ProviderCostBreakdownDTO[];
  license?: LicenseInfoDTO;
}

// ── Usage ──────────────────────────────────────────────────────────────

export interface UsageEventDTO {
  at: string;
  provider: string;
  model: string;
  tier?: string;
  promptTokens: number;
  completionTokens: number;
  cacheReads: number;
  cacheWrites: number;
}

export interface DailyStatDTO {
  date: string;
  events: number;
  tokens: number;
  sessions: number;
}

export interface ModelStatDTO {
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  events: number;
  percentOfTotal: number;
  /** Phase 10 — cached read tokens for this model. 0 if provider doesn't surface cache. */
  cacheReads: number;
  /** Phase 10 — cached write tokens for this model. */
  cacheWrites: number;
  /** Phase 10 — cacheReads / (tokensIn + cacheReads), in [0,1]. */
  cacheHitRatio: number;
  /** Phase 10 — USD estimated via PRICING table. 0 when model unknown. */
  costUSD: number;
}

// ── Phase 10: Usage extensions ──────────────────────────────────────────

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface UsageHeatmapDayDTO {
  date: string;
  tokens: number;
  events: number;
  level: HeatLevel;
}

export interface UsageHeatmapDTO {
  days: UsageHeatmapDayDTO[];
  max: number;
  daysWindow: number;
}

export interface UsageStreaksDTO {
  current: number;
  longest: number;
  firstDate: string | null;
  lastDate: string | null;
  activeDays: number;
  totalDays: number;
  mostActiveDay: string | null;
  mostActiveDayEvents: number;
}

export interface UsageMonthDTO {
  month: string;          // YYYY-MM
  tokens: number;
  events: number;
  sessions: number;
  costUSD: number;
}

export interface UsageAggregateDTO {
  totalEvents: number;
  totalTokens: number;
  totalSessions: number;
  activeDays: number;
  totalDays: number;
  firstDate: string | null;
  lastDate: string | null;
  favoriteModel: string | null;
  longestSessionMs: number;
  totalCacheReads: number;
  totalCacheWrites: number;
  cacheHitRatioGlobal: number;
  totalCostUSD: number;
  daily: DailyStatDTO[];
  models: ModelStatDTO[];
  months: UsageMonthDTO[];
  streaks: UsageStreaksDTO;
}

export type UsageCsvKind = 'daily' | 'models' | 'all';

export interface UsageCsvExportRequestDTO {
  kind: UsageCsvKind;
  daysWindow?: number;
}

export interface UsageCsvExportResultDTO {
  filePath: string;
  bytes: number;
  cancelled: boolean;
}

// ── Phase 10: Debug logs ────────────────────────────────────────────────

export interface DebugLogEntryDTO {
  ts: string;
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface DebugLogTailRequestDTO {
  sessionId?: string;
  limit?: number;
  types?: string[];
  search?: string;
  since?: string;
}

export interface DebugLogSessionDTO {
  sessionId: string;
  path: string;
  startedAt: string;
  sizeBytes: number;
  eventCount: number;
  isCurrent: boolean;
}

export interface DebugLogFollowStartDTO {
  followId: string;
  sessionId: string;
}

// ── Phase 10: Doctor + Health ──────────────────────────────────────────

export type DoctorPhaseDTO =
  | 'compose' | 'install' | 'build' | 'start' | 'health'
  | 'analyze' | 'pub-get' | 'unknown' | 'skipped';

export interface DoctorCheckDTO {
  stack: string;
  label: string;
  phase: DoctorPhaseDTO;
  success: boolean;
  errors: string[];
  durationMs: number;
}

export interface DoctorStackDTO {
  type: string;
  label: string;
  dir: string;
  framework?: string;
}

export interface DoctorReportDTO {
  passed: boolean;
  passes: number;
  stacks: DoctorStackDTO[];
  finalResults: DoctorCheckDTO[];
}

export interface DoctorRunOptionsDTO {
  deep?: boolean;
  maxPasses?: number;
  skipFix?: boolean;
  cli?: 'claude' | 'codex' | 'gemini';
}

export interface HealthReportDTO {
  checks: HealthCheckDTO[];
  ranAt: string;
  durationMs: number;
}

// ── Cluster peers ──────────────────────────────────────────────────────

export interface PeerDTO {
  peerId: string;
  name?: string;
  address?: string;
  port?: number;
  role?: string;
  lastSeenAt: string;
  latencyMs?: number;
  trusted: boolean;
}

// ── Coordinator ────────────────────────────────────────────────────────

export interface CoordinatorSnapshotDTO {
  active: boolean;
  sessionId?: string;
  workers: Array<{
    id: string;
    role: string;
    status: string;
    tokens?: number;
    summary?: string;
  }>;
}

// ── Plan mode / Worktree banners ──────────────────────────────────────

export interface PlanModeDTO {
  active: boolean;
  planFilePath?: string;
}

export interface WorktreeDTO {
  active: boolean;
  branch?: string;
  path?: string;
  originalCwd?: string;
}

// ── Current / last tool ────────────────────────────────────────────────

export interface CurrentToolDTO {
  current: string | null;
  last: string | null;
}

// ── MCP server ─────────────────────────────────────────────────────────

export interface McpServerDTO {
  id: string;
  name: string;
  status: 'disconnected' | 'initializing' | 'connected' | 'error';
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  lastError?: string;
}

// ── Skill / custom agent / plugin ─────────────────────────────────────

export interface SkillDTO {
  id: string;
  name: string;
  description?: string;
  source: 'bundled' | 'user' | 'project';
  args?: string[];
  whenToUse?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
}

export interface CustomAgentDTO {
  id: string;
  name: string;
  description?: string;
  source: 'user' | 'project' | 'claude-user' | 'claude-project';
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  memoryScope?: 'project' | 'user' | 'none';
  bodyPreview?: string;
}

export interface PluginInfoDTO {
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  source: 'npm' | 'git' | 'local' | 'builtin';
  installedAt?: string;
  contributionCount: number;
  path?: string;
}

// ── Phase 14: Projects + Worktree + Plan + Coordinator ────────────────

export interface ProjectDTO {
  id: string;
  name: string;
  localPath?: string;
  status?: string;
  tenantId: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type TaskStatus = 'pending' | 'in-progress' | 'verification' | 'done';

export interface TaskDTO {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string;
  createdAt: string;
  updatedAt: string;
  prUrl?: string;
}

export interface DumDTO {
  id: string;
  projectId: string;
  dumNumber: string;
  title: string;
  status: string;
  artifactsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DumDetailDTO extends DumDTO {
  specFull: string;
  tasks: TaskDTO[];
  artifacts: Array<{ path: string; size: number; contentPreview?: string }>;
}

export interface WorktreeListItemDTO {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  isDetached: boolean;
}

export interface KanbanCardDTO {
  id: string;
  title: string;
  column: TaskStatus;
  assignee?: string;
  updatedAt: string;
  prUrl?: string;
}

export interface KanbanColumnDTO {
  name: TaskStatus;
  cards: KanbanCardDTO[];
}

export interface PlanFileDTO {
  path: string;
  content: string;
  bytes: number;
  ranAt?: string;
}

export interface ExecuteOptionsDTO {
  dumNumber?: string;
  plan?: boolean;
  isolate?: boolean;
  skipDoctor?: boolean;
  reviewFix?: boolean;
}

export interface ExecuteProgressDTO {
  phase: string;
  step?: string;
  total?: number;
  log?: string;
}

export interface WorkerSnapshotDTO {
  id: string;
  status: 'starting' | 'running' | 'done' | 'error';
  mode?: string;
  subagentType?: string;
  startedAt: string;
  tokens?: number;
  lastMessage?: string;
}

export interface CoordinatorSnapshotDTOv2 {
  active: boolean;
  sessionId?: string;
  workers: WorkerSnapshotDTO[];
  scratchpadFiles: string[];
}

// ── Phase 13: MCP + Cluster ────────────────────────────────────────────

export type McpServerStatusDTO = 'starting' | 'ready' | 'error' | 'exited';

export interface McpServerListItemDTO {
  name: string;
  status: McpServerStatusDTO;
  tools: number;
  resources: number;
  prompts: number;
  capabilities: unknown;
  lastError?: string;
  startedAt: string;
  restarts: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolDTO {
  serverName: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResourceDTO {
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDTO {
  serverName: string;
  name: string;
  description?: string;
  arguments?: unknown;
}

export interface McpServerDetailDTO {
  name: string;
  status: McpServerStatusDTO;
  tools: McpToolDTO[];
  resources: McpResourceDTO[];
  prompts: McpPromptDTO[];
  logs: string[];
  lastError?: string;
  startedAt: string;
  command?: string;
  args?: string[];
}

export interface McpAddRequestDTO {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  scope?: 'user' | 'project';
}

export interface McpLogEventDTO {
  server: string;
  stream: 'stderr' | 'notification';
  lines: string[];
  ts: string;
}

export interface McpStatusEventDTO {
  name: string;
  status: McpServerStatusDTO;
  error?: string;
  code?: number;
}

export interface ClusterConfigDTO {
  enabled: boolean;
  peerId: string;
  pubkey?: string;
  listenPort: number;
  multicastGroup: string;
  multicastPort: number;
}

export interface ClusterPeerDTO {
  peerId: string;
  pubkey?: string;
  hostname?: string;
  address?: string;
  wsPort?: number;
  swimState: 'alive' | 'suspect' | 'faulty' | 'unknown';
  caps?: string[];
  version?: string;
  loadHint?: number;
  lastSeen: string;
  trusted: boolean;
  latencyMs?: number;
  lastSyncAt?: string;
}

export interface ClusterTrustEntryDTO {
  peerId: string;
  global: { allowBash: boolean; allowWrite: boolean };
  scopes: Array<{ path: string; allowBash: boolean; allowWrite: boolean }>;
}

export interface ClusterSnapshotDTO {
  selfPeerId: string;
  selfPubkey?: string;
  enabled: boolean;
  listenPort: number;
  multicastGroup: string;
  multicastPort: number;
  swimRunning: boolean;
  autoSyncRunning: boolean;
  peers: ClusterPeerDTO[];
  trust: ClusterTrustEntryDTO[];
  swimStats: { alive: number; suspect: number; faulty: number; pings: number; indirectPings: number };
  discoveryStats: { peers: number; lastBeaconAt?: number };
  lastSyncAt?: string;
}

export interface ClusterTrustSetRequestDTO {
  peerId: string;
  global?: { allowBash?: boolean; allowWrite?: boolean };
  scope?: { path: string; allowBash?: boolean; allowWrite?: boolean };
  remove?: boolean;
}

export interface ClusterSyncProgressEventDTO {
  peerId: string;
  phase: 'digest' | 'pull' | 'apply' | 'done' | 'error';
  pulled?: number;
  total?: number;
  conflicts?: number;
  error?: string;
}

// ── Phase 12: Skills + Agents + Plugins + Boilerplates extensions ────

export interface SkillBodyDTO {
  name: string;
  source: 'bundled' | 'user' | 'project';
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  args?: string[];
  allowedTools?: string[];
  body: string;
  filePath?: string;
}

export interface SkillSaveDTO {
  scope: 'user' | 'project';
  skill: {
    name: string;
    description: string;
    body: string;
    args?: string[];
    whenToUse?: string;
    argumentHint?: string;
    allowedTools?: string[];
  };
}

export interface CustomAgentBodyDTO {
  name: string;
  source: 'user' | 'project' | 'claude-user' | 'claude-project' | 'builtin';
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  baseAgent?: string;
  memory: 'project' | 'user' | 'none';
  filePath?: string;
  /** True quando o agent vem dos built-ins (read-only). */
  readOnly?: boolean;
}

export interface CustomAgentSaveDTO {
  scope: 'user' | 'project';
  agent: {
    name: string;
    description: string;
    prompt: string;
    tools?: string[];
    disallowedTools?: string[];
    model?: string;
    maxTurns?: number;
    baseAgent?: string;
    memory?: 'project' | 'user' | 'none';
  };
}

export interface DispatchHistoryEntryDTO {
  id: string;
  subagentType: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalTokens: number;
  description?: string;
}

export interface PluginContributionDTO {
  pluginName: string;
  skills: string[];
  tools: string[];
  slashCommands: string[];
  hooks: Record<string, number>;
  mcpServers: string[];
}

export interface PluginInstallProgressDTO {
  source: string;
  phase: 'start' | 'install' | 'load' | 'done' | 'error';
  line?: string;
  manifest?: PluginInfoDTO;
  error?: string;
}

export interface BoilerplateDTO {
  slug: string;
  name: string;
  description?: string;
  difficulty: number;
  stacks: string[];
  localPath?: string;
  exists: boolean;
  hasManifest: boolean;
}

export type BoilerplatePromptType = 'text' | 'choice' | 'boolean';

export interface BoilerplatePromptDTO {
  name: string;
  type: BoilerplatePromptType;
  description: string;
  required: boolean;
  default?: string;
  choices?: string[];
}

export interface BoilerplateApplyRequestDTO {
  slug: string;
  targetDir: string;
  answers: Record<string, string>;
}

export interface BoilerplateApplyProgressDTO {
  phase: 'start' | 'copy' | 'walk' | 'replace' | 'postSetup' | 'done' | 'error';
  file?: string;
  filesProcessed?: number;
  totalFiles?: number;
  log?: string;
  error?: string;
}

export interface BoilerplateApplyResultDTO {
  ok: boolean;
  filesScanned: number;
  filesChanged: number;
  targetDir: string;
  error?: string;
}

// ── Rewind / file history ──────────────────────────────────────────────

export interface RewindCheckpointDTO {
  turn: number;
  startedAt: string;
  userMessage?: string;
  fileCount: number;
  status: 'clean' | 'dirty';
}

export interface FileHistoryEntryDTO {
  path: string;
  timestamp: string;
  sizeBytes: number;
  preview?: string;
}

// ── Auth ───────────────────────────────────────────────────────────────

export interface AuthStatusDTO {
  authenticated: boolean;
  email?: string;
  serverUrl?: string;
  /** ms epoch — extraído do JWT exp claim. undefined se token não-JWT. */
  expiresAt?: number;
  userId?: number;
  tenantId?: string;
  /** True se o ctx.initialize() já rodou no main (agent pronto pra uso). */
  agentInitialized?: boolean;
}

// ── Cassettes ──────────────────────────────────────────────────────────

export interface CassetteDTO {
  name: string;
  path: string;
  recordedAt: string;
  turns: number;
  sizeBytes: number;
}

export interface CassetteRecordingStatusDTO {
  active: boolean;
  name?: string;
  turns?: number;
  startedAt?: string;
}

// ── Health / doctor ────────────────────────────────────────────────────

export interface HealthCheckDTO {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  fix?: string;
}

// ── Settings (Phase 9) ─────────────────────────────────────────────────
//
// Mirror of agent-core Settings (src/repl/settings.ts). The Electron UI
// reads/writes through SETTINGS_GET / SETTINGS_SET; granular channels
// (KEYBINDINGS_*, STATUSLINE_*, OUTPUT_STYLE_*) are convenience wrappers
// that delegate to the same saveSettings(). Theme here refers to the
// agent-core/TUI palette — Electron UI's own theme lives in localStorage
// and is independent (renderer/store/slices/theme.ts).

export type PermissionModeDTO =
  | 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';

export interface SettingsDTO {
  theme: string;            // TUI palette name (default, classic, dark, …)
  outputStyle: string;
  vimMode: boolean;
  fastMode: boolean;
  keybindings: Record<string, string>;
  statusline: { fields: string[] };
  workingDirs: string[];
  permissionMode?: PermissionModeDTO;
  tipsDisabled?: boolean;
  suggestionsDisabled?: boolean;
  awaySummaryDisabled?: boolean;
  magicDocsDisabled?: boolean;
  fileHistoryDisabled?: boolean;
  autoVerifyEnabled?: boolean;
  verbose?: boolean;
  /** Phase 9 — paste behaviour. Defaults applied at the InputBox call
   *  site so a fresh settings.json without these keys behaves identically
   *  to the historical hard-coded constants. */
  inputPaste?: {
    autoMarker?: boolean;
    markerThresholdLines?: number;
    markerThresholdChars?: number;
  };
  /** Phase 9 — @file reference. Same default-preservation logic. */
  inputAtFile?: {
    enabled?: boolean;
    maxResults?: number;
  };
  /** Phase 11 — persisted effort level (in-memory `ctx.effort` was the only
   *  source before; restart reset to 'medium'). */
  effort?: EffortLevel;
  /** UI zoom scale — 1.0 = neutral, 1.15 = laptop default, range 0.7–1.5. */
  uiScale?: number;
}

export interface OutputStyleDTO {
  name: string;
  /** 'managed' is the MDM/admin-pushed scope (~/.makestudio/.mdm/output-styles/).
   *  Earlier shape only listed builtin/user/project; the agent core has always
   *  produced 'managed' too, and dropping it here mislabeled MDM styles in the
   *  UI badge. */
  source: 'builtin' | 'user' | 'project' | 'managed';
  description?: string;
  bodyPreview?: string;     // first 240 chars of body if any
  /** keepCodingInstructions frontmatter — when false, the built-in coding
   *  instructions section is stripped from the system prompt for this style. */
  keepCodingInstructions?: boolean;
  /** Absolute path of the markdown file (only for non-builtin). UI displays
   *  this so the user knows where the file lives. */
  filePath?: string;
}

/** Full body fetch — used by the editor when opening a style. */
export interface OutputStyleBodyDTO {
  name: string;
  source: 'builtin' | 'user' | 'project' | 'managed';
  description: string;
  keepCodingInstructions: boolean;
  body: string;
  filePath?: string;
}

/** Args for save (create or update). Builtin/managed scopes are read-only;
 *  the handler rejects those. */
export interface OutputStyleSaveDTO {
  name: string;
  description: string;
  keepCodingInstructions: boolean;
  body: string;
  scope: 'user' | 'project';
}

export interface KeybindingDTO {
  action: string;
  combo: string;
  description?: string;
}

export interface StatuslineFieldDTO {
  name: string;
  description?: string;
}

export interface FlagDTO {
  name: string;
  value: boolean;
  default: boolean;
  description?: string;
}

// ── Phase 15: Git + PR + Security Review ──────────────────────────────────

export interface GitFileChangeDTO {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?' | 'U' | 'C';
  staged: boolean;
  originalPath?: string;
}

export interface GitStatusDTO {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  files: GitFileChangeDTO[];
  remoteUrl?: string;
}

export interface GitDiffRequestDTO {
  path?: string;
  staged?: boolean;
  baseRef?: string;
  cwd?: string;
}

export interface GitDiffDTO {
  raw: string;
  insertions: number;
  deletions: number;
  truncated: boolean;
}

export interface GitBranchDTO {
  name: string;
  current: boolean;
  remote?: string;
  lastCommit?: { sha: string; message: string; date: string };
}

export interface GitCommitRequestDTO {
  op: 'suggest' | 'commit' | 'push' | 'cpp' | 'branches';
  message?: string;
  files?: string[];
  cwd?: string;
  base?: string;
  prTitle?: string;
  prBody?: string;
}

export interface GitCommitResultDTO {
  sha?: string;
  message: string;
  filesChanged: number;
}

export interface PullRequestDTO {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  body?: string;
  mergedAt?: string;
  closedAt?: string;
  createdAt: string;
  draft?: boolean;
  headRef?: string;
  baseRef?: string;
}

export interface PRCommentDTO {
  path?: string;
  line?: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface PRCreateRequestDTO {
  title: string;
  body: string;
  base: string;
  draft?: boolean;
}

export interface SecurityIssueDTO {
  id: number;
  severity: 'High' | 'Medium' | 'Low';
  category: string;
  file?: string;
  line?: number;
  description: string;
  exploit?: string;
  recommendation: string;
  confidence: number;
}

export interface SecurityReviewDTO {
  ranAt: string;
  base: string;
  durationMs: number;
  reportPath: string;
  issues: SecurityIssueDTO[];
  summary: { high: number; medium: number; low: number };
  truncated: boolean;
}


export interface TipDTO {
  id: string;
  text: string;
}
