import React from 'react'
import { useTranslation } from 'react-i18next'

interface CardTitleSectionProps {
  title: string
  onEdit: () => void
  isRecording: boolean
  voiceTranscript: string
  voiceReady: boolean
  onStartRecording: () => void
  onStopRecording: () => void
  onInsertTranscript: () => void
  onFormatWithAI: () => void
  onDiscardTranscript: () => void
  formattingVoice: boolean
}

const CardTitleSection: React.FC<CardTitleSectionProps> = ({
  title,
  onEdit,
  isRecording,
  voiceTranscript,
  voiceReady,
  onStartRecording,
  onStopRecording,
  onInsertTranscript,
  onFormatWithAI,
  onDiscardTranscript,
  formattingVoice,
}) => {
  const { t } = useTranslation('common')

  return (
    <div className="mt-2 group/card-title">
      <div className="flex items-start gap-8">
        <h1
          onClick={onEdit}
          className="flex-1 cursor-pointer text-xl font-bold leading-tight tracking-tight text-[#172b4d] break-words transition-colors hover:text-[#0c66e4] dark:text-[#b6c2cf] dark:hover:text-[#85b8ff]"
        >
          {title}
        </h1>

        {/* Voice recording button for title */}
        <div className="flex-shrink-0">
          {isRecording ? (
            <button
              onClick={onStopRecording}
              className="flex items-center justify-center rounded-xl bg-red-50 p-2 text-red-500 hover:bg-red-100 transition-colors"
              title={t('kanbanCardDetailModal.voice.stopRecording')}
            >
              <span className="relative flex h-4 w-4 items-center justify-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <svg className="relative h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3z"/><path d="M17 11a1 1 0 10-2 0 3 3 0 01-6 0 1 1 0 10-2 0 5 5 0 004 4.9V19H9a1 1 0 100 2h6a1 1 0 100-2h-2v-3.1A5 5 0 0017 11z"/></svg>
              </span>
            </button>
          ) : (
            <button
              onClick={onStartRecording}
              className="flex items-center justify-center rounded-xl p-2 text-[#44546f] hover:bg-[#091e4224] dark:text-[#8c9bab] transition-colors opacity-0 group-hover/card-title:opacity-100"
              title={t('kanbanCardDetailModal.voice.dictateDescription')}
            >
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3z"/><path d="M17 11a1 1 0 10-2 0 3 3 0 01-6 0 1 1 0 10-2 0 5 5 0 004 4.9V19H9a1 1 0 100 2h6a1 1 0 100-2h-2v-3.1A5 5 0 0017 11z"/></svg>
            </button>
          )}
        </div>
      </div>

      {/* Voice transcript live preview */}
      {(isRecording || voiceReady) && voiceTranscript && (
        <div className="mt-1 rounded-lg border border-dashed border-[#d8dee6] bg-slate-50 px-3 py-2 text-xs italic text-[#626f86] dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
          {voiceTranscript}
        </div>
      )}

      {/* Post-recording mini toolbar */}
      {voiceReady && voiceTranscript && (
        <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-[#e2e6ea] bg-[#f8fafc] px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
          <span className="mr-1 text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanCardDetailModal.voice.ready')}</span>
          <button
            onClick={onInsertTranscript}
            className="rounded-lg bg-[#091e4224] px-2.5 py-1 text-xs font-medium text-[#172b4d] hover:bg-[#091e423d] dark:bg-[#ffffff1f] dark:text-gray-200"
          >
            {t('kanbanCardDetailModal.voice.insertDirectly')}
          </button>
          <button
            onClick={onFormatWithAI}
            disabled={formattingVoice}
            className="flex items-center gap-1 rounded-lg bg-[#579dff] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-60"
          >
            {formattingVoice ? 'Formatando...' : t('kanbanCardDetailModal.voice.formatWithAi')}
          </button>
          <button
            onClick={onDiscardTranscript}
            className="ml-auto rounded-lg px-2 py-1 text-xs text-[#626f86] hover:bg-[#091e4224] dark:text-gray-400"
          >
            {t('kanbanCardDetailModal.actions.discard')}
          </button>
        </div>
      )}
    </div>
  )
}

export default CardTitleSection
