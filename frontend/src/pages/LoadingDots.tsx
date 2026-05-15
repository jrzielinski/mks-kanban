import React from 'react';

/**
 * Three bouncing dots animation used by the board loading splash.
 * Pure CSS — no external animation lib required.
 */
export const LoadingDots: React.FC<{ className?: string }> = ({ className }) => (
  <span className={`inline-flex gap-1 align-middle ${className ?? ''}`} aria-hidden="true">
    <span className="loading-dot" style={{ animationDelay: '0ms' }} />
    <span className="loading-dot" style={{ animationDelay: '160ms' }} />
    <span className="loading-dot" style={{ animationDelay: '320ms' }} />
    <style>{`
      .loading-dot {
        display: inline-block;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.5;
        animation: loading-dot-bounce 1.1s ease-in-out infinite both;
      }
      @keyframes loading-dot-bounce {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
        40%           { transform: translateY(-4px); opacity: 1; }
      }
    `}</style>
  </span>
);

export default LoadingDots;
