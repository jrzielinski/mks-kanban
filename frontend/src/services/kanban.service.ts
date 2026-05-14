// flowbuilder/src/services/kanban.service.ts
import { api } from '@/lib/api';

export interface KanbanRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  dayOfWeek?: number;
  dayOfMonth?: number;
  nextRun?: string;
}

export interface KanbanCustomFieldDef {
  id: string;
  name: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'dropdown';
  options?: string[];
}

export interface KanbanLabel {
  text: string;
  color: string;
}

export interface KanbanChecklist {
  text: string;
  done: boolean;
}

export interface KanbanChecklistItem {
  id?: string;
  text: string;
  done: boolean;
  dueDate?: string | null;
  assignedTo?: string | null;
}

export interface KanbanChecklistGroup {
  id: string;
  title: string;
  items: KanbanChecklistItem[];
}

export interface KanbanAttachment {
  id: string;
  name: string;
  url: string;
  isImage: boolean;
  addedAt: string;
}

export interface KanbanBoardMember {
  id: string;
  name: string;
  avatarColor?: string;
  email?: string;
  role?: 'member' | 'manager';
}

export interface KanbanBoardLabel {
  id: string;
  text: string;
  color: string;
}

export interface KanbanAutomationAction {
  type: 'add_label' | 'remove_label' | 'assign_member' | 'set_due_offset' | 'move_card' | 'archive_card' | 'send_webhook' | 'execute_flow' | 'open_app';
  labelColor?: string;
  labelText?: string;
  memberId?: string;
  daysOffset?: number;
  targetListId?: string;
  webhookUrl?: string;
  // execute_flow
  flowId?: string;
  flowName?: string;
  // open_app
  appId?: string;
  appName?: string;
  appPageSlug?: string;
  openMode?: 'dialog' | 'new_tab' | 'sidebar';
}

export interface KanbanAutomationTrigger {
  type: 'card_moved_to_list' | 'card_created' | 'due_date_approaching' | 'checklist_completed' | 'label_added' | 'member_assigned' | 'card_archived';
  listId?: string;
  listTitle?: string;
  daysBeforeDue?: number;
  labelColor?: string;
  memberId?: string;
}

export interface KanbanAutomationRule {
  id: string;
  enabled: boolean;
  trigger: KanbanAutomationTrigger;
  action: KanbanAutomationAction;
  description?: string;
}

