/**
 * Slash command handler — /ask (side question).
 *
 * Asks a quick question to the LLM without tools, 1 turn max.
 * When the agent is busy, App.tsx intercepts /ask before queuing
 * and runs it in parallel. When idle, this handler runs normally.
 *
 * Port of Claude Code's /btw immediate command.
 */
import type { SlashCommand, SlashContext } from '../slash-registry';
import { runSideQuestion } from '../side-question';
import { tuiLog } from '../tui/bridge';

async function handleAsk(sc: SlashContext): Promise<void> {
  const question = sc.argsStr.trim();
  if (!question) {
    tuiLog('Use: /ask <question> — ask a quick side question while the agent is working', 'info');
    return;
  }

  try {
    const { answer, error } = await runSideQuestion(question, sc.ctx);

    if (error) {
      tuiLog(`Ask failed: ${error}`, 'error');
      return;
    }

    tuiLog(answer, 'assistant');
  } catch (err: any) {
    tuiLog(`Ask error: ${err.message || String(err)}`, 'error');
  }
}

export const ASK_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/ask'], handler: handleAsk },
];
