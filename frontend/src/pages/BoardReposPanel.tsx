import React from 'react';
import { GitBranch } from 'lucide-react';

/**
 * "Repos" tab in the board panel. The agent-driven repo workflow lives in
 * the MakeStudio monolith; this standalone build ships a placeholder so
 * the tab compiles. Wire up the agent module in a follow-up to enable it.
 */
export const BoardReposPanel: React.FC<{ boardId: string }> = () => (
  <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[#091e4224] p-8 text-center text-sm text-[#44546f] dark:border-gray-700 dark:text-gray-400">
    <GitBranch className="h-8 w-8 opacity-50" />
    <p>Repositórios vinculados ao board virão em breve nesta versão standalone.</p>
  </div>
);

export default BoardReposPanel;
