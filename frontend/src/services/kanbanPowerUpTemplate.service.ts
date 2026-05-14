// flowbuilder/src/services/kanbanPowerUpTemplate.service.ts
import { api } from '@/lib/api';

export type PowerUpMode = 'simple' | 'builder' | 'script';
export type PowerUpStatus = 'draft' | 'pending' | 'approved' | 'published_tenant' | 'published_template' | 'rejected';

export interface PowerUpConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

export interface ResponseMappingAction {
  condition?: { field: string; operator: '==' | '!=' | 'contains'; value: string };
  action: 'moveCard' | 'assignMember' | 'setDue' | 'addComment';
  params: Record<string, string>;
}

export interface PowerUpTemplate {
  id: string;
  tenantId: string;
  boardId: string;
  createdBy: string;
  name: string;
  icon: string;
  description: string | null;
  mode: PowerUpMode;
  triggerEvents: string[];
  url?: string | null;
  headersTemplate?: Record<string, string> | null;
  payloadTemplate?: Record<string, unknown> | null;
  configSchema: PowerUpConfigField[];
  script?: string | null;
  responseMapping?: ResponseMappingAction[] | null;
  status: PowerUpStatus;
  rejectionReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PowerUpInstallation {
  id: string;
  boardId: string;
  tenantId: string;
  templateId: string;
  config: Record<string, string>;
  enabled: boolean;
}

export interface PowerUpLog {
  id: string;
  installationId: string;
  eventType: string;
  statusCode: number | null;
  error: string | null;
  responseSnippet: string | null;
  executedAt: string;
}

export const KANBAN_EVENTS = [
  { key: 'card.created', label: 'Card criado' },
  { key: 'card.moved', label: 'Card movido' },
  { key: 'card.commented', label: 'Comentario adicionado' },
  { key: 'card.edited', label: 'Card editado' },
  { key: 'card.assigned', label: 'Membro atribuido' },
  { key: 'card.due_changed', label: 'Prazo alterado' },
];

export const TEMPLATE_VARIABLES = [
  '{{card.id}}', '{{card.title}}', '{{card.description}}',
  '{{card.list.id}}', '{{card.list.name}}',
  '{{card.board.id}}', '{{card.board.name}}',
  '{{card.members}}', '{{card.due}}', '{{card.labels}}',
  '{{event.type}}', '{{event.actor.id}}', '{{event.actor.name}}', '{{event.timestamp}}',
];

export const STATUS_LABELS: Record<PowerUpStatus, string> = {
  draft: 'Rascunho',
  pending: 'Aguardando aprovação',
  approved: 'Aprovado',
  published_tenant: 'Disponível neste workspace',
  published_template: 'Disponível para todos',
  rejected: 'Rejeitado',
};

/** Cor do badge de status para exibição no catálogo */
export const STATUS_COLORS: Record<PowerUpStatus, string> = {
  draft: 'bg-slate-100 text-slate-600 dark:bg-gray-700 dark:text-gray-300',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  published_tenant: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  published_template: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

/** Indica se o power-up está disponível para instalação */
export const isInstallable = (status: PowerUpStatus): boolean =>
  status === 'published_tenant' || status === 'published_template' || status === 'approved';

/** Indica se o power-up está publicado (visível no catálogo geral) */
export const isPublished = (status: PowerUpStatus): boolean =>
  status === 'published_tenant' || status === 'published_template';

// Board Owner
export const listMyTemplates = async (boardId: string): Promise<PowerUpTemplate[]> => {
  const { data } = await api.get(`/kanban/boards/${boardId}/power-up-templates`);
  return data;
};
export const createTemplate = async (boardId: string, payload: Partial<PowerUpTemplate>): Promise<PowerUpTemplate> => {
  const { data } = await api.post(`/kanban/boards/${boardId}/power-up-templates`, payload);
  return data;
};
export const updateTemplate = async (id: string, payload: Partial<PowerUpTemplate>): Promise<PowerUpTemplate> => {
  const { data } = await api.put(`/kanban/power-up-templates/${id}`, payload);
  return data;
};
export const submitTemplate = async (id: string): Promise<PowerUpTemplate> => {
  const { data } = await api.post(`/kanban/power-up-templates/${id}/submit`);
  return data;
};
export const deleteTemplate = async (id: string): Promise<void> => {
  await api.delete(`/kanban/power-up-templates/${id}`);
};
export const listAvailable = async (boardId: string): Promise<PowerUpTemplate[]> => {
  const { data } = await api.get(`/kanban/boards/${boardId}/power-ups/available`);
  return data;
};
export const installTemplate = async (boardId: string, templateId: string, config: Record<string, string> = {}): Promise<PowerUpInstallation> => {
  const { data } = await api.post(`/kanban/boards/${boardId}/power-ups/install`, { templateId, config });
  return data;
};
export const listInstallationLogs = async (installationId: string): Promise<PowerUpLog[]> => {
  const { data } = await api.get(`/kanban/power-up-installations/${installationId}/logs`);
  return data;
};

// Tenant Admin
export const listPendingTemplates = async (): Promise<PowerUpTemplate[]> => {
  const { data } = await api.get(`/kanban/power-up-templates/pending`);
  return data;
};
export const listLibraryTemplates = async (): Promise<PowerUpTemplate[]> => {
  const { data } = await api.get(`/kanban/power-up-templates/library`);
  return data;
};
export const approveTemplate = async (id: string, scope: 'board' | 'tenant' | 'template'): Promise<PowerUpTemplate> => {
  const { data } = await api.post(`/kanban/power-up-templates/${id}/approve`, { scope });
  return data;
};
export const rejectTemplate = async (id: string, reason: string): Promise<PowerUpTemplate> => {
  const { data } = await api.post(`/kanban/power-up-templates/${id}/reject`, { reason });
  return data;
};
