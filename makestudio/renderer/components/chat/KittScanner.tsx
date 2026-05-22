import React from 'react';

/**
 * Scanner estilo KITT — 7 blocos com opacity gradiente varrendo horizontal.
 * Usado no StatusBar enquanto busy=true.
 */
export function KittScanner(): React.ReactElement {
  return (
    <div className="relative flex h-3 w-20 items-center overflow-hidden rounded-sm bg-surface-3/60">
      <div className="absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-transparent via-primary/80 to-transparent animate-kitt-scan" />
    </div>
  );
}
