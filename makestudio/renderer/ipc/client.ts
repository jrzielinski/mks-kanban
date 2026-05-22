/**
 * Renderer-side thin wrappers for window.makestudio.* — kept so that
 * the IPC surface is typed once in pages / hooks / stores instead of
 * calling `window.makestudio.agent.invoke('...')` literally everywhere.
 *
 * Fase 0: only a few helpers are wired. Fase 1+ expands as pages need.
 */

import type { MakeStudioAPI } from '../../preload';
import * as CH from '@shared/channels';

// Runtime guard — renderer always runs with the preload, but a dev
// `vite dev` tab outside Electron would be undefined; fail loud.
function api(): MakeStudioAPI {
  const w = window as unknown as { makestudio?: MakeStudioAPI };
  if (!w.makestudio) {
    throw new Error(
      '[ipc] window.makestudio not found — are you running outside Electron?',
    );
  }
  return w.makestudio;
}

export function invoke<TReq = unknown, TRes = unknown>(
  channel: string,
  payload?: TReq,
): Promise<TRes> {
  return api().agent.invoke<TReq, TRes>(channel, payload);
}

export function subscribe<T = unknown>(
  channel: string,
  handler: (payload: T) => void,
): () => void {
  return api().events.on<T>(channel, handler);
}

export function resolveRpc(channel: string, payload?: unknown): void {
  api().rpc.resolve(channel, payload);
}

export function appVersion(): Promise<{ app: string; electron: string; node: string }> {
  return api().app.version();
}

export function platform(): string {
  return api().platform;
}

// ── Attachments helpers ────────────────────────────────────────────────

export interface PasteRef {
  id: number;
  lines: number;
}

export async function storePastedText(text: string): Promise<PasteRef> {
  return invoke<string, PasteRef>(CH.AGENT_STORE_PASTE, text);
}

export interface ImageAttachmentRef {
  ok: true;
  id: number;
  mime: string;
  bytes: number;
}
export interface AttachmentError {
  ok: false;
  error?: string;
}

export async function storeImage(
  data: ArrayBuffer,
  mime: string,
): Promise<ImageAttachmentRef | AttachmentError> {
  return invoke<
    { data: ArrayBuffer; mime: string },
    ImageAttachmentRef | AttachmentError
  >(CH.ATTACHMENTS_STORE_IMAGE, { data, mime });
}

export type StoreFilePathResult =
  | {
      ok: true;
      kind: 'image';
      id: number;
      mime: string;
      bytes: number;
    }
  | {
      ok: true;
      kind: 'text';
      id: number;
      lines: number;
      name: string;
    }
  | {
      ok: false;
      kind: 'image' | 'text' | 'unsupported';
      error?: string;
    };

export async function storeFilePath(
  filePath: string,
): Promise<StoreFilePathResult> {
  return invoke<{ path: string }, StoreFilePathResult>(
    CH.ATTACHMENTS_STORE_FILE_PATH,
    { path: filePath },
  );
}

export async function listProjectFiles(
  query: string,
  limit = 30,
): Promise<string[]> {
  return invoke<{ query: string; limit: number }, string[]>(
    CH.ATTACHMENTS_LIST_FILES,
    { query, limit },
  );
}

export const dialogApi = {
  openFiles(filters?: Array<{ name: string; extensions: string[] }>): Promise<string[]> {
    return invoke(CH.DIALOG_OPEN_FILE, { filters });
  },
  openImages(): Promise<string[]> {
    return invoke(CH.DIALOG_OPEN_FILE, {
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'] }],
    });
  },
};

// ── Phase 5/6 — typed API namespaces ───────────────────────────────────

