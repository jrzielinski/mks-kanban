import React from 'react'

interface CardBreadcrumbBarProps {
  listTitle: string
  isOverdue: boolean
  isToday: boolean
  pct: number
  totalItems: number
  allDone: boolean
  isSnoozed: boolean
}

const CardBreadcrumbBar: React.FC<CardBreadcrumbBarProps> = ({ listTitle, isOverdue, isToday, pct, totalItems, allDone, isSnoozed }) => {
  return (
    <div>
      <div className="flex items-center h-6">
        {listTitle && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#f1f2f4] px-2.5 py-0.5 text-xs font-semibold text-[#44546f] dark:bg-[#2c333a] dark:text-[#8c9bab]">
            {listTitle}
          </span>
        )}
      </div>

      {/* Badges row */}
      <div className="flex flex-wrap items-center gap-1.5 mt-3">
        {isOverdue && !allDone && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600 dark:bg-red-900/20 dark:text-red-400">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            Atrasado
          </span>
        )}
        {isToday && !allDone && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:bg-amber-900/20 dark:text-amber-400">
            Hoje
          </span>
        )}
        {isSnoozed && (
          <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-600 dark:bg-purple-900/20 dark:text-purple-400">
            Adiado
          </span>
        )}
        {totalItems > 0 && (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${allDone ? 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400' : 'bg-[#091e420f] text-[#44546f] dark:bg-[#ffffff1f] dark:text-[#8c9bab]'}`}>
            {pct}%
          </span>
        )}
      </div>
    </div>
  )
}

export default CardBreadcrumbBar
