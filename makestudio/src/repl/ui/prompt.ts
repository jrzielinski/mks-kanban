import chalk from 'chalk';
import { ReplContext } from '../context';
import { printBanner } from '../../utils/banner';

const cyan = chalk.hex('#22D3EE');
const blue = chalk.hex('#60A5FA');
const dim = chalk.hex('#64748B');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');

export function buildPrompt(_ctx: ReplContext): string {
  // Minimal chat prompt — just the cursor.
  return `${cyan.bold('>')} `;
}

export function printWelcome(ctx: ReplContext): void {
  printBanner();

  console.log();
  if (ctx.user) {
    console.log(`  ${green('*')} Autenticado como ${blue(ctx.user.email || ctx.user.tenantId)} ${dim(`(${ctx.user.role || 'user'})`)}`);
  } else {
    console.log(`  ${yellow('!')} Nao autenticado — use ${cyan('/login')} para conectar`);
  }

  if (ctx.activeProject) {
    console.log(`  ${green('*')} Projeto ativo: ${blue(ctx.activeProject.name)}`);
  }

  const aiLabel = ctx.providerInfo
    ? `${ctx.providerInfo.provider}/${ctx.providerInfo.model}`
    : ctx.provider;
  console.log(`  ${dim('AI:')} ${blue(aiLabel)}`);

  // Surface direct/proxy state up-front so the operator sees it on every
  // launch. Direct = key was injected from /repl-chat/info at boot. Otherwise
  // the chat handlers will refuse to start (see chat.ts validation).
  if (ctx.user) {
    if ((ctx as any).sessionKeyInjected) {
      console.log(`  ${dim('Path:')} ${green('direct')} ${dim('(no backend hop)')}`);
    } else {
      const reason = (ctx as any).sessionKeyError || 'unknown';
      console.log(`  ${dim('Path:')} ${yellow('NOT READY')} ${dim('—')} ${reason}`);
      console.log(`  ${dim('       Fix the backend apiConfig.apiKey then run')} ${cyan('/login')}.`);
    }
  }

  console.log();
  console.log(`  ${dim('Digite')} ${cyan('/help')} ${dim('para comandos. Converse com a IA escrevendo direto.')}`);
  console.log();
}