import type {
  McpServerStatusDTO,
  McpServerListItemDTO,
  McpToolDTO,
  McpServerDetailDTO,
  McpAddRequestDTO,
  McpLogEventDTO,
  McpStatusEventDTO,
  ClusterConfigDTO,
  ClusterSnapshotDTO,
  ClusterTrustEntryDTO,
  ClusterTrustSetRequestDTO,
  ClusterSyncProgressEventDTO,
  SessionSummaryDTO,
  RewindCheckpointDTO,
  FileHistoryEntryDTO,
  CassetteDTO,
  MemoryTopicDTO,
  MemoryType,
  AuthStatusDTO,
  ScheduleDTO,
  ScheduleRunDTO,
  DaemonStatusDTO,
  HeadlessRunStartDTO,
  SettingsDTO,
  OutputStyleDTO,
  OutputStyleBodyDTO,
  OutputStyleSaveDTO,
  StatuslineFieldDTO,
  FlagDTO,
  PermissionPolicyDTO,
  PermissionTestRequestDTO,
  PermissionTestResultDTO,
  ShadowWarningDTO,
  TrustedFolderDTO,
  HookDTO,
  HookTestResultDTO,
  UsageAggregateDTO,
  UsageHeatmapDTO,
  UsageStreaksDTO,
  UsageEventDTO,
  UsageCsvExportRequestDTO,
  UsageCsvExportResultDTO,
  DebugLogEntryDTO,
  DebugLogTailRequestDTO,
  DebugLogSessionDTO,
  DebugLogFollowStartDTO,
  DoctorReportDTO,
  DoctorRunOptionsDTO,
  HealthReportDTO,
  ProvidersSnapshotDTO,
  ProvidersSetRequestDTO,
  ProviderCostBreakdownDTO,
  ProviderTestRequestDTO,
  ProviderTestResultDTO,
  LicenseInfoDTO,
  EffortLevel,
  SkillDTO,
  SkillBodyDTO,
  SkillSaveDTO,
  CustomAgentDTO,
  CustomAgentBodyDTO,
  CustomAgentSaveDTO,
  DispatchHistoryEntryDTO,
  PluginInfoDTO,
  PluginContributionDTO,
  PluginInstallProgressDTO,
  BoilerplateDTO,
  BoilerplatePromptDTO,
  BoilerplateApplyRequestDTO,
  BoilerplateApplyProgressDTO,
  BoilerplateApplyResultDTO,
} from '@shared/types';

export const authApi = {
  status(): Promise<AuthStatusDTO> {
    return invoke(CH.AUTH_STATUS);
  },
  login(args: {
    email: string;
    password: string;
    serverUrl?: string;
  }): Promise<{ ok: boolean; status?: AuthStatusDTO; error?: string }> {
    return invoke(CH.AUTH_LOGIN, args);
  },
  logout(): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.AUTH_LOGOUT);
  },
  refresh(): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.AUTH_REFRESH);
  },
  heartbeat(): Promise<LicenseInfoDTO | null> {
    return invoke(CH.AUTH_HEARTBEAT);
  },
};

export const providersApi = {
  catalog(): Promise<ProvidersSnapshotDTO> {
    return invoke(CH.PROVIDERS_CATALOG);
  },
  set(args: ProvidersSetRequestDTO): Promise<ProvidersSnapshotDTO> {
    return invoke(CH.PROVIDERS_SET, args);
  },
  costs(): Promise<ProviderCostBreakdownDTO[]> {
    return invoke(CH.PROVIDERS_COSTS);
  },
  setEffort(level: EffortLevel): Promise<ProvidersSnapshotDTO> {
    return invoke(CH.PROVIDERS_EFFORT_SET, { level });
  },
  test(req: ProviderTestRequestDTO): Promise<ProviderTestResultDTO> {
    return invoke(CH.PROVIDERS_TEST, req);
  },
  onChanged(cb: (snapshot: ProvidersSnapshotDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on && typeof events.on === 'function') {
      const off = events.on(CH.EVT_PROVIDERS_CHANGED, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

export interface ApiConfigDTO {
  id: string;
  name: string;
  provider: string;
  model: string;
  isDefault: boolean;
  isActive: boolean;
  priority: number;
}

export const apiConfigsApi = {
  list(): Promise<{
    ok: boolean;
    activeId?: string;
    configs?: ApiConfigDTO[];
    error?: string;
  }> {
    return invoke(CH.API_CONFIGS_LIST);
  },
  activate(id: string): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.API_CONFIGS_ACTIVATE, { id });
  },
};

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface MemoryTopicFullDTO {
  name: string;
  description?: string;
  type?: MemoryType;
  tags: string[];
  body: string;
  accessCount: number;
  lastAccessedAt: string;
}

export const sessionsApi = {
  list(args?: { cwd?: string; limit?: number }): Promise<SessionSummaryDTO[]> {
    return invoke<typeof args, SessionSummaryDTO[]>(CH.SESSIONS_LIST, args);
  },
  open(sessionId: string): Promise<{
    messages: SessionMessage[];
    file?: string;
    summary?: SessionSummaryDTO;
    error?: string;
  }> {
    return invoke(CH.SESSIONS_OPEN, { sessionId });
  },
  resume(sessionId: string): Promise<{
    ok: boolean;
    sessionId?: string;
    title?: string;
    messageCount?: number;
    error?: string;
  }> {
    return invoke(CH.SESSIONS_RESUME, { sessionId });
  },
  fork(title?: string): Promise<{
    ok: boolean;
    sessionId?: string;
    file?: string;
    error?: string;
  }> {
    return invoke(CH.SESSIONS_FORK, { title });
  },
  rename(file: string, title: string): Promise<{ ok: boolean }> {
    return invoke(CH.SESSIONS_RENAME, { file, title });
  },
  tag(file: string, tags: string[]): Promise<{ ok: boolean }> {
    return invoke(CH.SESSIONS_TAG, { file, tags });
  },
  delete(file: string): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.SESSIONS_DELETE, { file });
  },
  export(
    file: string,
    format: 'md' | 'json',
  ): Promise<{ content: string; filename: string; error?: string }> {
    return invoke(CH.SESSIONS_EXPORT, { file, format });
  },
  search(
    query: string,
    mode: 'literal' | 'semantic' = 'literal',
  ): Promise<SessionSummaryDTO[]> {
    return invoke(CH.SESSIONS_SEARCH, { query, mode });
  },
};

