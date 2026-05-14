import React from 'react'

export const PopoverAnchorContext = React.createContext<React.RefObject<HTMLDivElement> | null>(null)

export const POP_WIDTH = 288 // Tailwind w-72 = 18rem = 288px
export const POP_GAP = 8
