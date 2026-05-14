import React, { useRef } from 'react'
import { PopoverAnchorContext } from './PopoverAnchorContext'

/**
 * Provides the anchor ref that <AnchoredPortal>/<Pop> use to position
 * themselves alongside (and outside the overflow:auto clip of) the
 * sidebar that contains the panel buttons.
 *
 * Must wrap any subtree that uses <Pop title=... onClose=...>; the
 * Provider value flows down via PopoverAnchorContext.
 */
const PanelWrap: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <PopoverAnchorContext.Provider value={ref}>
      <div ref={ref} className="relative">{children}</div>
    </PopoverAnchorContext.Provider>
  )
}

export default PanelWrap
