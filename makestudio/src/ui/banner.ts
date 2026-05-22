import chalk from 'chalk';

export function showBanner(): void {
  console.log('');
  console.log(chalk.hex('#6D28D9').bold('  ███╗   ███╗ █████╗ ██╗  ██╗███████╗') + chalk.hex('#2563EB').bold(' ███████╗████████╗██╗   ██╗██████╗ ██╗ ██████╗ '));
  console.log(chalk.hex('#7C3AED').bold('  ████╗ ████║██╔══██╗██║ ██╔╝██╔════╝') + chalk.hex('#3B82F6').bold(' ██╔════╝╚══██╔══╝██║   ██║██╔══██╗██║██╔═══██╗'));
  console.log(chalk.hex('#8B5CF6').bold('  ██╔████╔██║███████║█████╔╝ █████╗  ') + chalk.hex('#06B6D4').bold(' ███████╗   ██║   ██║   ██║██║  ██║██║██║   ██║'));
  console.log(chalk.hex('#A78BFA').bold('  ██║╚██╔╝██║██╔══██║██╔═██╗ ██╔══╝  ') + chalk.hex('#22D3EE').bold(' ╚════██║   ██║   ██║   ██║██║  ██║██║██║   ██║'));
  console.log(chalk.hex('#C4B5FD').bold('  ██║ ╚═╝ ██║██║  ██║██║  ██╗███████╗') + chalk.hex('#67E8F9').bold(' ███████║   ██║   ╚██████╔╝██████╔╝██║╚██████╔╝'));
  console.log(chalk.hex('#DDD6FE').bold('  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝') + chalk.hex('#A5F3FC').bold(' ╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝ '));
  const version = require('../../package.json').version;
  const { pluginRegistry } = require('../core/plugin-registry');
  const pluginCount = pluginRegistry.count();
  const pluginInfo = pluginCount > 0 ? ` ${chalk.gray('·')} ${chalk.hex('#64748B')(`${pluginCount} plugins`)}` : '';
  console.log(`  ${chalk.hex('#06B6D4').bold('Agent')} ${chalk.hex('#94A3B8')(`v${version}`)} ${chalk.gray('·')} ${chalk.hex('#CBD5E1')('Execute tasks localmente com sua própria CLI')}${pluginInfo}`);
  console.log('');
}

export function showStatus(
  connected: boolean,
  cli?: string,
  hostname?: string,
): void {
  const status = connected
    ? chalk.green.bold('● Conectado')
    : chalk.red.bold('○ Desconectado');

  console.log(`  ${status}${cli ? ` ${chalk.gray('│')} ${chalk.white(cli)}` : ''}${hostname ? ` ${chalk.gray('│')} ${chalk.gray(hostname)}` : ''}`);
  console.log();
}
