import React from 'react'

export const PopoverAnchorContext = React.createContext<React.RefObject<HTMLDivElement> | null>(null)

export const POP_WIDTH = 288 // Tailwind w-72 = 18rem = 288px
export const POP_GAP = 8
export const POP_MOBILE_BREAKPOINT = 640 // Tailwind `sm`

/** Below the `sm` breakpoint, popovers (<Pop>/<AnchoredPortal>) render as a
 *  bottom sheet instead of a small anchored floating box — a fixed-width
 *  box positioned beside a sidebar row makes no sense once that sidebar is
 *  full-width and stacked. */
export function useIsMobilePopover(): boolean {
  const [isMobile, setIsMobile] = React.useState(
    () => typeof window !== 'undefined' && window.innerWidth < POP_MOBILE_BREAKPOINT,
  )
  React.useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${POP_MOBILE_BREAKPOINT - 1}px)`)
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return isMobile
}
