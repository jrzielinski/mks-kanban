export interface MakeStudioConfig {
  serverUrl: string;
  token: string;
  refreshToken?: string;
  userId?: number;
  tenantId?: string;
  email?: string;
  sessionId?: string;
  /** Multi-repo local paths configured via wizard */
  repos?: AgentRepos;
  /** Whether the wizard has been completed */
  wizardConfigured?: boolean;
  /** Saved CLI preference — skips CLI selection on start */
  preferredCli?: string;
  /**
   * Extra CLI flags appended after the required args for each CLI.
   * Edit ~/.makestudio/config.json directly to add/remove flags without reinstalling.
   * Example:
   *   "cliExtraFlags": { "claude": ["--disallowed-tools", "Agent"], "codex": [], "gemini": [] }
   */
  cliExtraFlags?: {
    claude?: string[];
    codex?: string[];
    gemini?: string[];
    /** Self-hosting: flags appended when DarkFactory spawns `makestudio -p` as
     *  the executor CLI. Useful for `--max-turns`, `--json`, etc. overrides. */
    makestudio?: string[];
  };
  /** Registered boilerplates — slug → local path mapping */
  boilerplates?: BoilerplateEntry[];
}

export interface BoilerplateEntry {
  /** Unique identifier used to reference this boilerplate */
  slug: string;
  /** Human-readable name */
  name: string;
  /** Absolute local path to the boilerplate directory */
  localPath: string;
  /** Technology stacks this boilerplate covers (lowercase) */
  stacks: string[];
  /** Minimum project complexity level */
  difficultyMin?: number;
  /** Maximum project complexity level */
  difficultyMax?: number;
  /** Optional description */
  description?: string;
}

export interface AgentRepos {
  backend?: { path: string };
  frontend?: { path: string };
  mobile?: { path: string };
}

export interface AgentRegistration {
  agentId: string;
  hostname: string;
  availableCLIs: string[];
  repoPath: string;
  projectIds: string[];
  /** Multi-repo: local paths per layer (backend/frontend/mobile) */
  repos?: AgentRepos;
}

export interface TaskDispatch {
  taskId: string;
  taskTitle?: string;
  taskType?: string;
  prompt: string;
  cli: string;
  taskBranch?: string;
  repoUrl?: string;
  gitToken?: string;
  maxTurns?: number;
  oneshot?: boolean; // skip repo/git ops — just run CLI and return output
  /** Which layer this task targets — used to select local repo path when repoUrl is not set */
  repoLayer?: 'backend' | 'frontend' | 'mobile';
  /** Extra context from backend hooks (KB, PRD, slop cleaner) — appended to prompt */
  hookContext?: string;
  /** Model tier recommended by smart routing */
  modelTier?: 'fast' | 'standard' | 'advanced';
  /** Persistence mode: retry until success */
  persistenceMode?: boolean;
  /** Max retry attempts (default 3, persistence mode up to 10) */
  maxRetries?: number;
  /**
   * CLAUDE.md content written to the repo root before invoking the CLI so
   * Claude Code picks up rules, boilerplate, and prior-task summary without
   * paying for them in every prompt.
   */
  claudeMd?: string;
  /**
   * Session identifier shared across tasks of the same pipeline/branch.
   * When seen twice on the same branch the agent passes `--continue` to
   * Claude Code so the conversation memory is preserved.
   */
  sessionId?: string;
}

export interface TaskProgress {
  taskId: string;
  type: string;
  elapsed: number;
  data: {
    tool?: string;
    file?: string;
    message?: string;
  };
}

export interface TaskResult {
  taskId: string;
  content: string | null;
  costUsd: number;
  gitInfo?: {
    branch?: string;
    commits?: number;
    pushed?: boolean;
  };
}

export interface PipelineDispatch {
  pipelineId: string;
  tasks: {
    taskId: string;
    taskTitle: string;
    taskType: string;
    prompt: string;
    index: number;
    total: number;
    /** Hook context from backend (KB, PRD, slop cleaner) */
    hookContext?: string;
  }[];
  cli: string;
  taskBranch?: string;
  repoUrl?: string;
  gitToken?: string;
  /** Model tier for the pipeline */
  modelTier?: 'fast' | 'standard' | 'advanced';
  /** CLAUDE.md content written to the repo root before spawning the CLI. */
  claudeMd?: string;
  /** Pipeline session id — enables --continue across sequential tasks. */
  sessionId?: string;
}

export interface DecompositionDispatch {
  projectId: string;
  projectName: string;
  requirements: Array<{
    id: string;
    title: string;
    description: string;
    type: string;
    priority: string;
    tag: string;
    source?: string;
  }>;
  codebaseAnalysis?: any;
  existingDums?: Array<{ id: string; title: string; dumNumber: string; tasks?: string[] }>;
  stack?: any;
  cli: string;
  repoPath?: string;
  /** Full context fields from buildDecompositionContext — same 14 sections as LLM API */
  boilerplateContext?: string | null;
  decisions?: Array<{ id: string; title: string; status: string; rationale?: string; decisionNumber?: number }>;
  designSystem?: any;
  clarifications?: Array<{ question: string; status: string; response?: string }>;
  textResults?: Array<{ title: string; snippet?: string; url?: string }>;
  imageResults?: Array<{ title: string; imageUrl: string; sourceUrl?: string }>;
  flowBuilderContext?: any;
  /** Prompt from backend — single source of truth */
  systemPrompt?: string;
  /** Instruction/rules prompt from backend — decomposition rules, quality requirements, output format */
  instructionPrompt?: string;
}

export interface AnalysisTrigger {
  projectId: string;
  projectName?: string;
  localPath?: string;
}

export interface CLIInfo {
  name: string;
  version: string;
  path: string;
}

export interface LoginResponse {
  token: string;
  refreshToken: string;
  tokenExpires: number;
  user: {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    tenantId: string;
  };
}