export const rewindApi = {
  list(): Promise<RewindCheckpointDTO[]> {
    return invoke(CH.REWIND_LIST);
  },
  restore(turn: number): Promise<{
    filesRestored?: number;
    filesDeleted?: number;
    messagesDropped?: number;
    error?: string;
  }> {
    return invoke(CH.REWIND_RESTORE, { turn });
  },
  clear(): Promise<{ removed: number }> {
    return invoke(CH.REWIND_CLEAR);
  },
};

export const fileHistoryApi = {
  list(filePath: string): Promise<FileHistoryEntryDTO[]> {
    return invoke(CH.FILE_HISTORY_LIST, { path: filePath });
  },
  restore(
    filePath: string,
    index?: number,
  ): Promise<{
    restored: boolean;
    reason?: string;
    from?: string;
    deleted?: boolean;
  }> {
    return invoke(CH.FILE_HISTORY_RESTORE, { path: filePath, index });
  },
  clear(): Promise<{ ok: true }> {
    return invoke(CH.FILE_HISTORY_CLEAR);
  },
};

export const cassettesApi = {
  list(): Promise<CassetteDTO[]> {
    return invoke(CH.CASSETTES_LIST);
  },
  replay(name: string): Promise<{ turns: number; error?: string }> {
    return invoke(CH.CASSETTES_REPLAY, { name });
  },
  recordStart(name: string): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.CASSETTES_RECORD_START, { name });
  },
  recordStop(): Promise<{ path: string; error?: string }> {
    return invoke(CH.CASSETTES_RECORD_STOP);
  },
};

export const memoryApi = {
  list(): Promise<MemoryTopicDTO[]> {
    return invoke(CH.MEMORY_LIST);
  },
  get(name: string): Promise<{ topic: MemoryTopicFullDTO | null }> {
    return invoke(CH.MEMORY_GET, { name });
  },
  save(args: {
    name: string;
    body: string;
    tags?: string[];
    type?: MemoryType;
    description?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.MEMORY_SAVE, args);
  },
  delete(name: string): Promise<{ ok: boolean }> {
    return invoke(CH.MEMORY_DELETE, { name });
  },
  rebuild(): Promise<{ ok: true }> {
    return invoke(CH.MEMORY_REBUILD);
  },
  similar(
    threshold?: number,
  ): Promise<{ a: string; b: string; similarity: number }[]> {
    return invoke(CH.MEMORY_SIMILAR, { threshold });
  },
  syncStatus(): Promise<{
    peerId: string;
    peers: number;
    lastSync: string | null;
    conflicts: number;
  }> {
    return invoke(CH.MEMORY_SYNC_STATUS);
  },
};

