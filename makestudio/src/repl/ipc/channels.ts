/**
 * IPC channel names shared between Electron main and renderer.
 * Single source of truth — both sides import from here via path aliases:
 *   - main/preload:  `../src/repl/ipc/channels`
 *   - renderer:      `@shared/channels`
 *
 * Naming convention:
 *   - `domain:verb` for request/response (ipcRenderer.invoke)
 *   - `domain:event` for push events (webContents.send)
 *   - `domain:*:resolve` for renderer replies to main-initiated prompts
 */

// ── Renderer → Main (invoke) ────────────────────────────────────────────

// Agent core
export const AGENT_SUBMIT = 'agent:submit';
export const AGENT_ABORT = 'agent:abort';
export const AGENT_CLEAR = 'agent:clear';
export const AGENT_STATE = 'agent:state';
export const AGENT_MESSAGES = 'agent:messages';
export const AGENT_COMPLETIONS = 'agent:completions';
export const AGENT_STORE_PASTE = 'agent:storePastedText';
export const AGENT_EXPAND_PASTE = 'agent:expandPasteMarkers';
export const AGENT_ATTACHMENTS_IMPORT = 'agent:attachments:import';
export const AGENT_IMAGE_PASTE = 'agent:imagePaste:fromClipboard';
export const ATTACHMENTS_LIST_FILES = 'attachments:listFiles';
export const ATTACHMENTS_STORE_IMAGE = 'attachments:storeImage';
export const ATTACHMENTS_STORE_FILE_PATH = 'attachments:storeFilePath';

// Sessions / history / rewind / cassettes
export const SESSIONS_LIST = 'sessions:list';
export const SESSIONS_OPEN = 'sessions:open';
export const SESSIONS_RESUME = 'sessions:resume';
export const SESSIONS_FORK = 'sessions:fork';
export const SESSIONS_RENAME = 'sessions:rename';
export const SESSIONS_TAG = 'sessions:tag';
export const SESSIONS_DELETE = 'sessions:delete';
export const SESSIONS_EXPORT = 'sessions:export';
export const SESSIONS_SEARCH = 'sessions:search';
export const REWIND_LIST = 'rewind:list';
export const REWIND_RESTORE = 'rewind:restore';
export const REWIND_CLEAR = 'rewind:clear';
export const FILE_HISTORY_LIST = 'fileHistory:list';
export const FILE_HISTORY_RESTORE = 'fileHistory:restore';
export const FILE_HISTORY_CLEAR = 'fileHistory:clear';
export const CASSETTES_LIST = 'cassettes:list';
export const CASSETTES_REPLAY = 'cassettes:replay';
export const CASSETTES_RECORD_START = 'cassettes:record:start';
export const CASSETTES_RECORD_STOP = 'cassettes:record:stop';

// Memory
export const MEMORY_LIST = 'memory:list';
export const MEMORY_GET = 'memory:get';
export const MEMORY_SAVE = 'memory:save';
export const MEMORY_DELETE = 'memory:delete';
export const MEMORY_REBUILD = 'memory:rebuild';
export const MEMORY_SIMILAR = 'memory:similar';
export const MEMORY_SYNC_STATUS = 'memory:sync:status';

// Schedule + daemon
export const SCHEDULE_LIST = 'schedule:list';
export const SCHEDULE_ADD = 'schedule:add';
export const SCHEDULE_UPDATE = 'schedule:update';
export const SCHEDULE_REMOVE = 'schedule:remove';
export const SCHEDULE_ENABLE = 'schedule:enable';
export const SCHEDULE_NEXT = 'schedule:next';
export const SCHEDULE_RUN_NOW = 'schedule:runNow';
export const SCHEDULE_RUNS = 'schedule:runs';
export const DAEMON_STATUS = 'daemon:status';
export const DAEMON_INSTALL = 'daemon:install';
export const DAEMON_UNINSTALL = 'daemon:uninstall';

