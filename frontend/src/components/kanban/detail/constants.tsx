import type { KanbanChecklistGroup, KanbanActivity, KanbanCard } from '@/services/kanban.service';

export const LABEL_PRESETS: { color: string; name: string }[] = [
  { color: '#4bce97', name: 'Verde' },
  { color: '#f5cd47', name: 'Amarelo' },
  { color: '#fea362', name: 'Laranja' },
  { color: '#f87168', name: 'Vermelho' },
  { color: '#9f8fef', name: 'Roxo' },
  { color: '#579dff', name: 'Azul' },
  { color: '#6cc3e0', name: 'Ciano' },
  { color: '#94c748', name: 'Lima' },
  { color: '#e774bb', name: 'Rosa' },
  { color: '#8590a2', name: 'Cinza' },
];

export const COVER_COLORS: string[] = [
  '#0052cc','#0065ff','#2684ff','#579dff',
  '#00875a','#36b37e','#57d9a3','#79f2c0',
  '#ff5630','#ff7452','#ff8f73','#ffbdad',
  '#ff991f','#ffc400','#ffe380','#fff0b3',
  '#6554c0','#8777d9','#998dd9','#c0b6f2',
  '#344563','#42526e','#505f79','#97a0af',
];

export const EXEC_TYPE_EMOJIS: Record<string, string> = {
  review: '👁️',
  prune: '🗑️',
  fix: '🔧',
  feedback: '💬',
  default: '🤖',
};
export const EXEC_TYPE_LABELS: Record<string, string> = {
  review: 'Review',
  prune: 'Prune',
  fix: 'Fix',
  feedback: 'Feedback',
  default: 'Execute',
};
export const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  running: 'bg-blue-100 text-blue-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendente',
  running: 'Executando',
  done: 'Concluído',
  failed: 'Falhou',
};

export const POP_WIDTH = 288;
export const POP_GAP = 8;

export type SectionPanel = 'labels'|'checklist'|'duedate'|'startdate'|'cover'|'members'|'stickers'|'customfields'|'recurrence'|'location'|null;

export function initChecklists(card: KanbanCard): KanbanChecklistGroup[] {
  if (card.checklists && card.checklists.length > 0) return card.checklists;
  const legacy = (card as any).checklist as Array<any> | undefined;
  if (legacy && legacy.length > 0) {
    return [{
      id: 'cl_legacy',
      title: 'Checklist',
      items: legacy.map((item: any, i: number) => ({ ...item, id: `item_legacy_${i}` })),
    }];
  }
  return [];
}

export function newItemId(): string {
  return `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function getActivityIcon(act: KanbanActivity): { icon: React.ReactNode; color: string; bg: string } {
  const t = act.text.toLowerCase();
  if (act.type === 'comment') return { icon: <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>, color: '#0c66e4', bg: '#e9f2ff' };
  if (t.startsWith('moveu') || t.includes('→')) return { icon: <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>, color: '#206e4e', bg: '#dcfff1' };
  if (t.includes('checklist') || t.includes('item')) return { icon: <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>, color: '#5e4db2', bg: '#f3f0ff' };
  if (t.includes('anexo') || t.includes('attachment')) return { icon: <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>, color: '#ae2e24', bg: '#ffeceb' };
  if (t.includes('membro') || t.includes('assignou')) return { icon: <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>, color: '#0055cc', bg: '#e9efff' };
  if (t.includes('prazo') || t.includes('due')) return { icon: <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>, color: '#974f0c', bg: '#fff7d6' };
  if (t.includes('automação') || t.includes('🤖')) return { icon: <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>, color: '#626f86', bg: '#f1f2f4' };
  return { icon: <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, color: '#44546f', bg: '#f1f2f4' };
}

export function groupActivitiesByDate(
  acts: KanbanActivity[],
  todayLabel: string,
  yesterdayLabel: string,
  locale: string,
): Array<{ label: string; items: KanbanActivity[] }> {
  const groups: Record<string, KanbanActivity[]> = {};
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  for (const act of acts) {
    const d = new Date(act.createdAt); d.setHours(0, 0, 0, 0);
    let label: string;
    if (d.getTime() === today.getTime()) label = todayLabel;
    else if (d.getTime() === yesterday.getTime()) label = yesterdayLabel;
    else label = d.toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' });
    if (!groups[label]) groups[label] = [];
    groups[label].push(act);
  }
  // Mostra mais recente primeiro dentro de cada grupo (estilo Trello /
  // GitHub: latest activity no topo). A API devolve cronológico
  // ascendente; o sort por createdAt desc inverte sem depender disso.
  for (const items of Object.values(groups)) {
    items.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
  return Object.entries(groups)
    .map(([label, items]) => ({ label, items }))
    .sort((a, b) => {
      if (a.label === todayLabel) return -1;
      if (b.label === todayLabel) return 1;
      if (a.label === yesterdayLabel) return -1;
      if (b.label === yesterdayLabel) return 1;
      const parseLabel = (lbl: string) => new Date(lbl.split(' de ').reverse().join('-')).getTime();
      return parseLabel(b.label) - parseLabel(a.label);
    });
}

export function formatTotalTime(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