// ── Phase 7 — Schedule / Daemon / Headless ─────────────────────────────

export const scheduleApi = {
  list(): Promise<ScheduleDTO[]> {
    return invoke(CH.SCHEDULE_LIST);
  },
  add(args: {
    name: string;
    cron: string;
    command: string;
  }): Promise<{ ok: boolean; schedule?: ScheduleDTO; error?: string }> {
    return invoke(CH.SCHEDULE_ADD, args);
  },
  update(
    id: string,
    patch: Partial<ScheduleDTO>,
  ): Promise<{ ok: boolean; schedule?: ScheduleDTO; error?: string }> {
    return invoke(CH.SCHEDULE_UPDATE, { id, patch });
  },
  remove(id: string): Promise<{ ok: boolean }> {
    return invoke(CH.SCHEDULE_REMOVE, { id });
  },
  toggle(id: string, enabled: boolean): Promise<{ ok: boolean }> {
    return invoke(CH.SCHEDULE_ENABLE, { id, enabled });
  },
  next(
    cron: string,
    from?: string,
  ): Promise<{ nextRunAt: string | null; error?: string }> {
    return invoke(CH.SCHEDULE_NEXT, { cron, from });
  },
  runNow(id: string): Promise<{
    ok: boolean;
    runId?: string;
    exitCode?: number;
    error?: string;
  }> {
    return invoke(CH.SCHEDULE_RUN_NOW, { id });
  },
  runs(scheduleId: string, limit = 10): Promise<ScheduleRunDTO[]> {
    return invoke(CH.SCHEDULE_RUNS, { scheduleId, limit });
  },
};

export const daemonApi = {
  status(): Promise<DaemonStatusDTO> {
    return invoke(CH.DAEMON_STATUS);
  },
  install(): Promise<{ ok: boolean; message: string }> {
    return invoke(CH.DAEMON_INSTALL);
  },
  uninstall(): Promise<{ ok: boolean; message: string }> {
    return invoke(CH.DAEMON_UNINSTALL);
  },
};

export const headlessApi = {
  run(opts: {
    prompt: string;
    yes?: boolean;
    maxTurns?: number;
    format?: 'text' | 'json';
    resumeSessionId?: string;
    continueSession?: boolean;
  }): Promise<HeadlessRunStartDTO> {
    return invoke(CH.HEADLESS_RUN, opts);
  },
  stop(runId: string): Promise<{ ok: boolean }> {
    return invoke(CH.HEADLESS_STOP, { runId });
  },
};

// ── Phase 9 — Settings / theme / output-style / keybindings / statusline / flags

export const settingsApi = {
  get(): Promise<SettingsDTO> {
    return invoke(CH.SETTINGS_GET);
  },
  set(patch: Partial<SettingsDTO>): Promise<SettingsDTO> {
    return invoke(CH.SETTINGS_SET, { patch });
  },
};

export const themesApi = {
  list(): Promise<Array<{ name: string }>> {
    return invoke(CH.THEME_LIST);
  },
  preview(name: string): Promise<{ ok: boolean; name: string }> {
    return invoke(CH.THEME_PREVIEW, { name });
  },
};

export const outputStylesApi = {
  list(): Promise<OutputStyleDTO[]> {
    return invoke(CH.OUTPUT_STYLE_LIST);
  },
  set(name: string): Promise<SettingsDTO> {
    return invoke(CH.OUTPUT_STYLE_SET, { name });
  },
  getBody(name: string): Promise<OutputStyleBodyDTO | null> {
    return invoke(CH.OUTPUT_STYLE_GET_BODY, { name });
  },
  save(args: OutputStyleSaveDTO): Promise<{ ok: true; filePath: string }> {
    return invoke(CH.OUTPUT_STYLE_SAVE, args);
  },
  delete(name: string, scope: 'user' | 'project'): Promise<{ ok: boolean }> {
    return invoke(CH.OUTPUT_STYLE_DELETE, { name, scope });
  },
};

export const keybindingsApi = {
  get(): Promise<Record<string, string>> {
    return invoke(CH.KEYBINDINGS_GET);
  },
  set(keybindings: Record<string, string>): Promise<Record<string, string>> {
    return invoke(CH.KEYBINDINGS_SET, { keybindings });
  },
};

