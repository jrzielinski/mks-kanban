import React, { useRef } from 'react';
import { Paperclip, X, Image as ImageIcon, Plus } from 'lucide-react';
import kanbanService from '@/services/kanban.service';
import type { KanbanAttachment } from '@/services/kanban.service';

interface AttachmentsSectionProps {
  attachments: KanbanAttachment[];
  onChange: (atts: KanbanAttachment[]) => void;
}

export const AttachmentsSection: React.FC<AttachmentsSectionProps> = ({ attachments, onChange }) => {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await kanbanService.uploadAttachment(file);
      onChange([...attachments, { id: `att_${Date.now()}`, url, name: file.name, isImage: file.type.startsWith('image/'), addedAt: new Date().toISOString() }]);
    } catch { /* ignore */ }
    if (fileRef.current) fileRef.current.value = '';
  };

  const remove = (attId: string) => {
    onChange(attachments.filter(a => a.id !== attId));
  };

  if (attachments.length === 0) {
    return (
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Paperclip className="w-4 h-4 text-[#44546f]" />
          <span className="text-xs font-semibold text-[#44546f] uppercase">Attachments</span>
        </div>
        <button onClick={() => fileRef.current?.click()} className="text-sm text-[#579dff] hover:text-[#4c8fe8] flex items-center gap-1">
          <Plus className="w-3.5 h-3.5" /> Add attachment
        </button>
        <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Paperclip className="w-4 h-4 text-[#44546f]" />
        <span className="text-xs font-semibold text-[#44546f] uppercase">{attachments.length} Attachments</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        {attachments.map(att => (
          <div key={att.id} className="relative group rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-[#f7f8f9] dark:bg-[#1d2125]">
            {att.isImage ? (
              <img src={att.url} alt={att.name} className="w-full h-20 object-cover" />
            ) : (
              <div className="w-full h-20 flex items-center justify-center bg-gray-100 dark:bg-gray-800">
                <ImageIcon className="w-8 h-8 text-gray-400" />
              </div>
            )}
            <div className="p-1.5">
              <p className="text-xs font-medium text-[#172b4d] dark:text-[#b6c2cf] truncate">{att.name}</p>
            </div>
            <button onClick={() => remove(att.id)}
              className="absolute top-1 right-1 w-5 h-5 bg-gray-900/60 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      <button onClick={() => fileRef.current?.click()} className="text-sm text-[#579dff] hover:text-[#4c8fe8] flex items-center gap-1">
        <Plus className="w-3.5 h-3.5" /> Add attachment
      </button>
      <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
    </div>
  );
};
