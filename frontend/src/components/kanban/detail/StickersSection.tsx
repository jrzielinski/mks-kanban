import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Picker from '@emoji-mart/react';
import emojiData from '@emoji-mart/data';

interface StickersSectionProps {
  stickers: string[];
  kanbanService: {
    updateCard: (cardId: string, data: { stickers: string[] }) => Promise<unknown>;
  };
  cardId: string;
  onStickersChange: (stickers: string[]) => void;
}

export function StickersSection({ stickers, kanbanService, cardId, onStickersChange }: StickersSectionProps) {
  const { t } = useTranslation();

  const toggleSticker = useCallback((emoji: string) => {
    const next = stickers.includes(emoji)
      ? stickers.filter(s => s !== emoji)
      : [...stickers, emoji];
    onStickersChange(next);
    void kanbanService.updateCard(cardId, { stickers: next });
  }, [stickers, cardId, kanbanService, onStickersChange]);

  const removeAll = useCallback(() => {
    onStickersChange([]);
    void kanbanService.updateCard(cardId, { stickers: [] });
  }, [cardId, kanbanService, onStickersChange]);

  return (
    <div>
      <div style={{
        scrollbarColor: document.documentElement.classList.contains('dark')
          ? '#4b5563 #282e33'
          : '#d1d5db #ffffff',
        scrollbarWidth: 'thin',
      }}>
        <Picker
          data={emojiData}
          locale="pt"
          theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
          onEmojiSelect={(em: { native: string }) => void toggleSticker(em.native)}
          previewPosition="none"
          skinTonePosition="none"
        />
      </div>
      {stickers.length > 0 && (
        <button
          onClick={removeAll}
          className="mt-2 w-full rounded-lg bg-[#f1f2f4] py-1.5 text-sm text-[#44546f] hover:bg-[#e0e2e5] dark:bg-[#1d2125] dark:text-[#8c9bab]"
        >
          {t('kanbanCardDetailModal.sidebar.removeAllStickers', { count: stickers.length })}
        </button>
      )}
    </div>
  );
}