export const statuslineApi = {
  get(): Promise<{ fields: string[]; available: StatuslineFieldDTO[] }> {
    return invoke(CH.STATUSLINE_GET);
  },
  set(fields: string[]): Promise<{ fields: string[] }> {
    return invoke(CH.STATUSLINE_SET, { fields });
  },
};

export const flagsApi = {
  get(): Promise<FlagDTO[]> {
    return invoke(CH.FLAGS_GET);
  },
  set(name: string, value: boolean): Promise<FlagDTO[]> {
    return invoke(CH.FLAGS_SET, { name, value });
  },
};

// ── Phase 8 — Permissions + Hooks ──────────────────────────────────────

export const permissionsApi = {
  get(): Promise<PermissionPolicyDTO> {
    return invoke(CH.PERMISSIONS_GET);
  },
  save(
    policy: PermissionPolicyDTO,
    scope: 'user' | 'project' = 'user',
  ): Promise<PermissionPolicyDTO> {
    return invoke(CH.PERMISSIONS_SAVE, { policy, scope });
  },
  shadow(): Promise<ShadowWarningDTO[]> {
    return invoke(CH.PERMISSIONS_SHADOW);
  },
  test(req: PermissionTestRequestDTO): Promise<PermissionTestResultDTO> {
    return invoke(CH.PERMISSIONS_TEST, req);
  },
  setMode(
    mode: PermissionPolicyDTO['mode'],
  ): Promise<PermissionPolicyDTO> {
    return invoke(CH.PERMISSIONS_MODE_SET, { mode });
  },
  trustList(): Promise<TrustedFolderDTO[]> {
    return invoke(CH.PERMISSIONS_TRUST_LIST);
  },
  trustAdd(path: string): Promise<{ ok: boolean; message?: string }> {
    return invoke(CH.PERMISSIONS_TRUST_ADD, { path });
  },
  trustRemove(path: string): Promise<{ ok: boolean }> {
    return invoke(CH.PERMISSIONS_TRUST_REMOVE, { path });
  },
};

export const hooksApi = {
  list(): Promise<HookDTO[]> {
    return invoke(CH.HOOKS_LIST);
  },
  save(
    hooks: HookDTO[],
    scope: 'user' | 'project' = 'user',
  ): Promise<HookDTO[]> {
    return invoke(CH.HOOKS_SAVE, { hooks, scope });
  },
  test(
    hook: HookDTO,
    mockToolName?: string,
    mockToolInput?: Record<string, unknown>,
    options: { runHttp?: boolean } = {},
  ): Promise<HookTestResultDTO> {
    return invoke(CH.HOOKS_TEST, {
      hook,
      mockToolName,
      mockToolInput,
      runHttp: Boolean(options.runHttp),
    });
  },
};

// ── Phase 10 — Usage / Debug logs / Doctor / Health ────────────────────

export const usageApi = {
  aggregate(): Promise<UsageAggregateDTO> {
    return invoke(CH.USAGE_AGGREGATE);
  },
  heatmap(daysWindow = 90): Promise<UsageHeatmapDTO> {
    return invoke(CH.USAGE_HEATMAP, { daysWindow });
  },
  streaks(): Promise<UsageStreaksDTO> {
    return invoke(CH.USAGE_STREAKS);
  },
  events(req: { types?: string[]; limit?: number } = {}): Promise<UsageEventDTO[]> {
    return invoke(CH.USAGE_EVENTS, req);
  },
  exportCsv(req: UsageCsvExportRequestDTO): Promise<UsageCsvExportResultDTO> {
    return invoke(CH.USAGE_EXPORT_CSV, req);
  },
};