// Permissions
export const PERMISSIONS_GET = 'permissions:get';
export const PERMISSIONS_SAVE = 'permissions:save';
export const PERMISSIONS_SHADOW = 'permissions:shadow:detect';
export const PERMISSIONS_TEST = 'permissions:test';
export const PERMISSIONS_MODE_SET = 'permissions:pmode:set';
export const PERMISSIONS_TRUST_LIST = 'permissions:trust:list';
export const PERMISSIONS_TRUST_ADD = 'permissions:trust:add';
export const PERMISSIONS_TRUST_REMOVE = 'permissions:trust:remove';

// Hooks
export const HOOKS_LIST = 'hooks:list';
export const HOOKS_SAVE = 'hooks:save';
export const HOOKS_TEST = 'hooks:test';

// MCP
export const MCP_LIST = 'mcp:list';
export const MCP_ADD = 'mcp:add';
export const MCP_REMOVE = 'mcp:remove';
export const MCP_RESTART = 'mcp:restart';
export const MCP_TOOLS = 'mcp:tools';
export const MCP_LOGS = 'mcp:logs';
export const MCP_DETAIL = 'mcp:detail';

// Cluster
export const CLUSTER_CONFIG_GET = 'cluster:config:get';
export const CLUSTER_CONFIG_SET = 'cluster:config:set';
export const CLUSTER_ENABLE = 'cluster:enable';
export const CLUSTER_PEERS = 'cluster:peers';
export const CLUSTER_TRUST_LIST = 'cluster:trust:list';
export const CLUSTER_TRUST_ADD = 'cluster:trust:add';
export const CLUSTER_TRUST_REMOVE = 'cluster:trust:remove';
export const CLUSTER_SYNC_NOW = 'cluster:sync:now';

// Providers / models / auth
export const PROVIDERS_CATALOG = 'providers:catalog';
export const PROVIDERS_SET = 'providers:set';
export const PROVIDERS_COSTS = 'providers:currentCosts';
export const PROVIDERS_EFFORT_SET = 'providers:effort:set';
export const PROVIDERS_TEST = 'providers:test';
export const EVT_PROVIDERS_CHANGED = 'providers:changed';

// API configs (Zielinski Cloud) — lista e troca da config ativa.
export const API_CONFIGS_LIST = 'apiConfigs:list';
export const API_CONFIGS_ACTIVATE = 'apiConfigs:activate';
export const AUTH_LOGIN = 'auth:login';
export const AUTH_LOGOUT = 'auth:logout';
export const AUTH_STATUS = 'auth:status';
export const AUTH_REFRESH = 'auth:refresh';
export const AUTH_HEARTBEAT = 'auth:heartbeat';
export const EVT_AUTH_CHANGED = 'auth:changed';

// Projects / DarkFactory
export const PROJECTS_LIST = 'projects:list';
export const PROJECTS_SET_ACTIVE = 'projects:setActive';
export const PROJECTS_NEW = 'projects:new';
export const BOILERPLATE_LIST = 'projects:boilerplate:list';
export const BOILERPLATE_APPLY = 'projects:boilerplate:apply';
export const TASKS_LIST = 'tasks:list';
export const TASKS_RUN = 'tasks:run';
export const TASKS_MOVE = 'tasks:move';
export const DUMS_LIST = 'dums:list';
export const DUMS_DETAIL = 'dums:detail';
export const PLAN_GET = 'plan:get';
export const PLAN_SAVE = 'plan:save';
export const DOCTOR_RUN = 'doctor:run';
export const ANALYZE_RUN = 'analyze:run';
export const REFINE_RUN = 'refine:run';
export const EXECUTE_RUN = 'execute:run';
export const COORDINATOR_STATUS = 'coordinator:status';

// Worktree + git
export const WORKTREE_LIST = 'worktree:list';
export const WORKTREE_CREATE = 'worktree:create';
export const WORKTREE_MERGE = 'worktree:merge';
export const WORKTREE_CLEANUP = 'worktree:cleanup';
export const GIT_STATUS = 'git:status';
export const GIT_DIFF = 'git:diff';
export const GIT_COMMIT = 'git:commit';
export const GIT_PR = 'git:pr';
export const SECURITY_REVIEW_RUN = 'securityReview:run';

