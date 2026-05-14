import React from 'react'

interface CardCoverSectionProps {
  cover: string | null
  coverAttachmentUrl: string | null
}

const CardCoverSection: React.FC<CardCoverSectionProps> = ({ cover, coverAttachmentUrl }) => {
  const bg = coverAttachmentUrl
    ? undefined
    : cover || undefined

  if (!cover && !coverAttachmentUrl) return null

  return (
    <div
      className="relative -mx-5 -mt-5 mb-5 h-24 overflow-hidden"
      style={
        coverAttachmentUrl
          ? {
              backgroundImage: `url(${coverAttachmentUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : { background: bg }
      }
    >
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 to-transparent" />
    </div>
  )
}

export default CardCoverSection