export interface KanbanWorkspace {
  id: string;
  name: string;
  color: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanJiraStatusMapping {
  listId: string;
  listTitle: string;
  jiraStatusId: string;
  jiraStatusName: string;
}

export interface KanbanJiraConfig {
  domain: string;
  email: string;
  apiToken: string;
  projectKey: string;
  issueType?: string;
  webhookSecret?: string;
  syncOnMove?: boolean;
  syncOnComment?: boolean;
  syncOnCreate?: boolean;
  statusMapping: KanbanJiraStatusMapping[];
}

export interface KanbanGoogleDriveConfig {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry?: string;
  defaultFolderId?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  iconLink: string;
  thumbnailLink?: string;
  size?: string;
  modifiedTime: string;
  parents?: string[];
}

export interface KanbanConfluenceConfig {
  domain: string;
  email: string;
  apiToken: string;
  spaceKey?: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  status: string;
  webUrl: string;
  excerpt?: string;
  lastModified?: string;
  lastModifiedBy?: string;
}

export interface GiphyGif {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  originalUrl: string;
  width: number;
  height: number;
}

export interface KanbanEmailToCardConfig {
  targetListId: string;
  emailAddress?: string;
  subjectAsTitle?: boolean;
  bodyAsDescription?: boolean;
  addLabels?: string[];
  allowedSenders?: string[];
}

export interface KanbanBurndownConfig {
  sprintDurationDays: number;
  sprintStartDate?: string;
  doneListIds: string[];
  trackingField?: 'cards' | 'points';
  pointsFieldId?: string;
}

export interface BurndownDataPoint {
  date: string;
  ideal: number;
  actual: number;
  completed: number;
  added: number;
}

export interface BurndownChartData {
  sprintStartDate: string;
  sprintEndDate: string;
  totalScope: number;
  currentScope: number;
  completedCount: number;
  remainingCount: number;
  dataPoints: BurndownDataPoint[];
  velocity: number;
  projectedEndDate: string | null;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  createdAt: string;
}

export interface GithubPR {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  draft: boolean;
  url: string;
  branch: string;
  createdAt: string;
}

export interface KanbanPowerUp {
  id: string;
  boardId: string;
  type: 'slack' | 'github' | 'jira' | 'google_drive' | 'confluence' | 'giphy' | 'email_to_card' | 'burndown';
  config: Record<string, any>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanCardLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface KanbanActivity {
  id: string;
  cardId: string;
  boardId: string;
  tenantId: string;
  userId: string | null;
  userName: string | null;
  type: 'comment' | 'event';
  text: string;
  createdAt: string;
  updatedAt?: string | null;
}

export interface KanbanTimeLog {
  id: string;
  cardId: string;
  boardId: string;
  tenantId: string;
  userId: string | null;
  userName: string | null;
  hours: number;
  description: string | null;
  loggedDate: string;
  createdAt: string;
}

export interface KanbanNotification {
  id: string;
  tenantId: string;
  userId: string;
  boardId: string | null;
  cardId: string | null;
  cardTitle: string | null;
  type: string;
  text: string;
  isRead: boolean;
  createdAt: string;
}

export interface KanbanHourRequest {
  id: string;
  cardId: string;
  boardId: string;
  tenantId: string;
  userId: string | null;
  userName: string | null;
  hours: number;
  description: string | null;
  loggedDate: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  approvalId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface KanbanCard {
  id: string;
  listId: string;
  boardId: string;
  title: string;
  description: string | null;
  position: number;
  labels: KanbanLabel[];
  checklist: KanbanChecklist[];
  checklists: KanbanChecklistGroup[];
  attachments: KanbanAttachment[];
  memberIds: string[];
  dueDate: string | null;
  startDate: string | null;
  votes: string[];
  stickers: string[];
  customFields: Record<string, string | number | boolean | null>;
  recurrence: KanbanRecurrence | null;
  coverColor: string;
  coverImageUrl: string | null;
  coverAttachmentId: string | null;
  isArchived: boolean;
  watchedBy: string[];
  location: KanbanCardLocation | null;
  commentCount?: number;
  maxHours: number | null;
  linkedCardIds: string[];
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
  /** UI-only signal injected by WebSocket handlers to trigger activity reload. Not persisted. */
  _activityPing?: number;
}

export interface KanbanCardSearchResult extends KanbanCard {
  boardTitle: string;
  listTitle: string;
}

export interface KanbanList {
  id: string;
  boardId: string;
  title: string;
  color: string;
  position: number;
  isArchived: boolean;
  wipLimit: number;
  cards: KanbanCard[];
}

export interface KanbanBoard {
  id: string;
  title: string;
  description: string | null;
  color: string;
  backgroundColor: string | null;
  backgroundImage: string | null;
  customFieldDefs: KanbanCustomFieldDef[];
  slug: string | null;
  members: KanbanBoardMember[];
  boardLabels: KanbanBoardLabel[];
  automationRules: KanbanAutomationRule[];
  isArchived: boolean;
  visibility: 'private' | 'workspace' | 'public';
  inviteToken: string | null;
  workspaceId: string | null;
  isTemplate: boolean;
  watchedBy: string[];
  isStarred?: boolean;
  permissions?: {
    membersCanComment?: boolean;
    membersCanEditCards?: boolean;
    observersCanView?: boolean;
    votingLimit?: number; // 0 = unlimited
  };
  createdAt: string;
  updatedAt: string;
  lists?: KanbanList[];
}

const kanbanService = {
  // Boards
  async listBoards(): Promise<KanbanBoard[]> {
    const r = await api.get('/kanban/boards');
    return r.data;
  },
  async createBoard(data: { title: string; description?: string; color?: string }): Promise<KanbanBoard> {
    const r = await api.post('/kanban/boards', data);
    return r.data;
  },
  async getBoard(boardId: string): Promise<KanbanBoard & { lists: KanbanList[] }> {
    const r = await api.get(`/kanban/boards/${boardId}`);
    return r.data;
  },
  async updateBoard(boardId: string, data: Partial<KanbanBoard>): Promise<KanbanBoard> {
    const r = await api.patch(`/kanban/boards/${boardId}`, data);
    return r.data;
  },
  async deleteBoard(boardId: string): Promise<void> {
    await api.delete(`/kanban/boards/${boardId}`);
  },
  async duplicateBoard(boardId: string): Promise<KanbanBoard & { lists: KanbanList[] }> {
    const r = await api.post(`/kanban/boards/${boardId}/duplicate`);
    return r.data;
  },
  async getArchivedItems(boardId: string): Promise<{ cards: KanbanCard[]; lists: KanbanList[] }> {
    const r = await api.get(`/kanban/boards/${boardId}/archived`);
    return r.data;
  },

  // Lists
  async createList(boardId: string, data: { title: string; color?: string }): Promise<KanbanList> {
    const r = await api.post(`/kanban/boards/${boardId}/lists`, data);
    return r.data;
  },
  async updateList(listId: string, data: { title?: string; color?: string; isArchived?: boolean; wipLimit?: number }): Promise<KanbanList> {
    const r = await api.patch(`/kanban/lists/${listId}`, data);
    return r.data;
  },
  async deleteList(listId: string): Promise<void> {
    await api.delete(`/kanban/lists/${listId}`);
  },
  async reorderLists(boardId: string, listIds: string[]): Promise<void> {
    await api.patch(`/kanban/boards/${boardId}/lists/reorder`, { listIds });
  },
  async copyList(listId: string): Promise<KanbanList & { cards: KanbanCard[] }> {
    const r = await api.post(`/kanban/lists/${listId}/copy`);
    return r.data;
  },
  async clearCompleted(listId: string): Promise<void> {
    await api.post(`/kanban/lists/${listId}/clear-completed`);
  },
  async restoreList(listId: string): Promise<KanbanList> {
    const r = await api.post(`/kanban/lists/${listId}/restore`);
    return r.data;
  },

  // Cards
  async createCard(listId: string, data: { title: string; description?: string }): Promise<KanbanCard> {
    const r = await api.post(`/kanban/lists/${listId}/cards`, data);
    return r.data;
  },
  async updateCard(cardId: string, data: Partial<KanbanCard>): Promise<KanbanCard> {
    const r = await api.patch(`/kanban/cards/${cardId}`, data);
    return r.data;
  },
  async uploadAttachment(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') { resolve(reader.result); return; }
        reject(new Error('invalid-file-data'));
      };
      reader.onerror = () => reject(reader.error ?? new Error('file-read-failed'));
      reader.readAsDataURL(file);
    });
  },
  async moveCard(cardId: string, data: { targetListId: string; position: number }): Promise<KanbanCard> {
    const r = await api.patch(`/kanban/cards/${cardId}/move`, data);
    return r.data;
  },
  async moveCardToBoard(cardId: string, data: { targetBoardId: string; targetListId: string; position: number }): Promise<KanbanCard> {
    const r = await api.post(`/kanban/cards/${cardId}/move-to-board`, data);
    return r.data;
  },
  async duplicateCard(cardId: string): Promise<KanbanCard> {
    const r = await api.post(`/kanban/cards/${cardId}/duplicate`);
    return r.data;
  },
  async restoreCard(cardId: string): Promise<KanbanCard> {
    const r = await api.post(`/kanban/cards/${cardId}/restore`);
    return r.data;
  },
  async deleteCard(cardId: string): Promise<void> {
    await api.delete(`/kanban/cards/${cardId}`);
  },

