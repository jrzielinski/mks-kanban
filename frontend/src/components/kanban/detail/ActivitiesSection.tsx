import React, { useState, useRef } from 'react';
import { MessageSquare, Plus, X, Loader2, Sparkles } from 'lucide-react';
import kanbanService from '@/services/kanban.service';
import type { KanbanActivity } from '@/services/kanban.service';
import { getActivityIcon, groupActivitiesByDate } from './constants';

interface ActivitiesSectionProps {
  cardId: string;
  activities: KanbanActivity[];
  onActivityChange: (acts: KanbanActivity[]) => void;
}

export const ActivitiesSection: React.FC<ActivitiesSectionProps> = ({ cardId, activities, onActivityChange }) => {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [smartLoading, setSmartLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const groups = groupActivitiesByDate(activities, 'Hoje', 'Ontem', 'pt-BR');

  const submitComment = async () => {
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      const act = await kanbanService.addActivity(cardId, text.trim());
      setText('');
      onActivityChange([act, ...activities]);
    } catch { /* ignore */ } finally { setSubmitting(false); }
  };

  const smartComment = async () => {
    setSmartLoading(true);
    try {
      const act = await kanbanService.addActivity(cardId, '🤖 ' + text);
      setText('');
      onActivityChange([act, ...activities]);
    } catch { /* ignore */ } finally { setSmartLoading(false); }
  };

  const deleteActivity = async (actId: string) => {
    try {
      await kanbanService.deleteActivity(actId);
      onActivityChange(activities.filter(a => a.id !== actId));
    } catch { /* ignore */ }
  };

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare className="w-4 h-4 text-[#44546f]" />
        <span className="text-xs font-semibold text-[#44546f] uppercase">Activity</span>
      </div>
      <div className="bg-[#f7f8f9] dark:bg-[#1d2125] rounded-lg p-2 mb-3">
        <textarea value={text} onChange={e => setText(e.target.value)}
          placeholder="Write a comment..." rows={2}
          className="w-full resize-none text-sm bg-transparent outline-none text-[#172b4d] dark:text-[#b6c2cf] placeholder-gray-400" />
        <div className="flex items-center justify-between mt-1">
          <div className="flex items-center gap-1">
            <button onClick={() => fileRef.current?.click()} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-gray-500"><Plus className="w-3.5 h-3.5" /></button>
            <button onClick={smartComment} disabled={smartLoading || !text.trim()}
              className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-gray-500 disabled:opacity-30" title="Smart comment">
              <Sparkles className={`w-3.5 h-3.5 ${smartLoading ? 'animate-spin' : ''}`} />
            </button>
            <input ref={fileRef} type="file" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) kanbanService.uploadAttachment(f); e.target.value = ''; }} />
          </div>
          <button onClick={submitComment} disabled={submitting || !text.trim()}
            className="px-3 py-1 bg-[#579dff] hover:bg-[#4c8fe8] text-white text-sm rounded disabled:opacity-50 flex items-center gap-1">
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />} Send
          </button>
        </div>
      </div>
      <div className="space-y-4">
        {groups.map(g => (
          <div key={g.label}>
            <p className="text-xs font-semibold text-gray-500 mb-2">{g.label}</p>
            <div className="space-y-1">
              {g.items.map(act => <ActivityRow key={act.id} act={act} onDelete={deleteActivity} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const ActivityRow: React.FC<{ act: KanbanActivity; onDelete: (id: string) => void }> = ({ act, onDelete }) => {
  const [showDelete, setShowDelete] = useState(false);
  const info = getActivityIcon(act);
  return (
    <div className="flex gap-2 py-1.5 group" onMouseEnter={() => setShowDelete(true)} onMouseLeave={() => setShowDelete(false)}>
      <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: info.bg, color: info.color }}>
        {info.icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-500">{act.userName || 'System'} <span className="text-gray-400">· {formatTimeAgo(act.createdAt)}</span></p>
        <div className="text-sm text-[#172b4d] dark:text-[#b6c2cf]">{act.text}</div>
      </div>
      {showDelete && (
        <button onClick={() => onDelete(act.id)} className="text-gray-400 hover:text-red-500 flex-shrink-0"><X className="w-3 h-3" /></button>
      )}
    </div>
  );
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
