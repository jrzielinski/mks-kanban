export type BoardPanelTab = 'activity' | 'labels' | 'automation' | 'archive' | 'settings' | 'powerups' | 'repos';
export type BoardViewMode = 'board' | 'calendar' | 'table' | 'dashboard' | 'timeline' | 'map' | 'burndown';

export type SavedFilterView = {
  id: string;
  name: string;
  searchQuery: string;
  filterMemberId: string;
  filterLabelColor: string;
  filterDueDate: string;
  filterNoMembers: boolean;
  filterHasAttachment: boolean;
  createdAt: string;
};
