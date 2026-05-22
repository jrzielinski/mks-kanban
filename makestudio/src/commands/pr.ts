import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logError, logDivider } from '../ui/terminal';
import { isJsonMode, emitSuccess } from '../utils/output-format';
import chalk from 'chalk';

export async function prListCommand(options: { projectId?: string;
  json?: boolean }): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    // Get tasks with PR URLs
    let url = '/dark-factory/tasks';
    if (options.projectId) {
      url = `/dark-factory/tasks/project/${options.projectId}`;
    }

    const { data } = await api.get(url);
    const tasks = Array.isArray(data) ? data : (data.tasks || data.data || []);

    const tasksWithPR = tasks.filter((t: any) => t.prUrl);    if (isJsonMode(options)) {      emitSuccess(tasksWithPR);      return;    }

    logDivider();
    if (tasksWithPR.length === 0) {
      logInfo('Nenhuma PR encontrada.');
      logDivider();
      return;
    }

    console.log(chalk.cyan.bold(`  ${tasksWithPR.length} PR(s)\n`));

    for (const task of tasksWithPR) {
      const statusIcon =
        task.status === 'completed' ? chalk.green('✓') :
        task.status === 'in_progress' ? chalk.yellow('●') :
        task.status === 'review' ? chalk.magenta('◉') :
        chalk.gray('○');

      console.log(`  ${statusIcon} ${chalk.white.bold(task.title)}`);
      console.log(`    ${chalk.blue(task.prUrl)}`);
      if (task.branchName) {
        console.log(`    Branch: ${chalk.gray(task.branchName)}`);
      }
      console.log();
    }

    logDivider();
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}