  // Activities
  async addActivity(cardId: string, text: string, userName?: string): Promise<KanbanActivity> {
    const r = await api.post(`/kanban/cards/${cardId}/activities`, { text, userName, type: 'comment' });
    return r.data;
  },
  async listActivities(cardId: string): Promise<KanbanActivity[]> {
    const r = await api.get(`/kanban/cards/${cardId}/activities`);
    return r.data;
  },
  async updateActivity(activityId: string, text: string): Promise<KanbanActivity> {
    const r = await api.patch(`/kanban/activities/${activityId}`, { text });
    return r.data;
  },
  async deleteActivity(activityId: string): Promise<void> {
    await api.delete(`/kanban/activities/${activityId}`);
  },
  async listBoardActivities(boardId: string): Promise<KanbanActivity[]> {
    const r = await api.get(`/kanban/boards/${boardId}/activities`);
    return r.data;
  },

  // Time Logs
  async listTimeLogs(cardId: string): Promise<KanbanTimeLog[]> {
    const r = await api.get(`/kanban/cards/${cardId}/time-logs`);
    return r.data;
  },
  async addTimeLog(cardId: string, data: { hours: number; description?: string; loggedDate?: string; userName?: string }): Promise<KanbanTimeLog> {
    const r = await api.post(`/kanban/cards/${cardId}/time-logs`, data);
    return r.data;
  },
  async updateTimeLog(logId: string, data: { hours?: number; description?: string; loggedDate?: string }): Promise<KanbanTimeLog> {
    const r = await api.patch(`/kanban/time-logs/${logId}`, data);
    return r.data;
  },
  async deleteTimeLog(logId: string): Promise<void> {
    await api.delete(`/kanban/time-logs/${logId}`);
  },