export const debugLogsApi = {
  listSessions(): Promise<DebugLogSessionDTO[]> {
    return invoke(CH.DEBUG_LOGS_LIST_SESSIONS);
  },
  tail(req: DebugLogTailRequestDTO = {}): Promise<DebugLogEntryDTO[]> {
    return invoke(CH.DEBUG_LOGS_TAIL, req);
  },
  followStart(req: { sessionId?: string; types?: string[] } = {}): Promise<DebugLogFollowStartDTO> {
    return invoke(CH.DEBUG_LOGS_FOLLOW_START, req);
  },
  followStop(followId: string): Promise<{ ok: boolean }> {
    return invoke(CH.DEBUG_LOGS_FOLLOW_STOP, { followId });
  },
  /** Subscribe to streaming log lines. Returns an unsubscribe function.
   *  Caller is responsible for filtering by followId in the callback if
   *  multiple follows are active in the same window. */
  onLine(cb: (ev: { followId: string; entry: DebugLogEntryDTO }) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on && typeof events.on === 'function') {
      const off = events.on(CH.EVT_DEBUG_LOG_LINE, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

export const doctorApi = {
  run(opts: DoctorRunOptionsDTO = {}): Promise<DoctorReportDTO> {
    return invoke(CH.DOCTOR_RUN, opts);
  },
};

export const healthApi = {
  check(): Promise<HealthReportDTO> {
    return invoke(CH.HEALTH_CHECK);
  },
};

// ── Phase 12 — Skills + Agents + Plugins + Boilerplates ───────────────

export const skillsApi = {
  list(): Promise<SkillDTO[]> {
    return invoke(CH.SKILLS_LIST);
  },
  get(name: string): Promise<SkillBodyDTO | null> {
    return invoke(CH.SKILLS_GET, { name });
  },
  save(args: SkillSaveDTO): Promise<{ ok: true; filePath: string }> {
    return invoke(CH.SKILLS_SAVE, args);
  },
  delete(scope: 'user' | 'project', name: string): Promise<{ ok: boolean }> {
    return invoke(CH.SKILLS_DELETE, { scope, name });
  },
  run(name: string, argsString?: string): Promise<{ ok: boolean; expanded?: string; error?: string }> {
    return invoke(CH.SKILLS_RUN, { name, argsString });
  },
};

export const customAgentsApi = {
  list(): Promise<CustomAgentDTO[]> {
    return invoke(CH.AGENTS_LIST);
  },
  get(name: string): Promise<CustomAgentBodyDTO | null> {
    return invoke(CH.AGENTS_GET, { name });
  },
  save(args: CustomAgentSaveDTO): Promise<{ ok: true; filePath: string }> {
    return invoke(CH.AGENTS_SAVE, args);
  },
  delete(scope: 'user' | 'project', name: string): Promise<{ ok: boolean }> {
    return invoke(CH.AGENTS_DELETE, { scope, name });
  },
  history(): Promise<DispatchHistoryEntryDTO[]> {
    return invoke(CH.AGENTS_HISTORY);
  },
};

export const pluginsApi = {
  list(): Promise<PluginInfoDTO[]> {
    return invoke(CH.PLUGINS_LIST);
  },
  contributions(name: string): Promise<PluginContributionDTO | null> {
    return invoke(CH.PLUGINS_CONTRIBUTIONS, { name });
  },
  install(source: string): Promise<{ ok: boolean; manifest?: PluginInfoDTO; error?: string }> {
    return invoke(CH.PLUGINS_INSTALL, { source });
  },
  remove(name: string): Promise<{ ok: boolean }> {
    return invoke(CH.PLUGINS_REMOVE, { name });
  },
  toggle(name: string, enabled: boolean): Promise<{ ok: boolean; requiresRestart: boolean }> {
    return invoke(CH.PLUGINS_TOGGLE, { name, enabled });
  },
  i18n(
    locale: string,
    items: Array<{ name: string; description: string }>,
  ): Promise<Record<string, string>> {
    return invoke(CH.PLUGINS_I18N, { locale, items });
  },
  onProgress(cb: (event: PluginInstallProgressDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on) {
      const off = events.on(CH.EVT_PLUGIN_PROGRESS, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

export const boilerplatesApi = {
  list(): Promise<BoilerplateDTO[]> {
    return invoke(CH.BOILERPLATE_LIST);
  },
  prompts(slug: string): Promise<BoilerplatePromptDTO[]> {
    return invoke(CH.BOILERPLATE_PROMPTS, { slug });
  },
  apply(args: BoilerplateApplyRequestDTO): Promise<BoilerplateApplyResultDTO> {
    return invoke(CH.BOILERPLATE_APPLY, args);
  },
  onProgress(cb: (event: BoilerplateApplyProgressDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on) {
      const off = events.on(CH.EVT_BOILERPLATE_PROGRESS, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

export const mcpApi = {
  list(): Promise<McpServerListItemDTO[]> {
    return invoke(CH.MCP_LIST);
  },
  tools(): Promise<McpToolDTO[]> {
    return invoke(CH.MCP_TOOLS);
  },
  detail(name: string, logsLimit?: number): Promise<McpServerDetailDTO | null> {
    return invoke(CH.MCP_DETAIL, { name, logsLimit });
  },
  logs(name: string, limit?: number): Promise<string[]> {
    return invoke(CH.MCP_LOGS, { name, limit });
  },
  add(req: McpAddRequestDTO): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.MCP_ADD, req);
  },
  remove(name: string, scope?: 'user' | 'project'): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.MCP_REMOVE, { name, scope });
  },
  restart(name: string): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.MCP_RESTART, { name });
  },
  onStatus(cb: (event: McpStatusEventDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on) {
      const off = events.on(CH.EVT_MCP_STATUS, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
  onLog(cb: (event: McpLogEventDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on) {
      const off = events.on(CH.EVT_MCP_LOG, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

export const clusterApi = {
  config(): Promise<ClusterConfigDTO> {
    return invoke(CH.CLUSTER_CONFIG_GET);
  },
  setConfig(patch: Partial<ClusterConfigDTO>): Promise<{ ok: boolean }> {
    return invoke(CH.CLUSTER_CONFIG_SET, patch);
  },
  enable(enable: boolean): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.CLUSTER_ENABLE, { enable });
  },
  snapshot(): Promise<ClusterSnapshotDTO> {
    return invoke(CH.CLUSTER_PEERS);
  },
  trustList(): Promise<ClusterTrustEntryDTO[]> {
    return invoke(CH.CLUSTER_TRUST_LIST);
  },
  trustSet(req: ClusterTrustSetRequestDTO): Promise<{ ok: boolean }> {
    return invoke(CH.CLUSTER_TRUST_ADD, req);
  },
  trustRemove(peerId: string, scope?: string): Promise<{ ok: boolean }> {
    return invoke(CH.CLUSTER_TRUST_REMOVE, { peerId, scope });
  },
  syncNow(peerId: string): Promise<{ ok: boolean; pulled?: number; error?: string }> {
    return invoke(CH.CLUSTER_SYNC_NOW, { peerId });
  },
  onPeersUpdate(cb: (snapshot: ClusterSnapshotDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on) {
      const off = events.on(CH.EVT_PEERS_UPDATE, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

// ── Phase 14 + 15 imports ────────────────────────────────────────────────
import type {
  ProjectDTO,
  TaskDTO,
  TaskStatus,
  DumDTO,
  DumDetailDTO,
  WorktreeListItemDTO,
  PlanFileDTO,
  CoordinatorSnapshotDTOv2,
  GitStatusDTO,
  GitDiffRequestDTO,
  GitDiffDTO,
  GitBranchDTO,
  GitCommitRequestDTO,
  PullRequestDTO,
  PRCommentDTO,
  PRCreateRequestDTO,
  SecurityReviewDTO,
  TipDTO,
} from '@shared/types';

export const projectsApi = {
  list(): Promise<ProjectDTO[]> {
    return invoke(CH.PROJECTS_LIST);
  },
  setActive(args: { id: string; name: string; localPath?: string; tenantId?: string }): Promise<{ ok: boolean }> {
    return invoke(CH.PROJECTS_SET_ACTIVE, args);
  },
  create(args: { name: string; localPath?: string }): Promise<{ ok: boolean; project?: ProjectDTO; error?: string }> {
    return invoke(CH.PROJECTS_NEW, args);
  },
  onActiveChanged(cb: (project: ProjectDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on) {
      const off = events.on(CH.EVT_PROJECT_ACTIVE, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

export const tasksApi = {
  list(projectId: string): Promise<TaskDTO[]> {
    return invoke(CH.TASKS_LIST, { projectId });
  },
  run(taskId: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.TASKS_RUN, { taskId, projectId });
  },
  move(taskId: string, status: TaskStatus): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.TASKS_MOVE, { taskId, status });
  },
};

export const dumsApi = {
  list(projectId: string): Promise<DumDTO[]> {
    return invoke(CH.DUMS_LIST, { projectId });
  },
  detail(dumId: string): Promise<DumDetailDTO | null> {
    return invoke(CH.DUMS_DETAIL, { dumId });
  },
};

export const planApi = {
  get(dumNumber?: string): Promise<PlanFileDTO | null> {
    return invoke(CH.PLAN_GET, { dumNumber });
  },
  save(content: string, dumNumber?: string): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.PLAN_SAVE, { content, dumNumber });
  },
};

export const worktreeApi = {
  list(cwd?: string): Promise<WorktreeListItemDTO[]> {
    return invoke(CH.WORKTREE_LIST, { cwd });
  },
  create(dumNumber: string, cwd?: string): Promise<{ ok: boolean; handle?: any; error?: string }> {
    return invoke(CH.WORKTREE_CREATE, { dumNumber, cwd });
  },
  merge(handle: any): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.WORKTREE_MERGE, handle);
  },
  cleanup(handle: any): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.WORKTREE_CLEANUP, handle);
  },
  onChanged(cb: (state: import('@shared/types').WorktreeDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on) {
      const off = events.on(CH.EVT_WORKTREE, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

export const coordinatorApi = {
  status(): Promise<CoordinatorSnapshotDTOv2> {
    return invoke(CH.COORDINATOR_STATUS);
  },
  onUpdate(cb: (snap: import('@shared/types').CoordinatorSnapshotDTO) => void): () => void {
    const events = (window as any).makestudio?.events;
    if (events?.on) {
      const off = events.on(CH.EVT_COORDINATOR, cb);
      return typeof off === 'function' ? off : () => {};
    }
    return () => {};
  },
};

// ── Phase 15 — Git ───────────────────────────────────────────────────────

export const gitApi = {
  status(cwd?: string): Promise<GitStatusDTO> {
    return invoke(CH.GIT_STATUS, { cwd });
  },
  diff(args: GitDiffRequestDTO): Promise<GitDiffDTO> {
    return invoke(CH.GIT_DIFF, args);
  },
  branches(cwd?: string): Promise<GitBranchDTO[]> {
    return invoke(CH.GIT_COMMIT, { op: 'branches', cwd }).then((r: any) => r?.data ?? []);
  },
  commit(args: GitCommitRequestDTO): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return invoke(CH.GIT_COMMIT, args);
  },
};

export const prApi = {
  list(state?: 'open' | 'closed' | 'all', cwd?: string): Promise<{ ok: boolean; data?: PullRequestDTO[]; error?: string }> {
    return invoke(CH.GIT_PR, { op: 'list', state, cwd });
  },
  view(number: number, cwd?: string): Promise<{ ok: boolean; data?: PullRequestDTO; error?: string }> {
    return invoke(CH.GIT_PR, { op: 'view', number, cwd });
  },
  comments(number: number, cwd?: string): Promise<{ ok: boolean; data?: PRCommentDTO[]; error?: string }> {
    return invoke(CH.GIT_PR, { op: 'comments', number, cwd });
  },
  create(create: PRCreateRequestDTO, cwd?: string): Promise<{ ok: boolean; data?: PullRequestDTO; error?: string }> {
    return invoke(CH.GIT_PR, { op: 'create', create, cwd });
  },
};

export const securityApi = {
  run(args: { cli?: string; base?: string; cwd?: string }): Promise<SecurityReviewDTO> {
    return invoke(CH.SECURITY_REVIEW_RUN, args);
  },
};

// ── Phase 16 — Tips ──────────────────────────────────────────────────────

export const feedbackApi = {
  send(args: { category: string; text: string; attachLogs?: boolean }): Promise<{ ok: boolean; error?: string }> {
    return invoke(CH.FEEDBACK_SEND, args);
  },
};

export const tipsApi = {
  list(): Promise<TipDTO[]> {
    return invoke(CH.TIPS_LIST);
  },
  pickNext(): Promise<{ tip: TipDTO | null }> {
    return invoke(CH.TIPS_PICK_NEXT);
  },
  setDisabled(disable: boolean): Promise<{ ok: boolean; tipsDisabled: boolean }> {
    return invoke(CH.TIPS_DISMISS, { disable });
  },
};
