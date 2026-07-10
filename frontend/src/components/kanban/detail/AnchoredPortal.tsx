import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { PopoverAnchorContext, POP_WIDTH, POP_GAP, useIsMobilePopover } from './PopoverAnchorContext'

/**
 * Portal-renders children anchored to the enclosing <PanelWrap>'s
 * bounding box. Used internally by <Pop> (with header chrome) and by
 * custom popovers that need to escape the sidebar's overflow:auto
 * clip (e.g. the stickers emoji picker).
 *
 * Below `sm`, "anchored beside a sidebar row" stops making sense — the
 * sidebar is full-width and stacked, not a narrow rail — so this renders
 * as a bottom sheet instead (`onClose` backdrop tap to dismiss).
 */
const AnchoredPortal: React.FC<{ width?: number; children: React.ReactNode; onClose?: () => void }> = ({ width = POP_WIDTH, children, onClose }) => {
  const anchorRef = React.useContext(PopoverAnchorContext)
  const isMobile = useIsMobilePopover()
  const [pos, setPos] = useState<{ top: number; left: number; measured: boolean }>({
    top: 0, left: -9999, measured: false,
  })

  React.useLayoutEffect(() => {
    if (isMobile) return
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
      left = Math.min(left, window.innerWidth - width - POP_GAP)
      left = Math.max(POP_GAP, left)
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
  }, [anchorRef, width, isMobile])

  if (isMobile) {
    return createPortal(
      <>
        <div className="fixed inset-0 z-[9999] bg-black/40 animate-fade-in" onClick={onClose} />
        <div className="fixed inset-x-0 bottom-0 z-[10000] max-h-[85vh] animate-slide-up-sheet">
          {children}
        </div>
      </>,
      document.body,
    )
  }

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