// Skills / agents / plugins
export const SKILLS_LIST = 'skills:list';
export const SKILLS_GET = 'skills:get';
export const SKILLS_SAVE = 'skills:save';
export const SKILLS_DELETE = 'skills:delete';
export const SKILLS_RUN = 'skills:run';
export const SKILLS_IMPORT = 'skills:import';
export const SKILLS_EXPORT = 'skills:export';
export const AGENTS_LIST = 'agents:list';
export const AGENTS_GET = 'agents:get';
export const AGENTS_SAVE = 'agents:save';
export const AGENTS_DELETE = 'agents:delete';
export const AGENTS_HISTORY = 'agents:history';
export const PLUGINS_LIST = 'plugins:list';
export const PLUGINS_INSTALL = 'plugins:install';
export const PLUGINS_REMOVE = 'plugins:remove';
export const PLUGINS_TOGGLE = 'plugins:toggle';
export const PLUGINS_CONTRIBUTIONS = 'plugins:contributions';
export const PLUGINS_I18N = 'plugins:i18n';
export const EVT_PLUGIN_PROGRESS = 'plugins:progress';
export const BOILERPLATE_PROMPTS = 'projects:boilerplate:prompts';
export const EVT_BOILERPLATE_PROGRESS = 'projects:boilerplate:progress';

// Settings / theme / UI
export const SETTINGS_GET = 'settings:get';
export const SETTINGS_SET = 'settings:set';
export const THEME_LIST = 'theme:list';
export const THEME_PREVIEW = 'theme:preview';
export const OUTPUT_STYLE_LIST = 'outputStyle:list';
export const OUTPUT_STYLE_SET = 'outputStyle:set';
export const OUTPUT_STYLE_GET_BODY = 'outputStyle:getBody';
export const OUTPUT_STYLE_SAVE = 'outputStyle:save';
export const OUTPUT_STYLE_DELETE = 'outputStyle:delete';
export const KEYBINDINGS_GET = 'keybindings:get';
export const KEYBINDINGS_SET = 'keybindings:set';
export const STATUSLINE_GET = 'statusline:config:get';
export const STATUSLINE_SET = 'statusline:config:set';
export const FLAGS_GET = 'flags:get';
export const FLAGS_SET = 'flags:set';

// Usage / monitor / debug / health / tips
export const USAGE_EVENTS = 'usage:events';
export const USAGE_AGGREGATE = 'usage:aggregate';
export const USAGE_HEATMAP = 'usage:heatmap';
export const USAGE_STREAKS = 'usage:streaks';
export const USAGE_EXPORT_CSV = 'usage:export:csv';
export const CTX_SUMMARY = 'ctx:summary';
export const STATS_GET = 'stats:get';
export const DEBUG_LOGS_TAIL = 'debug:logs:tail';
export const DEBUG_LOGS_FOLLOW_START = 'debug:logs:follow:start';
export const DEBUG_LOGS_FOLLOW_STOP = 'debug:logs:follow:stop';
export const DEBUG_LOGS_LIST_SESSIONS = 'debug:logs:sessions:list';
export const TIPS_LIST = 'tips:list';
export const TIPS_PICK_NEXT = 'tips:pickNext';
export const TIPS_DISMISS = 'tips:dismiss';
export const HEALTH_CHECK = 'health:check';
export const FEEDBACK_SEND = 'feedback:send';

// Headless runner
export const HEADLESS_RUN = 'headless:run';
export const HEADLESS_STOP = 'headless:stop';

// Window / system / dialog / app
export const WINDOW_MINIMIZE = 'window:minimize';
export const WINDOW_MAXIMIZE = 'window:maximize';
export const WINDOW_CLOSE = 'window:close';
export const WINDOW_OPEN_EXTERNAL = 'window:openExternal';
export const DIALOG_OPEN_FILE = 'dialog:openFile';
export const DIALOG_OPEN_DIR = 'dialog:openDir';
export const DIALOG_SAVE_FILE = 'dialog:saveFile';
export const SHELL_SHOW_ITEM = 'shell:showItemInFolder';
export const APP_VERSION = 'app:version';
export const APP_RELAUNCH = 'app:relaunch';

// IDE bridge — used when the agent runs inside the VS Code extension
// host. Lets the renderer (and the agent's IdeOpen tool) ask the IDE to
// open a file in an editor. No-ops on Electron/CLI builds.
export const IDE_OPEN_FILE = 'ide:openFile';

