import React from 'react';

/**
 * Cursor piscante renderizado no fim de uma mensagem assistant em streaming.
 */
export function StreamCursor(): React.ReactElement {
  return (
    <span
      className="inline-block h-[1em] w-[7px] translate-y-[2px] animate-cursor-blink bg-primary/70"
      aria-hidden
    />
  );
}
