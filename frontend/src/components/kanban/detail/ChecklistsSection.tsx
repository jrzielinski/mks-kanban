import React, { useState } from 'react';
import { Plus, CheckSquare } from 'lucide-react';
import { DndContext, DragEndEvent, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import kanbanService from '@/services/kanban.service';
import type { KanbanChecklistGroup, KanbanChecklistItem } from '@/services/kanban.service';

// Componentes inline-only para markdown do item: o item de checklist é
// uma linha curta — não queremos blocos <p> com margem nem títulos.
// Renderiza só formatação inline (negrito, itálico, código inline, link).
const INLINE_MD_COMPONENTS = {
  p: ({ children }: any) => <span>{children}</span>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }: any) => <em className="italic">{children}</em>,
  code: ({ children }: any) => (
    <code className="rounded bg-slate-100 dark:bg-gray-700 px-1 py-0.5 font-mono text-[12px] text-[#172b4d] dark:text-[#b6c2cf]">
      {children}
    </code>
  ),
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#0c66e4] hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  ),
  // Bloquear renderização de blocos pesados em uma linha de checklist
  h1: ({ children }: any) => <span>{children}</span>,
  h2: ({ children }: any) => <span>{children}</span>,
  h3: ({ children }: any) => <span>{children}</span>,
  ul: ({ children }: any) => <span>{children}</span>,
  ol: ({ children }: any) => <span>{children}</span>,
  li: ({ children }: any) => <span>{children}</span>,
  pre: ({ children }: any) => <span>{children}</span>,
};
const REMARK_PLUGINS = [remarkGfm];

interface ChecklistsSectionProps {
  cardId: string;
  groups: KanbanChecklistGroup[];
  onChange: (groups: KanbanChecklistGroup[]) => void;
}

const SortableItem: React.FC<{
  item: KanbanChecklistItem;
  groupId: string;
  onToggle: (gid: string, iid: string) => void;
  onTextChange: (gid: string, iid: string, text: string) => void;
  onDelete: (gid: string, iid: string) => void;
}> = ({ item, groupId, onToggle, onTextChange, onDelete }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id ?? `item_${Math.random()}` });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  // Edit-mode toggle: por padrão renderiza markdown (bold/code/links).
  // Clique no texto → vira input; blur → volta pra markdown.
  // Items recém-criados (texto vazio) começam em edit automaticamente.
  const [editing, setEditing] = useState(() => !item.text);
  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-1.5 py-0.5 group">
      <button {...attributes} {...listeners} className="cursor-grab text-gray-400 hover:text-gray-600 flex-shrink-0">
        <svg className="w-3 h-3" viewBox="0 0 12 12"><circle cx="3" cy="3" r="1" fill="currentColor"/><circle cx="3" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="3" r="1" fill="currentColor"/><circle cx="9" cy="9" r="1" fill="currentColor"/></svg>
      </button>
      <input type="checkbox" checked={item.done} onChange={() => onToggle(groupId, item.id ?? '')}
        className="w-4 h-4 rounded border-gray-300 accent-[#579dff] cursor-pointer flex-shrink-0" />
      {editing ? (
        <input
          autoFocus
          value={item.text}
          onChange={e => onTextChange(groupId, item.id ?? '', e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
          className={`flex-1 min-w-0 text-sm px-1 py-0.5 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-[#579dff] outline-none text-[#172b4d] dark:text-[#b6c2cf] ${item.done ? 'line-through text-gray-400' : ''}`}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Clique para editar"
          className={`flex-1 min-w-0 text-left text-sm px-1 py-0.5 leading-relaxed text-[#172b4d] dark:text-[#b6c2cf] hover:bg-slate-50 dark:hover:bg-gray-700 rounded transition-colors break-words ${item.done ? 'line-through text-gray-400' : ''}`}
        >
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={INLINE_MD_COMPONENTS}>
            {item.text || '_(vazio — clique pra editar)_'}
          </ReactMarkdown>
        </button>
      )}
      <button onClick={() => onDelete(groupId, item.id ?? '')}
        className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 flex-shrink-0 transition-opacity">
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  );
};

