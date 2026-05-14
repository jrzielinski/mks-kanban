import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { PopoverAnchorContext, POP_WIDTH, POP_GAP } from './PopoverAnchorContext'

/**
 * Portal-renders children anchored to the enclosing <PanelWrap>'s
 * bounding box. Used internally by <Pop> (with header chrome) and by
 * custom popovers that need to escape the sidebar's overflow:auto
 * clip (e.g. the stickers emoji picker).
 */
const AnchoredPortal: React.FC<{ width?: number; children: React.ReactNode }> = ({ width = POP_WIDTH, children }) => {
  const anchorRef = React.useContext(PopoverAnchorContext)
  const [pos, setPos] = useState<{ top: number; left: number; measured: boolean }>({
    top: 0, left: -9999, measured: false,
  })

  React.useLayoutEffect(() => {
    const compute = () => {
      if (!anchorRef?.current) {
        setPos({
          top: Math.max(POP_GAP, window.innerHeight / 2 - 200),
          left: Math.max(POP_GAP, window.innerWidth / 2 - width / 2),
          measured: true,
        })
        return
      }
      const r = anchorRef.current.getBoundingClientRect()
      let left = r.left - width - POP_GAP
      if (left < POP_GAP) left = r.right + POP_GAP
      const top = Math.max(POP_GAP, r.top)
      setPos({ top, left, measured: true })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [anchorRef, width])

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        visibility: pos.measured ? 'visible' : 'hidden',
      }}
      className="z-[10000]"
    >
      {children}
    </div>,
    document.body,
  )
}

export default AnchoredPortal
