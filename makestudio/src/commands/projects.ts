import * as readline from 'readline';
import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logSuccess, logError, logWarning, logDivider } from '../ui/terminal';
import { isJsonMode, emitSuccess } from '../utils/output-format';
import chalk from 'chalk';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

export async function projectsCommand(options: { json?: boolean } = {}): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    const { data } = await api.get('/dark-factory/projects');
    const projects = Array.isArray(data) ? data : (data.projects || data.data || []);

    if (isJsonMode(options)) {
      emitSuccess(projects);
      return;
    }

    if (projects.length === 0) {
      logInfo('Nenhum projeto encontrado.');
      return;
    }

    logDivider();
    console.log(chalk.hex('#22D3EE').bold(`  ${projects.length} projeto(s)\n`));

    const statusIcons: Record<string, string> = {
      intake: chalk.gray('○'),
      analyzing: chalk.blue('◐'),
      designing: chalk.magenta('◉'),
      developing: chalk.yellow('●'),
      testing: chalk.cyan('◉'),
      deploying: chalk.green('▲'),
      completed: chalk.green('✓'),
      cancelled: chalk.red('✗'),
    };

    for (const p of projects) {
      const icon = statusIcons[p.status] || chalk.gray('?');
      const name = chalk.white.bold(p.name);
      const status = chalk.hex('#94A3B8')(`(${p.status})`);
      const tasks = chalk.hex('#94A3B8')(`${p.completedTasks || 0}/${p.totalTasks || 0} tasks`);
      const cost = chalk.hex('#FBBF24')(`$${(p.totalCostUsd || 0).toFixed(2)}`);
      const id = chalk.hex('#64748B')(p.id.slice(0, 8));

      console.log(`  ${icon} ${name} ${status} ${id}`);
      console.log(`    ${tasks}  ${cost}`);
      if (p.metadata?.localPath) {
        console.log(`    ${chalk.hex('#94A3B8')('path:')} ${chalk.hex('#60A5FA')(p.metadata.localPath)}`);
      }
      if (p.repoUrl) {
        console.log(`    ${chalk.hex('#94A3B8')('repo:')} ${chalk.hex('#60A5FA')(p.repoUrl)}`);
      }
      console.log();
    }

    logDivider();
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}

export async function projectDeleteCommand(id: string, options: { force?: boolean }): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    // Fetch project — support partial ID match
    let project: any;
    try {
      if (id.length < 36) {
        // Partial ID — search in project list
        const { data } = await api.get('/dark-factory/projects');
        const projects = Array.isArray(data) ? data : (data.projects || data.data || []);
        const matches = projects.filter((p: any) => p.id.startsWith(id));
        if (matches.length === 0) {
          logError(`Nenhum projeto encontrado com ID começando em: ${id}`);
          process.exit(1);
        }
        if (matches.length > 1) {
          logWarning(`ID "${id}" é ambíguo — ${matches.length} projetos encontrados:`);
          console.log();
          for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            console.log(`  ${chalk.hex('#22D3EE').bold(`${i + 1})`)} ${chalk.white.bold(m.name)} ${chalk.hex('#94A3B8')(m.id.slice(0, 8))} ${chalk.hex('#64748B')(m.status)}`);
          }
          console.log();
          const answer = await ask(chalk.hex('#FBBF24')(`  Qual projeto deseja excluir? (1-${matches.length}, ou Enter para cancelar) `));
          const choice = parseInt(answer, 10);
          if (isNaN(choice) || choice < 1 || choice > matches.length) {
            logInfo('Operação cancelada.');
            return;
          }
          project = matches[choice - 1];
          id = project.id;
        }
        project = matches[0];
        id = project.id; // Use full ID for delete
      } else {
        const { data } = await api.get(`/dark-factory/projects/${id}`);
        project = data;
      }
    } catch {
      logError(`Projeto não encontrado: ${id}`);
      process.exit(1);
    }

    const name = project.name || id;
    const taskCount = project.totalTasks || 0;

    if (!options.force) {
      logWarning(`Projeto: ${chalk.bold(name)} (${id.slice(0, 8)})`);
      if (taskCount > 0) {
        logWarning(`Este projeto tem ${chalk.bold(String(taskCount))} tasks associadas.`);
      }
      const answer = await ask(chalk.hex('#FBBF24')(`  Tem certeza que deseja excluir? (s/N) `));
      if (answer.toLowerCase() !== 's' && answer.toLowerCase() !== 'sim') {
        logInfo('Operação cancelada.');
        return;
      }
    }

    await api.delete(`/dark-factory/projects/${id}`);
    logSuccess(`Projeto ${chalk.bold(name)} excluído com sucesso.`);
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
    process.exit(1);
  }
}
