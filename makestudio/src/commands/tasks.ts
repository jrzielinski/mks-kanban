import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logError, logDivider } from '../ui/terminal';
import { isJsonMode, emitSuccess } from '../utils/output-format';
import chalk from 'chalk';

export async function tasksCommand(options: {
  projectId?: string;
  dumId?: string;
  status?: string;
  json?: boolean;
}): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    let url = '/dark-factory/tasks';
    if (options.projectId) {
      url = `/dark-factory/tasks/project/${options.projectId}`;
    } else if (options.dumId) {
      url = `/dark-factory/tasks/dum/${options.dumId}`;
    }

    const { data } = await api.get(url);
    const tasks = Array.isArray(data) ? data : (data.tasks || data.data || []);

    if (isJsonMode(options)) {
      emitSuccess(tasks);
      return;
    }

    if (tasks.length === 0) {
      logInfo('Nenhuma task encontrada.');
      return;
    }

    logDivider();
    console.log(chalk.cyan.bold(`  ${tasks.length} task(s) encontrada(s)\n`));

    const statusIcons: Record<string, string> = {
      pending: chalk.gray('○'),
      assigned: chalk.blue('◐'),
      in_progress: chalk.yellow('●'),
      review: chalk.magenta('◉'),
      testing: chalk.cyan('◉'),
      completed: chalk.green('✓'),
      failed: chalk.red('✗'),
    };

    for (const task of tasks) {
      const icon = statusIcons[task.status] || chalk.gray('?');
      const type = chalk.gray(`[${(task.type || '').toUpperCase().padEnd(12)}]`);
      const title = chalk.white(task.title || 'Sem título');
      const id = chalk.gray(task.id?.substring(0, 8));
      const priority = task.priority ? chalk.yellow(`P${task.priority}`) : '';

      console.log(`  ${icon} ${type} ${title} ${id} ${priority}`);
    }

    logDivider();
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}

export async function taskDetailCommand(taskId: string, options: { json?: boolean } = {}): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const { data: task } = await api.get(`/dark-factory/tasks/${taskId}`);

    if (isJsonMode(options)) {
      emitSuccess(task);
      return;
    }

    logDivider();
    console.log(chalk.cyan.bold(`  Task: ${task.title}`));
    console.log();
    console.log(`  ${chalk.gray('ID:')}          ${task.id}`);
    console.log(`  ${chalk.gray('Tipo:')}        ${(task.type || '').toUpperCase()}`);
    console.log(`  ${chalk.gray('Status:')}      ${task.status}`);
    console.log(`  ${chalk.gray('Prioridade:')}  ${task.priority || 0}`);
    console.log(`  ${chalk.gray('Branch:')}      ${task.branchName || '—'}`);
    console.log(`  ${chalk.gray('PR:')}          ${task.prUrl || '—'}`);
    console.log(`  ${chalk.gray('Custo:')}       $${(task.costUsd || 0).toFixed(4)}`);

    if (task.description) {
      console.log();
      console.log(chalk.gray('  Descrição:'));
      console.log(`  ${task.description}`);
    }

    if (task.acceptanceCriteria?.length) {
      console.log();
      console.log(chalk.gray('  Critérios de aceite:'));
      for (const c of task.acceptanceCriteria) {
        console.log(`  ${chalk.green('•')} ${c}`);
      }
    }

    logDivider();
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}
