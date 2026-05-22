import { io, Socket } from 'socket.io-client';
import { loadConfig } from '../config/config';
import { AgentRegistration, TaskDispatch, PipelineDispatch, DecompositionDispatch, AnalysisTrigger } from '../types';

let socket: Socket | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export interface WSClientOptions {
  onConnect: () => void;
  onDisconnect: (reason: string) => void;
  onError: (error: { message: string }) => void;
  onTaskDispatch: (task: TaskDispatch) => void;
  onPipelineDispatch: (pipeline: PipelineDispatch) => void;
  onDecompositionDispatch: (data: DecompositionDispatch) => void;
  onAnalysisTrigger?: (data: AnalysisTrigger) => void;
  onTaskCancel: (data: { taskId: string; reason: string }) => void;
  onDecompositionCancel?: (data: { projectId: string; reason: string }) => void;
  onSessionReplaced: (data: { message: string }) => void;
  onBootstrapRepoDispatch?: (data: {
    jobId: string;
    projectId: string;
    owner: string;
    name: string;
    private: boolean;
    boilerplateId: string;
  }) => void;
}

export function connectWebSocket(
  token: string,
  options: WSClientOptions,
): Socket {
  const config = loadConfig();
  const serverUrl = config?.serverUrl || 'https://api.zielinski.dev.br';

  socket = io(`${serverUrl}/agent-gateway`, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
    timeout: 30000,
  });

  let reconnectCount = 0;

  socket.on('connect', () => {
    // Connected to dark-factory backend → we're in dispatch mode now.
    // Lock down the agent's local execution surface for the duration of
    // the connected session:
    //
    //  1. Enable subprocess env scrubbing so secrets (provider API keys,
    //     OAuth tokens, cloud creds) don't leak into Bash/MCP/hook
    //     subprocesses spawned from a remote-dispatched task.
    //
    //  2. Force allowManagedHooksOnly. In dispatch mode the workspace is
    //     a freshly-cloned repo controlled by the dark-factory pipeline —
    //     a malicious or stale .makestudio/hooks.json in the workspace
    //     must not execute. Only plugin/builtin hooks (which are part of
    //     the agent binary itself) get to run.
    //
    // Both flags are only set when undefined / not already true, so the
    // operator can override either explicitly via env or settings.
    if (process.env.MAKESTUDIO_SUBPROCESS_ENV_SCRUB === undefined) {
      process.env.MAKESTUDIO_SUBPROCESS_ENV_SCRUB = '1';
    }
    if (process.env.MAKESTUDIO_FORCE_MANAGED_HOOKS_ONLY === undefined) {
      // Session-only flag (process.env, not persisted to disk). Read by
      // hooks.ts:loadHooks(). The user can override with explicit settings
      // (settings.policy.allowManagedHooksOnly=false) if they really need
      // project hooks during a dispatched session.
      process.env.MAKESTUDIO_FORCE_MANAGED_HOOKS_ONLY = '1';
    }

    if (reconnectCount > 0) {
      // Re-connected after losing connection
      options.onConnect();
    } else {
      options.onConnect();
    }
    reconnectCount++;
    startHeartbeat();
  });

  socket.on('disconnect', (reason: string) => {
    stopHeartbeat();
    options.onDisconnect(reason);
  });

  socket.io.on('reconnect_attempt', (attempt: number) => {
    // Socket.io is trying to reconnect — this is normal during network drops
  });

  socket.io.on('reconnect', (attempt: number) => {
    // Successfully reconnected
  });

  socket.on('error', (error: any) => {
    options.onError(error);
  });

  socket.on('task:dispatch', (data: TaskDispatch) => {
    options.onTaskDispatch(data);
  });

  socket.on('pipeline:dispatch', (data: PipelineDispatch) => {
    options.onPipelineDispatch(data);
  });

  socket.on('decomposition:dispatch', (data: DecompositionDispatch) => {
    options.onDecompositionDispatch(data);
  });

  socket.on('analysis:trigger', (data: AnalysisTrigger) => {
    if (options.onAnalysisTrigger) options.onAnalysisTrigger(data);
  });

  socket.on('bootstrap-repo:dispatch', (data: any) => {
    if (options.onBootstrapRepoDispatch) options.onBootstrapRepoDispatch(data);
  });

  socket.on('task:cancel', (data: { taskId: string; reason: string }) => {
    options.onTaskCancel(data);
  });

  // Backend emits this when the user cancels a decomposition mid-run via
  // /dark-factory/projects/:id/decomposition (DELETE) — without this handler
  // the agent ignored it and runDecompose would burn its full budget anyway.
  socket.on('decomposition:cancel', (data: { projectId: string; reason: string }) => {
    if (options.onDecompositionCancel) options.onDecompositionCancel(data);
  });

  socket.on('session:replaced', (data: { message: string }) => {
    stopHeartbeat();
    options.onSessionReplaced(data);
  });

  socket.on('connect_error', (err: Error) => {
    options.onError({ message: `Erro de conexão: ${err.message}` });
  });

  return socket;
}

export function registerAgent(registration: AgentRegistration): void {
  if (socket?.connected) {
    socket.emit('agent:register', registration);
  }
}

export function emitDecompositionProgress(data: {
  projectId: string;
  lastTool?: string;
  lastDetail?: string;
  lastMessage?: string;
  toolCallCount?: number;
  dumsFound?: number;
  elapsedMs?: number;
}): void {
  if (socket?.connected) {
    socket.emit('decomposition:progress', data);
  }
}

export function emitTaskProgress(
  taskId: string,
  type: string,
  elapsed: number,
  data: { tool?: string; file?: string; message?: string },
): void {
  if (socket?.connected) {
    socket.emit('task:progress', { taskId, type, elapsed, data });
  }
}

export function emitTaskCompleted(
  taskId: string,
  content: string | null,
  costUsd: number,
  gitInfo?: { branch?: string; commits?: number; pushed?: boolean },
): void {
  if (socket?.connected) {
    socket.emit('task:completed', { taskId, content, costUsd, gitInfo });
  }
}

export function emitTaskFailed(
  taskId: string,
  error: string,
  costUsd: number = 0,
): void {
  if (socket?.connected) {
    socket.emit('task:failed', { taskId, error, costUsd });
  }
}

export function emitBootstrapRepoCompleted(
  jobId: string,
  repoUrl: string,
  branch: string,
): void {
  if (socket?.connected) {
    socket.emit('bootstrap-repo:completed', { jobId, repoUrl, branch });
  }
}

export function emitBootstrapRepoFailed(jobId: string, error: string): void {
  if (socket?.connected) {
    socket.emit('bootstrap-repo:failed', { jobId, error });
  }
}

export function disconnectWebSocket(): void {
  stopHeartbeat();
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (socket?.connected) {
      socket.emit('agent:heartbeat');
    }
  }, 30_000); // every 30 seconds
}

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function getSocket(): Socket | null {
  return socket;
}