  // Search
  async searchCards(q: string): Promise<KanbanCardSearchResult[]> {
    const r = await api.get('/kanban/search', { params: { q } });
    return r.data;
  },

  // Notifications
  async listNotifications(): Promise<KanbanNotification[]> {
    const r = await api.get('/kanban/notifications');
    return r.data;
  },
  async markNotificationRead(notifId: string): Promise<void> {
    await api.post(`/kanban/notifications/${notifId}/read`);
  },
  async markAllNotificationsRead(): Promise<void> {
    await api.post('/kanban/notifications/read-all');
  },

  // Workspaces (#34)
  async listWorkspaces(): Promise<KanbanWorkspace[]> {
    const r = await api.get('/kanban/workspaces');
    return r.data;
  },
  async createWorkspace(data: { name: string; color?: string }): Promise<KanbanWorkspace> {
    const r = await api.post('/kanban/workspaces', data);
    return r.data;
  },
  async updateWorkspace(workspaceId: string, data: { name?: string; color?: string }): Promise<KanbanWorkspace> {
    const r = await api.patch(`/kanban/workspaces/${workspaceId}`, data);
    return r.data;
  },
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await api.delete(`/kanban/workspaces/${workspaceId}`);
  },

  // Stars (#40)
  async starBoard(boardId: string): Promise<void> {
    await api.post(`/kanban/boards/${boardId}/star`);
  },
  async unstarBoard(boardId: string): Promise<void> {
    await api.delete(`/kanban/boards/${boardId}/star`);
  },

  // Templates (#39)
  async listTemplates(): Promise<KanbanBoard[]> {
    const r = await api.get('/kanban/templates');
    return r.data;
  },
  async saveAsTemplate(boardId: string): Promise<KanbanBoard> {
    const r = await api.post(`/kanban/boards/${boardId}/save-as-template`);
    return r.data;
  },

  async parseButlerRule(boardId: string, text: string): Promise<{
    trigger: KanbanAutomationTrigger;
    action: KanbanAutomationAction;
    description: string;
  }> {
    const r = await api.post(`/kanban/boards/${boardId}/butler-parse`, { text });
    return r.data;
  },

  // Invite token (#36)
  async generateInviteToken(boardId: string): Promise<{ token: string }> {
    const r = await api.post(`/kanban/boards/${boardId}/invite-token`);
    return r.data;
  },
  async revokeInviteToken(boardId: string): Promise<void> {
    await api.delete(`/kanban/boards/${boardId}/invite-token`);
  },
  async inviteByEmail(boardId: string, email: string, inviterName?: string): Promise<{ sent: boolean }> {
    const r = await api.post(`/kanban/boards/${boardId}/invite-email`, { email, inviterName });
    return r.data;
  },
  async previewInvite(token: string): Promise<{ id: string; title: string; color: string; memberCount: number }> {
    const r = await api.get(`/kanban/join/${token}`);
    return r.data;
  },
  async joinByToken(token: string): Promise<KanbanBoard> {
    const r = await api.post(`/kanban/join/${token}`);
    return r.data;
  },

  // Watch (#37)
  async toggleWatchBoard(boardId: string): Promise<{ watching: boolean }> {
    const r = await api.post(`/kanban/boards/${boardId}/watch`);
    return r.data;
  },
  async toggleWatchCard(cardId: string): Promise<{ watching: boolean }> {
    const r = await api.post(`/kanban/cards/${cardId}/watch`);
    return r.data;
  },

  // C2: Card movement history
  async getCardHistory(cardId: string): Promise<{ id: string; fromListTitle: string | null; toListTitle: string; movedAt: string }[]> {
    const r = await api.get(`/kanban/cards/${cardId}/history`);
    return r.data;
  },

  // C3: Card links
  async linkCards(cardId: string, targetCardId: string): Promise<void> {
    await api.post(`/kanban/cards/${cardId}/links`, { targetCardId });
  },
  async unlinkCard(cardId: string, targetId: string): Promise<void> {
    await api.delete(`/kanban/cards/${cardId}/links/${targetId}`);
  },
  async getBatchCards(ids: string[]): Promise<{ id: string; title: string; listTitle: string; boardTitle: string }[]> {
    if (!ids.length) return [];
    const r = await api.get('/kanban/cards/batch', { params: { ids: ids.join(',') } });
    return r.data;
  },

  // C4: Card blocking
  async addBlocker(cardId: string, blockerCardId: string): Promise<void> {
    await api.post(`/kanban/cards/${cardId}/blockers`, { blockerCardId });
  },
  async removeBlocker(cardId: string, blockerCardId: string): Promise<void> {
    await api.delete(`/kanban/cards/${cardId}/blockers/${blockerCardId}`);
  },

  // C1: Convert checklist item to card
  async convertChecklistItemToCard(cardId: string, groupId: string, itemId: string, listId?: string): Promise<void> {
    await api.post(`/kanban/cards/${cardId}/checklists/${groupId}/items/${itemId}/convert-to-card`, { listId });
  },

  // Advanced Search (#42)
  async advancedSearch(params: {
    q?: string; boardId?: string; listId?: string; memberId?: string;
    labelColor?: string; dueBefore?: string; dueAfter?: string;
    hasAttachment?: boolean; isOverdue?: boolean; workspaceId?: string;
  }): Promise<KanbanCardSearchResult[]> {
    const r = await api.get('/kanban/search/advanced', { params });
    return r.data;
  },

  // Power-Ups (#44)
  async listPowerUps(boardId: string): Promise<KanbanPowerUp[]> {
    const r = await api.get(`/kanban/boards/${boardId}/power-ups`);
    return r.data;
  },
  async createPowerUp(boardId: string, data: { type: KanbanPowerUp['type']; config: Record<string, any> }): Promise<KanbanPowerUp> {
    const r = await api.post(`/kanban/boards/${boardId}/power-ups`, data);
    return r.data;
  },
  async updatePowerUp(powerUpId: string, data: { config?: Record<string, any>; enabled?: boolean }): Promise<KanbanPowerUp> {
    const r = await api.patch(`/kanban/power-ups/${powerUpId}`, data);
    return r.data;
  },
  async deletePowerUp(powerUpId: string): Promise<void> {
    await api.delete(`/kanban/power-ups/${powerUpId}`);
  },

  // Hour Requests
  async listHourRequests(cardId: string): Promise<KanbanHourRequest[]> {
    const r = await api.get(`/kanban/cards/${cardId}/hour-requests`);
    return r.data;
  },
  async createHourRequest(cardId: string, data: { hours: number; description?: string; loggedDate?: string; userName?: string; userId?: string }): Promise<KanbanHourRequest> {
    const r = await api.post(`/kanban/cards/${cardId}/hour-requests`, data);
    return r.data;
  },
  async cancelHourRequest(requestId: string): Promise<void> {
    await api.delete(`/kanban/hour-requests/${requestId}`);
  },

  // GitHub Power-Up
  async listGithubIssues(boardId: string, state = 'open'): Promise<GithubIssue[]> {
    const r = await api.get(`/kanban/boards/${boardId}/github/issues`, { params: { state } });
    return r.data;
  },
  async listGithubPRs(boardId: string, state = 'open'): Promise<GithubPR[]> {
    const r = await api.get(`/kanban/boards/${boardId}/github/pulls`, { params: { state } });
    return r.data;
  },
  async createGithubIssueFromCard(cardId: string): Promise<{ number: number; html_url: string }> {
    const r = await api.post(`/kanban/cards/${cardId}/github-create-issue`);
    return r.data;
  },
  async linkCardToGithubIssue(cardId: string, issueNumber: number): Promise<void> {
    await api.post(`/kanban/cards/${cardId}/github-link-issue`, { issueNumber });
  },
  async linkCardToGithubPR(cardId: string, prNumber: number): Promise<void> {
    await api.post(`/kanban/cards/${cardId}/github-link-pr`, { prNumber });
  },

  // Jira Power-Up
  async linkCardToJira(cardId: string, issueKey: string): Promise<void> {
    await api.post(`/kanban/cards/${cardId}/jira-link`, { issueKey });
  },
  async getJiraStatuses(boardId: string): Promise<{ id: string; name: string; category: string }[]> {
    const r = await api.get(`/kanban/boards/${boardId}/jira-statuses`);
    return r.data;
  },

  // Card Snooze
  async snoozeCard(cardId: string, until: string): Promise<KanbanCard> {
    const r = await api.post(`/kanban/cards/${cardId}/snooze`, { until });
    return r.data;
  },
  async unsnoozeCard(cardId: string): Promise<KanbanCard> {
    const r = await api.post(`/kanban/cards/${cardId}/unsnooze`);
    return r.data;
  },

  // Google Drive Power-Up
  async listDriveFiles(boardId: string, folderId?: string, query?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const params: Record<string, string> = {};
    if (folderId) params.folderId = folderId;
    if (query) params.q = query;
    const r = await api.get(`/kanban/boards/${boardId}/gdrive/files`, { params });
    return r.data;
  },
  async attachDriveFile(cardId: string, file: { id: string; name: string; mimeType: string; webViewLink: string; iconLink?: string; thumbnailLink?: string }): Promise<void> {
    await api.post(`/kanban/cards/${cardId}/gdrive-attach`, file);
  },

  // Confluence Power-Up
  async searchConfluencePages(boardId: string, query: string, spaceKey?: string): Promise<ConfluencePage[]> {
    const params: Record<string, string> = { q: query };
    if (spaceKey) params.spaceKey = spaceKey;
    const r = await api.get(`/kanban/boards/${boardId}/confluence/search`, { params });
    return r.data;
  },
  async listRecentConfluencePages(boardId: string, spaceKey?: string): Promise<ConfluencePage[]> {
    const params: Record<string, string> = {};
    if (spaceKey) params.spaceKey = spaceKey;
    const r = await api.get(`/kanban/boards/${boardId}/confluence/recent`, { params });
    return r.data;
  },
  async listConfluenceSpaces(boardId: string): Promise<Array<{ key: string; name: string; type: string }>> {
    const r = await api.get(`/kanban/boards/${boardId}/confluence/spaces`);
    return r.data;
  },
  async linkConfluencePage(cardId: string, page: { id: string; title: string; webUrl: string; spaceKey: string }): Promise<void> {
    await api.post(`/kanban/cards/${cardId}/confluence-link`, page);
  },
  async unlinkConfluencePage(cardId: string, pageId: string): Promise<void> {
    await api.delete(`/kanban/cards/${cardId}/confluence-link/${pageId}`);
  },

  // Card Decomposition (AI)
  async decomposeCard(cardId: string): Promise<{ cards: KanbanCard[]; count: number }> {
    const r = await api.post(`/kanban/cards/${cardId}/decompose`);
    return r.data;
  },

  // Email-to-Card Power-Up
  async getEmailAddress(boardId: string): Promise<{ emailAddress: string; configured: boolean }> {
    const r = await api.get(`/kanban/boards/${boardId}/email-address`);
    return r.data;
  },

  // Burndown Chart Power-Up
  async getBurndownData(boardId: string): Promise<BurndownChartData> {
    const r = await api.get(`/kanban/boards/${boardId}/burndown`);
    return r.data;
  },
  async startNewSprint(boardId: string): Promise<void> {
    await api.post(`/kanban/boards/${boardId}/burndown/new-sprint`);
  },

  // Giphy Power-Up
  async searchGiphy(boardId: string, query: string, offset = 0): Promise<{ gifs: GiphyGif[]; totalCount: number }> {
    const r = await api.get(`/kanban/boards/${boardId}/giphy/search`, { params: { q: query, offset } });
    return r.data;
  },
  async trendingGiphy(boardId: string, offset = 0): Promise<{ gifs: GiphyGif[]; totalCount: number }> {
    const r = await api.get(`/kanban/boards/${boardId}/giphy/trending`, { params: { offset } });
    return r.data;
  },

  // Flow-Engine integration
  async listAvailableFlows(): Promise<Array<{ id: string; name: string; status: string }>> {
    const r = await api.get('/flow-engine');
    return (r.data || []).map((f: any) => ({ id: f.id, name: f.name, status: f.status }));
  },

  // App-Lumina (Business App) integration
  async listAvailableApps(): Promise<Array<{ id: string; name: string }>> {
    const r = await api.get('/app-builder/apps', { params: { limit: 100 } });
    const items = r.data?.items || r.data || [];
    return items.map((a: any) => ({ id: a.id, name: a.name || a.title }));
  },
};

export default kanbanService;
