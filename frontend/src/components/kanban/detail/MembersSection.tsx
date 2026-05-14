import React from 'react';
import { X } from 'lucide-react';
import kanbanService from '@/services/kanban.service';
import type { KanbanBoardMember } from '@/services/kanban.service';

interface MembersSectionProps {
  cardId: string;
  members: KanbanBoardMember[];
  allMembers: KanbanBoardMember[];
  onMembersChange: (members: KanbanBoardMember[]) => void;
}

export const MembersSection: React.FC<MembersSectionProps> = ({ cardId, members, allMembers, onMembersChange }) => {
  const toggleMember = async (m: KanbanBoardMember) => {
    const exists = members.some(mm => mm.id === m.id);
    const next = exists ? members.filter(mm => mm.id !== m.id) : [...members, m];
    onMembersChange(next);
    await kanbanService.updateCard(cardId, { memberIds: next.map(mm => mm.id) }).catch(() => {});
  };

  const removeMember = async (id: string) => {
    const next = members.filter(m => m.id !== id);
    onMembersChange(next);
    await kanbanService.updateCard(cardId, { memberIds: next.map(mm => mm.id) }).catch(() => {});
  };

  return (
    <div>
      {members.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {members.map(m => (
            <div key={m.id} className="relative group">
              <div className="w-8 h-8 rounded-full bg-[#579dff] text-white flex items-center justify-center text-xs font-semibold">
                {m.name?.charAt(0)?.toUpperCase() || '?'}
              </div>
              <button onClick={() => removeMember(m.id)}
                className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <X className="w-2.5 h-2.5" />
              </button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-0.5 bg-gray-800 text-white text-[10px] rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">{m.name}</div>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] font-semibold text-[#44546f] uppercase mb-1.5">Board members</p>
      <div className="flex flex-wrap gap-1">
        {allMembers.filter(m => !members.some(mm => mm.id === m.id)).map(m => (
          <button key={m.id} onClick={() => toggleMember(m)}
            className="w-8 h-8 rounded-full bg-[#e9f2ff] dark:bg-[#2c3e5a] text-[#0c66e4] dark:text-[#85b8ff] hover:bg-[#cce0ff] dark:hover:bg-[#3b577a] text-xs font-semibold transition-colors flex items-center justify-center"
            title={m.name}>{m.name?.charAt(0)?.toUpperCase() || '?'}</button>
        ))}
      </div>
    </div>
  );
};

export const MemberAvatars: React.FC<{ members: KanbanBoardMember[]; max?: number }> = ({ members, max = 3 }) => {
  if (members.length === 0) return null;
  const visible = members.slice(0, max);
  const rem = members.length - max;
  return (
    <div className="flex -space-x-1">
      {visible.map(m => (
        <div key={m.id} className="w-6 h-6 rounded-full bg-[#579dff] text-white flex items-center justify-center text-[9px] font-semibold border-2 border-white dark:border-[#1d2125]"
          title={m.name}>{m.name?.charAt(0)?.toUpperCase() || '?'}</div>
      ))}
      {rem > 0 && <div className="w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 flex items-center justify-center text-[9px] font-semibold border-2 border-white dark:border-[#1d2125]">+{rem}</div>}
    </div>
  );
};
