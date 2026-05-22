import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logSuccess, logError, logDivider } from '../ui/terminal';
import chalk from 'chalk';

export async function hoursLogCommand(
  taskId: string,
  hours: string,
  options: { description?: string },
): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const { data } = await api.post('/dark-factory/timesheet', {
      taskId,
      hours: parseFloat(hours),
      description: options.description,
    });

    logSuccess(`${hours}h registrada(s) para task ${taskId.substring(0, 8)}`);
    logInfo(`ID: ${data.id}`);
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}

export async function hoursTodayCommand(): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const { data } = await api.get('/dark-factory/timesheet/today');

    logDivider();
    console.log(chalk.cyan.bold(`  Horas de hoje (${data.date})\n`));

    if (data.entries.length === 0) {
      logInfo('Nenhuma hora registrada hoje.');
    } else {
      for (const entry of data.entries) {
        const h = chalk.white.bold(`${entry.hours}h`);
        const desc = chalk.gray(entry.description || entry.taskId?.substring(0, 8) || '—');
        const auto = entry.isAutomatic ? chalk.blue(' [auto]') : '';
        console.log(`  ${h} ${desc}${auto}`);
      }
    }

    console.log();
    console.log(chalk.green.bold(`  Total: ${data.totalHours}h`));
    logDivider();
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}

export async function hoursWeekCommand(): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const { data } = await api.get('/dark-factory/timesheet/week');

    logDivider();
    console.log(chalk.cyan.bold(`  Horas da semana (${data.from} — ${data.to})\n`));

    if (data.entries.length === 0) {
      logInfo('Nenhuma hora registrada esta semana.');
    } else {
      // Group by date
      const byDate: Record<string, any[]> = {};
      for (const entry of data.entries) {
        if (!byDate[entry.loggedDate]) byDate[entry.loggedDate] = [];
        byDate[entry.loggedDate].push(entry);
      }

      for (const [date, entries] of Object.entries(byDate)) {
        const dayTotal = entries.reduce((s: number, e: any) => s + (e.hours || 0), 0);
        console.log(`  ${chalk.white.bold(date)} — ${chalk.yellow(`${dayTotal}h`)}`);
        for (const entry of entries) {
          const desc = chalk.gray(entry.description || entry.taskId?.substring(0, 8) || '—');
          console.log(`    ${entry.hours}h ${desc}`);
        }
      }
    }

    console.log();
    console.log(chalk.green.bold(`  Total semana: ${data.totalHours}h`));
    logDivider();
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}

export async function timerStartCommand(options: { taskId?: string }): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const { data } = await api.post('/dark-factory/timesheet/timer/start', {
      taskId: options.taskId,
    });

    logSuccess(`Timer iniciado (ID: ${data.id})`);
    logInfo('Execute: makestudio hours timer:stop <id> para parar');
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}

export async function timerStopCommand(timerId: string): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const { data } = await api.put(`/dark-factory/timesheet/timer/stop/${timerId}`);

    if (data.error) {
      logError(data.error);
      return;
    }

    logSuccess(`Timer parado — ${data.hours}h registrada(s)`);
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}
