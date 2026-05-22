import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logError, logDivider } from '../ui/terminal';
import { isJsonMode, emitSuccess } from '../utils/output-format';
import chalk from 'chalk';

export async function historyCommand(options: {
  limit?: string;
  json?: boolean;
  projectId?: string;
}): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const params: Record<string, string> = {};
    if (options.limit) params.limit = options.limit;
    if (options.projectId) params.projectId = options.projectId;

    const { data: logs } = await api.get('/dark-factory/agents/history', { params });    if (isJsonMode(options)) {      emitSuccess(logs);      return;    }

    logDivider();
    if (!logs || logs.length === 0) {
      logInfo('Nenhum histórico de execução encontrado.');
      logDivider();
      return;
    }

    console.log(chalk.cyan.bold(`  ${logs.length} execução(ões)\n`));

    for (const log of logs) {
      const statusIcon =
        log.status === 'completed' ? chalk.green('✓') :
        log.status === 'failed' ? chalk.red('✗') :
        log.status === 'running' ? chalk.yellow('●') :
        chalk.gray('?');

      const operation = chalk.gray(`[${log.operation || log.agentRole || '—'}]`);
      const duration = log.durationMs
        ? chalk.gray(`${Math.round(log.durationMs / 1000)}s`)
        : '';
      const cost = log.costUsd
        ? chalk.yellow(`$${log.costUsd.toFixed(4)}`)
        : '';
      const date = log.createdAt
        ? chalk.gray(new Date(log.createdAt).toLocaleString('pt-BR'))
        : '';

      console.log(`  ${statusIcon} ${operation} ${duration} ${cost}`);
      console.log(`    ${date}`);
      if (log.outputResult) {
        const preview = String(log.outputResult).substring(0, 80);
        console.log(`    ${chalk.gray(preview)}${log.outputResult.length > 80 ? '...' : ''}`);
      }
      console.log();
    }

    logDivider();
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}
