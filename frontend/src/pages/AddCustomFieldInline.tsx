import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import type { KanbanBoardPageBoard } from './kanban-board-types';

type FieldType = 'text' | 'number' | 'date' | 'checkbox' | 'dropdown';

interface Props {
  board: KanbanBoardPageBoard;
  setBoard: (b: KanbanBoardPageBoard) => void;
}

/**
 * Inline "add custom field" control for the board settings panel.
 * Lean placeholder that mutates board.customFieldDefs in-place so card
 * detail modals immediately see the new field. Full editor (re-order /
 * options for dropdown) was a monolith feature — keep this minimal.
 */
export const AddCustomFieldInline: React.FC<Props> = ({ board, setBoard }) => {
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');

  const onAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = {
      ...board,
      customFieldDefs: [
        ...(board.customFieldDefs ?? []),
        { id: crypto.randomUUID(), name: trimmed, type },
      ],
    } as KanbanBoardPageBoard;
    setBoard(next);
    setName('');
    setType('text');
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nome do campo"
        className="flex-1 rounded-md border border-[#091e4224] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#4287f5] dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
      />
      <select
        value={type}
        onChange={(e) => setType(e.target.value as FieldType)}
        className="rounded-md border border-[#091e4224] bg-white px-2 py-1.5 text-sm text-[#172b4d] dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
      >
        <option value="text">Texto</option>
        <option value="number">Número</option>
        <option value="date">Data</option>
        <option value="checkbox">Checkbox</option>
        <option value="dropdown">Lista</option>
      </select>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-1 rounded-md bg-[#0c66e4] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#0055cc] disabled:opacity-50"
        disabled={!name.trim()}
      >
        <Plus className="h-3.5 w-3.5" /> Adicionar
      </button>
    </div>
  );
};

export default AddCustomFieldInline;
