// flowbuilder/src/services/kanbanAgent.service.ts
import { api } from '@/lib/api';
import { io, Socket } from 'socket.io-client';

export type ExecType = 'code' | 'analysis' | 'mockup' | 'tests' | 'review' | 'custom';
export type ExecStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface KanbanBoardRepo {
  id: string;
  boardId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  gitToken?: string | null;
  tenantId: string;
  createdAt: string;
}

export interface KanbanListAgentConfig {
  id: string;
  listId: string;
  boardId: string;
  enabled: boolean;
  defaultExecType: ExecType | null;
  defaultRepoId: string | null;
  defaultBranch: string | null;
  promptPrefix: string | null;
  moveOnCompleteListId: string | null;
  moveOnFailListId: string | null;
}

export interface KanbanAgentExecution {
  id: string;
  cardId: string;
  boardId: string;
  listId: string;
  execType: ExecType;
  prompt: string;
  repoUrl: string | null;
  branchCreated: string | null;
  gitCommits: number | null;
  gitPushed: boolean;
  status: ExecStatus;
  result: string | null;
  costUsd: number;
  agentSocketId: string | null;
  agentMachine: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  tenantId: string;
  userId: string | null;
}

export interface AgentStatus {
  connected: boolean;
  agentCount: number;
}

// ── Agent Status ─────────────────────────────────────────────────────────────

export const getAgentStatus = async (): Promise<AgentStatus> => {
  const { data } = await api.get('/kanban/agent/status');
  return data;
};

// ── Board Repos ──────────────────────────────────────────────────────────────

export const listBoardRepos = async (boardId: string): Promise<KanbanBoardRepo[]> => {
  const { data } = await api.get(`/kanban/boards/${boardId}/repos`);
  return data;
};

export const createBoardRepo = async (
  boardId: string,
  payload: { name: string; repoUrl: string; defaultBranch?: string; gitToken?: string },
): Promise<KanbanBoardRepo> => {
  const { data } = await api.post(`/kanban/boards/${boardId}/repos`, payload);
  return data;
};

export const updateBoardRepo = async (
  boardId: string,
  repoId: string,
  payload: { name?: string; repoUrl?: string; defaultBranch?: string; gitToken?: string },
): Promise<KanbanBoardRepo> => {
  const { data } = await api.put(`/kanban/boards/${boardId}/repos/${repoId}`, payload);
  return data;
};

export const deleteBoardRepo = async (boardId: string, repoId: string): Promise<void> => {
  await api.delete(`/kanban/boards/${boardId}/repos/${repoId}`);
};

// ── List Agent Config ────────────────────────────────────────────────────────

export const getListAgentConfig = async (listId: string): Promise<KanbanListAgentConfig | null> => {
  const { data } = await api.get(`/kanban/lists/${listId}/agent-config`);
  return data;
};

export const upsertListAgentConfig = async (
  listId: string,
  boardId: string,
  payload: Partial<KanbanListAgentConfig>,
): Promise<KanbanListAgentConfig> => {
  const { data } = await api.put(`/kanban/lists/${listId}/agent-config`, { ...payload, boardId });
  return data;
};

export const deleteListAgentConfig = async (listId: string): Promise<void> => {
  await api.delete(`/kanban/lists/${listId}/agent-config`);
};

// ── Card Executions ──────────────────────────────────────────────────────────

export const listCardExecutions = async (cardId: string): Promise<KanbanAgentExecution[]> => {
  const { data } = await api.get(`/kanban/cards/${cardId}/executions`);
  return data;
};

export const executeCard = async (
  cardId: string,
  payload: { execType: ExecType; repoId?: string; branch?: string; customPrompt?: string },
): Promise<{ execId: string }> => {
  const { data } = await api.post(`/kanban/cards/${cardId}/execute`, payload);
  return data;
};

export const cancelExecution = async (cardId: string, execId: string): Promise<void> => {
  await api.delete(`/kanban/cards/${cardId}/executions/${execId}`);
};

// ── Socket.io live log ───────────────────────────────────────────────────────

export interface ExecProgressEvent {
  execId: string;
  content: string;
  type: 'progress' | 'completed' | 'failed';
}

let _socket: Socket | null = null;

function getSocket(token: string): Socket {
  if (!_socket || !_socket.connected) {
    _socket = io('/agent-gateway', {
      auth: { token },
      transports: ['websocket'],
    });
  }
  return _socket;
}

export function subscribeToExecution(
  execId: string,
  token: string,
  onProgress: (evt: ExecProgressEvent) => void,
): () => void {
  const socket = getSocket(token);

  const handler = (evt: ExecProgressEvent) => {
    if (evt.execId === execId) onProgress(evt);
  };

  socket.on('kanban:exec:progress', handler);
  socket.emit('kanban:exec:join', { execId });

  return () => {
    socket.off('kanban:exec:progress', handler);
  };
}

export function subscribeToAgentStatus(
  token: string,
  onStatusChanged: (status: AgentStatus) => void,
): () => void {
  const socket = getSocket(token);
  socket.on('agent:status:changed', onStatusChanged);
  return () => {
    socket.off('agent:status:changed', onStatusChanged);
  };
}

// Exec type labels and icons (as strings for simplicity — use Lucide icons in components)
export const EXEC_TYPE_LABELS: Record<ExecType, string> = {
  code: 'Código',
  analysis: 'Análise',
  mockup: 'Mockup',
  tests: 'Testes',
  review: 'Revisão',
  custom: 'Prompt livre',
};

export const EXEC_TYPE_EMOJIS: Record<ExecType, string> = {
  code: '💻',
  analysis: '📊',
  mockup: '🎨',
  tests: '🧪',
  review: '🔍',
  custom: '✏️',
};

export const STATUS_LABELS: Record<ExecStatus, string> = {
  pending: 'Aguardando',
  running: 'Executando',
  completed: 'Concluído',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

export const STATUS_COLORS: Record<ExecStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
};

export default {
  getAgentStatus,
  listBoardRepos, createBoardRepo, updateBoardRepo, deleteBoardRepo,
  getListAgentConfig, upsertListAgentConfig, deleteListAgentConfig,
  listCardExecutions, executeCard, cancelExecution,
  subscribeToExecution, subscribeToAgentStatus,
};
