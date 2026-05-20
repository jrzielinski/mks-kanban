import React, { useEffect } from 'react';
import { AgentTuiTerminal } from './AgentTuiTerminal';

/**
 * Full-window MakeStudio Code TUI. Rendered when the app is loaded with
 * ?view=agent (the standalone window opened from the desktop shell).
 */
export const AgentWindow: React.FC = () => {
  useEffect(() => {
    document.title = 'MakeStudio Code';
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0d1117] p-1">
      <AgentTuiTerminal className="h-full w-full" />
    </div>
  );
};
