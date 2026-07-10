import React from 'react'
import { X } from 'lucide-react'
import AnchoredPortal from './AnchoredPortal'
import { POP_WIDTH, useIsMobilePopover } from './PopoverAnchorContext'

/**
 * Header-bearing panel popover used by every "Adicionar ao cartão"
 * button in the sidebar. Renders the title strip + close button on
 * top of the anchored portal box.
 *
 * The CALLER controls visibility via `panel === 'X' && <Pop ...>`.
 * Don't pass a `show` prop — that was a refactor mistake.
 */
const Pop: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; width?: number }> = ({ title, onClose, children, width = POP_WIDTH }) => {
  const isMobile = useIsMobilePopover()
  return (
    <AnchoredPortal width={width} onClose={onClose}>
      <div
        style={isMobile ? undefined : { width }}
        className={isMobile
          ? 'w-full bg-white dark:bg-[#282e33] rounded-t-2xl shadow-2xl border-t border-[#e0e2e7] dark:border-[#3b4754]'
          : 'bg-white dark:bg-[#282e33] rounded-xl shadow-2xl border border-[#e0e2e7] dark:border-[#3b4754]'
        }
      >
        {isMobile && (
          <div className="flex justify-center pt-2.5 pb-1">
            <div className="h-1 w-10 rounded-full bg-[#d3d8de] dark:bg-[#4a5158]" />
          </div>
        )}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#e0e2e7] dark:border-[#3b4754]">
          <span className="text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">{title}</span>
          <button onClick={onClose} className="p-0.5 hover:bg-[#091e4224] dark:hover:bg-[#ffffff1f] rounded text-[#44546f]"><X className="w-4 h-4"/></button>
        </div>
        <div className={isMobile ? 'p-3 max-h-[calc(85vh-56px)] overflow-y-auto' : 'p-3 max-h-[70vh] overflow-y-auto'}>{children}</div>
      </div>
    </AnchoredPortal>
  )
}

export default Pop
