import React, { useState } from 'react';
import { Check, Plus } from 'lucide-react';
import kanbanService from '@/services/kanban.service';
import type { KanbanLabel } from '@/services/kanban.service';
import { LABEL_PRESETS } from './constants';

interface LabelsSectionProps {
  cardId: string;
  labels: KanbanLabel[];
  onLabelsChange: (labels: KanbanLabel[]) => void;
}

export const LabelsSection: React.FC<LabelsSectionProps> = ({ cardId, labels, onLabelsChange }) => {
  const [lblText, setLblText] = useState('');
  const [lblColor, setLblColor] = useState(LABEL_PRESETS[0].color);

  const toggleLabel = async (lp: { color: string; name: string }) => {
    const exists = labels.some(l => l.color === lp.color);
    const next = exists
      ? labels.filter(l => l.color !== lp.color)
      : [...labels, { text: lblText || lp.name, color: lp.color }];
    onLabelsChange(next);
    await kanbanService.updateCard(cardId, { labels: next }).catch(() => {});
  };

  const addCustomLabel = async () => {
    if (!lblText.trim()) return;
    const nl: KanbanLabel = { text: lblText.trim(), color: lblColor };
    const next = [...labels, nl];
    onLabelsChange(next);
    setLblText('');
    await kanbanService.updateCard(cardId, { labels: next }).catch(() => {});
  };

  return (
    <div>
      <div className="grid grid-cols-5 gap-1 mb-3">
        {LABEL_PRESETS.map(lp => {
          const on = labels.some(l => l.color === lp.color);
          return (
            <button key={lp.color} onClick={() => toggleLabel(lp)} title={lp.name}
              className="h-7 rounded relative hover:scale-105 transition-all" style={{ background: lp.color }}>
              {on && <Check className="w-3 h-3 text-white absolute inset-0 m-auto drop-shadow" />}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] font-semibold text-[#44546f] uppercase mb-1.5">Custom label</p>
      <div className="flex gap-1 items-center">
        <div className="w-8 h-8 rounded cursor-pointer flex-shrink-0 hover:scale-105 transition-all border-2 border-white dark:border-[#282e33]"
          style={{ background: lblColor }}
          onClick={() => { const i = LABEL_PRESETS.findIndex(p => p.color === lblColor); setLblColor(LABEL_PRESETS[(i + 1) % LABEL_PRESETS.length].color); }} />
        <input value={lblText} onChange={e => setLblText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addCustomLabel()}
          placeholder="Label name..."
          className="flex-1 min-w-0 text-sm px-2 py-1.5 bg-[#f1f2f4] dark:bg-[#1d2125] border border-[#cfd3d8] dark:border-[#3b4754] rounded outline-none text-[#172b4d] dark:text-[#b6c2cf]" />
        <button onClick={addCustomLabel} className="px-2 py-1.5 bg-[#579dff] hover:bg-[#4c8fe8] text-white rounded flex-shrink-0"><Plus className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
};

export const LabelBadges: React.FC<{ labels: KanbanLabel[] }> = ({ labels }) => {
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((l, i) => (
        <span key={`${l.color}_${i}`} className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold text-white truncate max-w-[120px]"
          style={{ background: l.color }} title={l.text}>{l.text}</span>
      ))}
    </div>
  );
};
