import { getApiClient } from '../network/api-client';
import { isJsonMode, emitSuccess } from '../utils/output-format';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logError, logDivider } from '../ui/terminal';
import chalk from 'chalk';

export async function agentsCommand(options: { json?: boolean } = {}): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const { data: agents } = await api.get('/dark-factory/agents/connected');  if (isJsonMode(options)) {    emitSuccess(agents);    return;  }

    logDivider();
    if (agents.length === 0) {
      logInfo('Nenhum agent conectado.');
    } else {
      console.log(chalk.cyan.bold(`  ${agents.length} agent(s) conectado(s)\n`));

      for (const agent of agents) {
        const statusIcon = agent.status === 'idle'
          ? chalk.green('●')
          : chalk.yellow('●');
        const statusLabel = agent.status === 'idle'
          ? chalk.green('idle')
          : chalk.yellow('busy');

        console.log(`  ${statusIcon} ${chalk.white.bold(agent.hostname)}`);
        console.log(`    CLIs: ${chalk.gray(agent.availableCLIs?.join(', ') || '—')}`);
        console.log(`    Repo: ${chalk.gray(agent.repoPath || '—')}`);
        console.log(`    Status: ${statusLabel}`);
        console.log();
      }
    }

    logDivider();
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}
