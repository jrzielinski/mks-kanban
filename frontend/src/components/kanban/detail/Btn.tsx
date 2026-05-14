import React from 'react'

/**
 * Sidebar action button used in the CardDetailModal panel list
 * ("Labels", "Members", "Checklist", etc.). The selected state
 * (`active`) lights the button up to indicate which Pop panel is
 * currently open.
 *
 * The previous "variant/size" generic version was a refactor
 * speculation that didn't match any caller — every existing call
 * passes { icon, label, active?, onClick }, so this matches.
 */
const Btn: React.FC<{ icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }> = ({ icon, label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
      active
        ? 'bg-[#e9efff] dark:bg-[#1c2b41] text-[#0055cc] dark:text-[#85b8ff]'
        : 'bg-white dark:bg-[#22272b] text-[#44546f] dark:text-[#8c9bab] hover:bg-[#eef2f6] dark:hover:bg-[#2b3137] hover:text-[#172b4d] dark:hover:text-[#b6c2cf] border border-[#e2e6ea] dark:border-[#3b4754]'
    }`}
  >
    {icon} {label}
  </button>
)

export default Btn