export const ChecklistsSection: React.FC<ChecklistsSectionProps> = ({ cardId, groups, onChange }) => {
  const [newTitle, setNewTitle] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const update = (next: KanbanChecklistGroup[]) => {
    onChange(next);
    kanbanService.updateCard(cardId, { checklists: next }).catch(() => {});
  };

  const addGroup = () => {
    if (!newTitle.trim()) return;
    const ng: KanbanChecklistGroup = { id: `cl_${Date.now()}`, title: newTitle.trim(), items: [] };
    update([...groups, ng]);
    setNewTitle('');
  };

  const deleteGroup = (gid: string) => update(groups.filter(g => g.id !== gid));

  const addItem = (gid: string) => {
    const item: KanbanChecklistItem = { id: `item_${Date.now()}`, text: '', done: false };
    update(groups.map(g => g.id === gid ? { ...g, items: [...g.items, item] } : g));
  };

  const toggleItem = (gid: string, iid: string) => {
    update(groups.map(g => g.id === gid ? { ...g, items: g.items.map(i => i.id === iid ? { ...i, done: !i.done } : i) } : g));
  };

  const changeText = (gid: string, iid: string, text: string) => {
    update(groups.map(g => g.id === gid ? { ...g, items: g.items.map(i => i.id === iid ? { ...i, text } : i) } : g));
  };

  const deleteItem = (gid: string, iid: string) => {
    update(groups.map(g => g.id === gid ? { ...g, items: g.items.filter(i => i.id !== iid) } : g));
  };

  const handleDragEnd = (gid: string, event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const group = groups.find(g => g.id === gid);
    if (!group) return;
    const oldIdx = group.items.findIndex(i => i.id === active.id);
    const newIdx = group.items.findIndex(i => i.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const next = arrayMove(group.items, oldIdx, newIdx);
    update(groups.map(g => g.id === gid ? { ...g, items: next } : g));
  };

  if (groups.length === 0) {
    return (
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <CheckSquare className="w-4 h-4 text-[#44546f]" />
          <span className="text-xs font-semibold text-[#44546f] uppercase">Checklist</span>
        </div>
        <div className="flex gap-1">
          <input value={newTitle} onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addGroup()}
            placeholder="Add checklist..." className="flex-1 text-sm px-2 py-1.5 bg-[#f1f2f4] dark:bg-[#1d2125] border border-[#cfd3d8] dark:border-[#3b4754] rounded outline-none text-[#172b4d] dark:text-[#b6c2cf]" />
          <button onClick={addGroup} className="px-2 py-1.5 bg-[#579dff] hover:bg-[#4c8fe8] text-white rounded flex-shrink-0"><Plus className="w-3.5 h-3.5" /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-3">
        <CheckSquare className="w-4 h-4 text-[#44546f]" />
        <span className="text-xs font-semibold text-[#44546f] uppercase">Checklist</span>
      </div>
      {groups.map(g => {
        const total = g.items.length;
        const done = g.items.filter(i => i.done).length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        return (
          <div key={g.id} className="mb-3 bg-[#f7f8f9] dark:bg-[#1d2125] rounded-lg p-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <input value={g.title} onChange={e => update(groups.map(gg => gg.id === g.id ? { ...gg, title: e.target.value } : gg))}
                className="font-semibold text-sm bg-transparent outline-none text-[#172b4d] dark:text-[#b6c2cf] flex-1" />
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <span>{done}/{total}</span>
                <button onClick={() => deleteGroup(g.id)} className="text-gray-400 hover:text-red-500">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
            {total > 0 && <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full mb-2 overflow-hidden"><div className="h-full bg-[#579dff] rounded-full transition-all" style={{ width: `${pct}%` }} /></div>}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={e => handleDragEnd(g.id, e)}>
              <SortableContext items={g.items.map(i => i.id ?? '')} strategy={verticalListSortingStrategy}>
                {g.items.map(i => <SortableItem key={i.id ?? Math.random()} item={i} groupId={g.id} onToggle={toggleItem} onTextChange={changeText} onDelete={deleteItem} />)}
              </SortableContext>
            </DndContext>
            <button onClick={() => addItem(g.id)} className="flex items-center gap-1 text-xs text-[#579dff] hover:text-[#4c8fe8] mt-1 opacity-0 hover:opacity-100 transition-opacity"><Plus className="w-3 h-3" /> Add item</button>
          </div>
        );
      })}
      <div className="flex gap-1">
        <input value={newTitle} onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addGroup()}
          placeholder="Add another checklist..." className="flex-1 text-sm px-2 py-1.5 bg-[#f1f2f4] dark:bg-[#1d2125] border border-[#cfd3d8] dark:border-[#3b4754] rounded outline-none text-[#172b4d] dark:text-[#b6c2cf]" />
        <button onClick={addGroup} className="px-2 py-1.5 bg-[#579dff] hover:bg-[#4c8fe8] text-white rounded flex-shrink-0"><Plus className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
};
