import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { KanbanCustomFieldDef } from '@/services/kanban.service';

interface CustomFieldsSectionProps {
  defs: KanbanCustomFieldDef[];
  values: Record<string, unknown>;
  onSave: (fieldId: string, value: string | number | boolean | null) => Promise<void>;
}

export function CustomFieldsSection({ defs, values, onSave }: CustomFieldsSectionProps) {
  const { t } = useTranslation();

  if (defs.length === 0) return null;

  return (
    <div className="space-y-3">
      {defs.map(def => (
        <div key={def.id}>
          <p className="mb-1 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">
            {def.name}
          </p>
          <CustomFieldInput def={def} value={values[def.id]} onSave={onSave} t={t} />
        </div>
      ))}
    </div>
  );
}

// ── internal ────────────────────────────────────────────────────────────────

interface InputProps {
  def: KanbanCustomFieldDef;
  value: unknown;
  onSave: (fieldId: string, value: string | number | boolean | null) => Promise<void>;
  t: (key: string) => string;
}

function CustomFieldInput({ def, value, onSave, t }: InputProps) {
  const handleChange = useCallback(
    (val: string | number | boolean | null) => void onSave(def.id, val),
    [def.id, onSave],
  );

  if (def.type === 'text') {
    return (
      <input
        type="text"
        value={(value as string) ?? ''}
        onChange={e => handleChange(e.target.value)}
        className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
      />
    );
  }

  if (def.type === 'number') {
    return (
      <input
        type="number"
        value={(value as number) ?? ''}
        onChange={e => handleChange(e.target.valueAsNumber || null)}
        className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
      />
    );
  }

  if (def.type === 'date') {
    return (
      <input
        type="date"
        value={((value as string) ?? '').slice(0, 10)}
        onChange={e => handleChange(e.target.value || null)}
        className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
      />
    );
  }

  if (def.type === 'checkbox') {
    return (
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={!!value}
          onChange={e => handleChange(e.target.checked)}
          className="h-4 w-4 accent-[#579dff]"
        />
        <span className="text-sm text-[#44546f] dark:text-[#8c9bab]">{def.name}</span>
      </label>
    );
  }

  if (def.type === 'dropdown') {
    return (
      <select
        value={(value as string) ?? ''}
        onChange={e => handleChange(e.target.value || null)}
        className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
      >
        <option value="">{t('kanbanCardDetailModal.sidebar.selectOption')}</option>
        {def.options?.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  return null;
}
