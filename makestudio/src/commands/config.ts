import { loadConfig, saveConfig, getConfigDir } from '../config/config';
import { logInfo, logError, logSuccess, logDivider } from '../ui/terminal';
import { isJsonMode, emitSuccess } from '../utils/output-format';
import chalk from 'chalk';

export function configCommand(options: {
  server?: string;
  show?: boolean;
  json?: boolean;
}): void {
  const config = loadConfig();

  if (options.show || (!options.server)) {
    if (isJsonMode(options)) {
      emitSuccess({
        configDir: getConfigDir(),
        serverUrl: config?.serverUrl || null,
        tenantId: config?.tenantId || null,
        userId: config?.userId || null,
        hasToken: !!config?.token,
      });
      return;
    }
    logDivider();
    console.log(chalk.cyan.bold('  Configuração MakeStudio\n'));
    console.log(`  ${chalk.gray('Config dir:')}  ${getConfigDir()}`);

    if (config) {
      console.log(`  ${chalk.gray('Servidor:')}    ${config.serverUrl}`);
      console.log(`  ${chalk.gray('Tenant:')}      ${config.tenantId || '—'}`);
      console.log(`  ${chalk.gray('User ID:')}     ${config.userId || '—'}`);
      console.log(`  ${chalk.gray('Token:')}       ${config.token ? chalk.green('presente') : chalk.red('ausente')}`);
    } else {
      logInfo('Nenhuma configuração encontrada. Execute: makestudio login');
    }

    logDivider();
    return;
  }

  if (options.server) {
    if (!config) {
      logError('Faça login primeiro: makestudio login');
      return;
    }
    saveConfig({ ...config, serverUrl: options.server });
    logSuccess(`Servidor atualizado: ${options.server}`);
  }
}