// Event published BY the extension host whenever the user changes the
// active editor. Payload: { path: string|null, languageId?: string,
// lineCount?: number }. Renderer pins this as the "agent is editing"
// context chip and the AGENT_SUBMIT handler prepends a hint so the
// LLM knows which file the user is staring at.
export const IDE_ACTIVE_FILE = 'ide:activeFile';

// Invoke (request/response) counterpart of IDE_ACTIVE_FILE. The renderer
// calls this on mount to pull the CURRENT active file — the broadcast
// event above is fire-and-forget and is missed when the webview mounts
// after the host already computed the pin (the common case). Returns
// the same payload shape as the event, or null.
export const IDE_ACTIVE_FILE_GET = 'ide:activeFile:get';

// Invoke — renderer asks the extension host to open a brand-new chat tab
// (a fresh ChatPanel with an empty session), Claude-Code-style. No-op on
// Electron/CLI builds (handler simply isn't registered there).
export const IDE_NEW_TAB = 'ide:newTab';

// ── Renderer → Main (resolve pending prompts) ──────────────────────────

export const AGENT_PICKER_RESOLVE = 'agent:picker:resolve';
export const AGENT_PERMISSION_RESOLVE = 'agent:permission:resolve';
export const AGENT_QUESTION_RESOLVE = 'agent:question:resolve';
export const AGENT_SUGGESTION_CONSUME = 'agent:suggestion:consume';

// ── Main → Renderer (push events) ──────────────────────────────────────

// Agent state
export const EVT_MESSAGE_ADD = 'agent:message:add';
export const EVT_MESSAGE_UPDATE = 'agent:message:update';
export const EVT_MESSAGE_CLEAR = 'agent:message:clear';
export const EVT_BUSY = 'agent:busy';
export const EVT_STREAM_TOKENS = 'agent:stream-tokens';
export const EVT_CURRENT_TOOL = 'agent:current-tool';
export const EVT_AGENT_SUMMARY = 'agent:agent-summary';
export const EVT_SUGGESTION = 'agent:suggestion';
export const EVT_TRANSIENT_STATUS = 'agent:transient-status';
export const EVT_TOAST = 'agent:toast';
export const EVT_COORDINATOR = 'agent:coordinator:update';
export const EVT_USAGE_OPEN = 'agent:usage:open';
export const EVT_CONTEXT_PCT = 'agent:context-pct';

// Prompts (main-initiated)
export const EVT_PICKER_OPEN = 'agent:picker:open';
export const EVT_PICKER_CLOSE = 'agent:picker:close';
export const EVT_PERMISSION_REQUEST = 'agent:permission:request';
export const EVT_PERMISSION_CLOSE = 'agent:permission:close';
export const EVT_QUESTION_REQUEST = 'agent:question:request';
export const EVT_QUESTION_CLOSE = 'agent:question:close';

// Sessions / schedule / peers / MCP
export const EVT_SESSIONS_UPDATED = 'sessions:updated';
export const EVT_SCHEDULE_DUE = 'schedule:due';
export const EVT_DAEMON_STATUS = 'schedule:daemon:status';
export const EVT_PEERS_UPDATE = 'peers:update';
export const EVT_PEERS_SYNC_PROGRESS = 'peers:sync:progress';
export const EVT_MCP_STATUS = 'mcp:status';
export const EVT_MCP_LOG = 'mcp:log';

// Plan mode / worktree / project active
export const EVT_PLAN_MODE = 'plan-mode:changed';
export const EVT_WORKTREE = 'worktree:changed';
export const EVT_PROJECT_ACTIVE = 'project:active-changed';

// Auth / settings
export const EVT_LICENSE_UPDATE = 'auth:license-update';
export const EVT_SETTINGS_CHANGED = 'settings:changed';

// Navigation (main → renderer)
export const EVT_NAVIGATE = 'app:navigate';

// Headless + debug
export const EVT_HEADLESS_OUTPUT = 'headless:output';
export const EVT_HEADLESS_DONE = 'headless:done';
export const EVT_DEBUG_LOG_LINE = 'debug:logs:line';
