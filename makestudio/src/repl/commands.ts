import chalk from 'chalk';
import { ReplContext } from './context';
import { estimateCost, inputPrice, pricingForModel } from './costs';

import { swallow } from '../utils/log';
const cyan = chalk.hex('#22D3EE');
const dim = chalk.hex('#64748B');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const blue = chalk.hex('#60A5FA');

export function parseSlashArgs(input: string): Record<string, string> {
  const args: Record<string, string> = {};
  const parts = input.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('--')) {
      const key = p.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = parts[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

export function printHelp(): void {
  const cmd = (s: string) => cyan.bold(s.padEnd(24));
  const desc = (s: string) => dim(s);

  console.log();
  console.log(`  ${chalk.white.bold('Comandos disponiveis')}`);
  console.log();
  console.log(`  ${cmd('/login')}${desc('Autenticar no servidor')}`);
  console.log(`  ${cmd('/logout')}${desc('Desconectar')}`);
  console.log(`  ${cmd('/projects')}${desc('Listar projetos')}`);
  console.log(`  ${cmd('/project <id|num>')}${desc('Selecionar projeto ativo')}`);
  console.log(`  ${cmd('/status')}${desc('Status do servidor e agents')}`);
  console.log(`  ${cmd('/tasks [--status X]')}${desc('Listar tasks do projeto ativo')}`);
  console.log();
  console.log(`  ${chalk.white.bold('Execucao')}`);
  console.log();
  console.log(`  ${cmd('/execute [flags]')}${desc('Executar projeto (topological sort)')}`);
  console.log(`  ${cmd('/refine [flags]')}${desc('Refinar spec e DUMs')}`);
  console.log(`  ${cmd('/doctor [flags]')}${desc('Smoke test das stacks')}`);
  console.log(`  ${cmd('/analyze [flags]')}${desc('Analisar codebase')}`);
  console.log();
  console.log(`  ${chalk.white.bold('IA')}`);
  console.log();
  console.log(`  ${cmd('/ai <provider>')}${desc('Trocar provider: claude, codex, gemini')}`);
  console.log(`  ${cmd('/model [tier]')}${desc('Ver ou atualizar catalogo de modelos (fast|default|image)')}`);
  console.log(`  ${cmd('/clear')}${desc('Limpar historico da conversa')}`);
  console.log(`  ${cmd('/fork [titulo]')}${desc('Forkar a conversa atual em nova sessao (original intacta)')}`);
  console.log(`  ${cmd('/plan [hint]')}${desc('Entrar em plan mode (bloqueia Write/Edit/Bash ate aprovar o plano)')}`);
  console.log(`  ${cmd('/retry')}${desc('Regenerar ultima resposta da IA')}`);
  console.log(`  ${cmd('/edit <texto>')}${desc('Editar ultima mensagem e retry')}`);
  console.log(`  ${cmd('/undo')}${desc('Desfazer ultima interacao')}`);
  console.log(`  ${cmd('/cost, /usage')}${desc('Ver tokens consumidos e custo estimado')}`);
  console.log(`  ${cmd('/ctx, /context')}${desc('Ver uso do context window')}`);
  console.log(`  ${cmd('<texto livre>')}${desc('Conversar com a IA sobre o projeto')}`);
  console.log();
  console.log(`  ${chalk.white.bold('Automacao')}`);
  console.log();
  console.log(`  ${cmd('/resume')}${desc('Retomar execucao de onde parou')}`);
  console.log(`  ${cmd('/rewind DUM-NNN')}${desc('Resetar DUMs a partir de N para pending')}`);
  console.log(`  ${cmd('/skills')}${desc('Listar skills disponiveis')}`);
  console.log(`  ${cmd('/schedule list')}${desc('Listar agendamentos')}`);
  console.log(`  ${cmd('/schedule add ...')}${desc('Criar agendamento cron')}`);
  console.log(`  ${cmd('/effort <level>')}${desc('Nivel de esforco: low|medium|high|max')}`);
  console.log(`  ${cmd('/hooks')}${desc('Listar hooks configurados')}`);
  console.log(`  ${cmd('/memory list|save')}${desc('Memoria persistente entre sessoes')}`);
  console.log();
  console.log(`  ${chalk.white.bold('Git')}`);
  console.log();
  console.log(`  ${cmd('/diff')}${desc('Ver git diff do projeto ativo')}`);
  console.log(`  ${cmd('/branch')}${desc('Listar branches')}`);
  console.log(`  ${cmd('/commit [msg]')}${desc('Commit (IA gera msg se nao passar)')}`);
  console.log(`  ${cmd('/commit-push-pr')}${desc('Commit + push + criar PR via gh')}`);
  console.log();
  console.log(`  ${chalk.white.bold('Sessao')}`);
  console.log();
  console.log(`  ${cmd('/save [nome]')}${desc('Snapshot da sessao atual')}`);
  console.log(`  ${cmd('/load [nome]')}${desc('Restaurar snapshot (com lista se nao passar nome)')}`);
  console.log(`  ${cmd('/trust on|off')}${desc('Modo confiavel (skip aprovacao)')}`);
  console.log(`  ${cmd('/debug')}${desc('Detalhes da ultima tool call')}`);
  console.log();
  console.log(`  ${chalk.white.bold('Plugins')}`);
  console.log();
  console.log(`  ${cmd('/plugin list')}${desc('Listar plugins instalados')}`);
  console.log(`  ${cmd('/plugin install <src>')}${desc('Instalar plugin (npm, local, git)')}`);
  console.log(`  ${cmd('/plugin remove <nome>')}${desc('Remover plugin')}`);
  console.log(`  ${cmd('/plugin enable <nome>')}${desc('Habilitar plugin')}`);
  console.log(`  ${cmd('/plugin disable <nome>')}${desc('Desabilitar plugin')}`);
  console.log(`  ${cmd('/kanban')}${desc('Kanban board no terminal')}`);
  console.log();

  // Show plugin-contributed commands
  try {
    const { pluginRegistry } = require('../core/plugin-registry');
    const pluginCmds = pluginRegistry.getCommands();
    if (pluginCmds.length > 0) {
      console.log(`  ${chalk.white.bold('Comandos de Plugins')}`);
      console.log();
      for (const c of pluginCmds) {
        console.log(`  ${cmd('/' + c.name)}${desc(c.description)}`);
      }
      console.log();
    }
  } catch (err) { swallow(err); }

  console.log(`  ${chalk.white.bold('Outros')}`);
  console.log();
  console.log(`  ${cmd('/health')}${desc('Verificar CLIs e configuracao')}`);
  console.log(`  ${cmd('/history [flags]')}${desc('Historico de execucoes')}`);
  console.log(`  ${cmd('/boilerplate')}${desc('Listar boilerplates registrados')}`);
  console.log(`  ${cmd('/init [flags]')}${desc('Inicializar projeto de boilerplate')}`);
  console.log(`  ${cmd('/help')}${desc('Mostrar esta ajuda')}`);
  console.log(`  ${cmd('/quit, /exit, Ctrl+C')}${desc('Sair do MakeStudio')}`);
  console.log();
}

export async function handleProjectSelect(input: string, ctx: ReplContext): Promise<void> {
  const idOrNum = input.replace(/^\/project\s*/, '').trim();
  if (!idOrNum) {
    if (ctx.activeProject) {
      console.log(`  ${green('*')} Projeto ativo: ${blue(ctx.activeProject.name)} ${dim(`(${ctx.activeProject.id.slice(0, 8)})`)}`);
    } else {
      console.log(`  ${yellow('!')} Nenhum projeto selecionado. Use ${cyan('/project <id ou numero>')}`);
    }
    return;
  }

  const projects = await ctx.fetchProjects();
  if (projects.length === 0) {
    console.log(`  ${yellow('!')} Nenhum projeto encontrado.`);
    return;
  }

  const num = parseInt(idOrNum, 10);
  let project: any;
  if (!isNaN(num) && num >= 1 && num <= projects.length) {
    project = projects[num - 1];
  } else {
    project = projects.find((p: any) => p.id.startsWith(idOrNum) || p.name.toLowerCase().includes(idOrNum.toLowerCase()));
  }

  if (!project) {
    console.log(`  ${yellow('!')} Projeto "${idOrNum}" nao encontrado.`);
    return;
  }

  ctx.setActiveProject({
    id: project.id,
    name: project.name,
    localPath: project.localPath || project.metadata?.localPath,
    status: project.status,
  });
  console.log(`  ${green('*')} Projeto ativo: ${blue(project.name)} ${dim(`(${project.id.slice(0, 8)})`)}`);
}

export async function handleProjectsList(ctx: ReplContext): Promise<void> {
  const projects = await ctx.fetchProjects();
  if (projects.length === 0) {
    console.log(`  ${yellow('!')} Nenhum projeto encontrado.`);
    return;
  }

  console.log();
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const active = ctx.activeProject?.id === p.id ? green(' *') : '  ';
    const status = dim(p.status || '-');
    console.log(`  ${active} ${cyan((i + 1).toString().padStart(2))}. ${chalk.white(p.name)} ${dim(`(${p.id.slice(0, 8)})`)} ${status}`);
  }
  console.log();
  console.log(`  ${dim('Use')} ${cyan('/project <numero>')} ${dim('para selecionar.')}`);
  console.log();
}

// Pricing tables moved to ./costs — single source of truth for `/cost`,
// the Phase 10 UsagePage aggregator and Phase 11 ProvidersPage.
export function handleCostCommand(ctx: ReplContext): void {
  const { promptTokens, completionTokens, totalTokens, cacheReads, cacheWrites, cacheMisses, requestCount, sessionStartedAt } = ctx.usage;
  const model = ctx.providerInfo?.model || 'unknown';
  const cost = estimateCost(model, promptTokens, completionTokens);
  // Cache reads typically cost 10% of input — estimate savings
  const cacheSavings = cacheReads > 0 ? (cacheReads / 1_000_000) * inputPrice(model) * 0.9 : 0;
  const hasPricing = pricingForModel(model) !== null;
  const elapsed = Math.round((Date.now() - sessionStartedAt) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  // Single multi-line console.log — the desktop bridge collapses each
  // console.log into one info bubble. Emitting separate calls produces
  // stacked single-liners (one Info icon each) instead of the SlashOutputCard
  // we want for /trust-style structured output. One block = one card.
  const lines: string[] = [
    `  ${chalk.white.bold('/cost')} ${dim('— uso da sessão')}`,
    `  ${dim('Provider:')}        ${cyan(ctx.providerInfo?.provider || 'unknown')}`,
    `  ${dim('Model:')}           ${cyan(model)}`,
    `  ${dim('Requests:')}        ${green(requestCount.toString())}`,
    `  ${dim('Prompt tokens:')}   ${green(promptTokens.toLocaleString())}`,
    `  ${dim('Output tokens:')}   ${green(completionTokens.toLocaleString())}`,
    `  ${dim('Total tokens:')}    ${green(totalTokens.toLocaleString())}`,
  ];
  if (cacheReads > 0 || cacheWrites > 0) {
    lines.push(`  ${dim('Cache reads:')}     ${green(cacheReads.toLocaleString())} ${dim('tokens')}`);
    lines.push(`  ${dim('Cache writes:')}    ${green(cacheWrites.toLocaleString())} ${dim('tokens')}`);
    if (cacheMisses > 0) lines.push(`  ${dim('Cache misses:')}    ${yellow(cacheMisses.toString())}`);
  }
  if (hasPricing) {
    lines.push(`  ${dim('Estimated cost:')} ${yellow('$' + cost.toFixed(4))} ${dim('USD')}`);
    if (cacheSavings > 0) {
      lines.push(`  ${dim('Cache savings:')}  ${green('-$' + cacheSavings.toFixed(4))} ${dim('USD (approx)')}`);
    }
  } else {
    lines.push(`  ${dim('Estimated cost:')} ${dim('(pricing not available for this model)')}`);
  }
  lines.push(`  ${dim('Session time:')}    ${cyan(mins > 0 ? `${mins}m${secs}s` : `${secs}s`)}`);
  console.log(lines.join('\n'));
}

function roughTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

export function handleCtxCommand(ctx: ReplContext): void {
  // Granular breakdown of system prompt sources
  let baseSystem = '';
  let memoryTokens = 0;
  let toolsTokens = 0;
  try {
    baseSystem = ctx.buildSystemPrompt();
    // Memory section (auto-injected from findRelevant)
    const { findRelevant } = require('./memory');
    const lastQ = ctx.lastUserMessage || '';
    if (lastQ) {
      const relevant = findRelevant(lastQ, 3);
      memoryTokens = relevant.reduce((sum: number, t: any) => sum + roughTokens(t.body.substring(0, 800)), 0);
    }
    // Tools (registered tool definitions)
    const { toolDefinitions } = require('./ai/tools');
    toolsTokens = toolDefinitions.reduce((sum: number, t: any) => sum + roughTokens(JSON.stringify(t)), 0);
  } catch (err) { swallow(err); }

  const systemTokens = roughTokens(baseSystem);

  // Messages breakdown by role
  let userTokens = 0, assistantTokens = 0, toolResultTokens = 0;
  for (const m of ctx.messages) {
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const t = roughTokens(body);
    if (m.role === 'user') userTokens += t;
    else if (m.role === 'assistant') assistantTokens += t;
    else toolResultTokens += t;
  }

  const messageTokens = userTokens + assistantTokens + toolResultTokens;
  const total = systemTokens + toolsTokens + memoryTokens + messageTokens;

  const model = (ctx.providerInfo?.model || '').toLowerCase();
  let maxContext = 128_000;
  if (model.includes('claude')) maxContext = 200_000;
  else if (model.includes('llama-4')) maxContext = 128_000;
  else if (model.includes('gpt-4')) maxContext = 128_000;
  else if (model.includes('gemini')) maxContext = 1_000_000;

  const pct = (total / maxContext) * 100;
  const bar = '█'.repeat(Math.max(1, Math.floor(pct / 2))) + '░'.repeat(Math.max(0, 50 - Math.floor(pct / 2)));
  const barColor = pct > 80 ? chalk.red : pct > 50 ? yellow : green;

  const fmt = (n: number) => n.toLocaleString().padStart(8);
  const pctOf = (n: number) => ((n / total) * 100).toFixed(1) + '%';

  // One console.log with embedded newlines — TUI router emits each
  // console.log call as a separate <Box> with marginTop:1, so multiple
  // calls leave a blank line between every row. Bundle the whole report
  // into a single string; <Text> handles \n natively.
  const lines: string[] = [];
  lines.push(`  ${chalk.white.bold('/ctx')} ${dim('— uso do context window')}`);
  lines.push(`  ${dim('System prompt:')}   ${green(fmt(systemTokens))} ${dim('(' + pctOf(systemTokens) + ')')}`);
  lines.push(`  ${dim('Tools:')}           ${green(fmt(toolsTokens))} ${dim('(' + pctOf(toolsTokens) + ')')}`);
  if (memoryTokens > 0) lines.push(`  ${dim('Memory prefetch:')} ${green(fmt(memoryTokens))} ${dim('(' + pctOf(memoryTokens) + ')')}`);
  lines.push(`  ${dim('User messages:')}   ${green(fmt(userTokens))} ${dim('(' + pctOf(userTokens) + ')')}`);
  lines.push(`  ${dim('Assistant msgs:')}  ${green(fmt(assistantTokens))} ${dim('(' + pctOf(assistantTokens) + ')')}`);
  if (toolResultTokens > 0) lines.push(`  ${dim('Tool results:')}    ${green(fmt(toolResultTokens))} ${dim('(' + pctOf(toolResultTokens) + ')')}`);
  lines.push(`  ${'─'.repeat(50)}`);
  lines.push(`  ${dim('Total:')}           ${cyan(fmt(total))}`);
  lines.push(`  ${dim('Model limit:')}     ${cyan(fmt(maxContext))}`);
  lines.push('');
  lines.push(`  ${barColor(bar)} ${barColor(pct.toFixed(1) + '%')}`);
  if (pct > 80) {
    lines.push('');
    lines.push(`  ${chalk.red('!')} ${dim('Context is getting full. Consider /clear to reset conversation.')}`);
  }
  console.log(lines.join('\n'));
}

export function handleProviderSwitch(input: string, ctx: ReplContext): void {
  const provider = input.replace(/^\/ai\s*/, '').trim().toLowerCase();
  const valid = ['claude', 'codex', 'gemini'];
  if (!provider || !valid.includes(provider)) {
    console.log(`  ${dim('Provider atual:')} ${blue(ctx.provider)}`);
    console.log(`  ${dim('Opcoes:')} ${valid.map(v => cyan(v)).join(', ')}`);
    return;
  }
  ctx.provider = provider as any;
  console.log(`  ${green('*')} Provider alterado para ${blue(provider)}`);
}

export async function handleModelCommand(input: string, ctx?: ReplContext): Promise<void> {
  const { fetchCatalog, getCatalog, tierAvailable, overrideEntry } = require('./ai/providers/catalog');
  const rest = input.replace(/^\/model\s*/, '').trim().toLowerCase();

  if (!rest || rest === 'refresh') {
    console.log(`  ${dim('Buscando catalogo no backend...')}`);
    const cat = await fetchCatalog({ force: true });
    // Render the whole catalog as ONE log call. Each console.log is
    // wrapped as a separate TUI message with its own top-margin, so
    // emitting one line at a time leaves blank lines between tiers.
    // Building the block and emitting it once keeps the listing tight.
    const lines: string[] = [`  ${chalk.white.bold('Catalogo de modelos')}`];
    for (const tier of ['fast', 'default', 'image']) {
      const entry = cat[tier];
      const ok = tierAvailable(tier) ? green('OK') : yellow('sem chave');
      lines.push(`  ${cyan(tier.padEnd(8))} ${entry.provider}:${entry.model}  [${ok}]`);
    }
    console.log(lines.join('\n'));
    return;
  }

  // Parse: /model <tier> [<provider:model>]
  const parts = rest.split(/\s+/);
  const validTiers = ['fast', 'default', 'image'];

  if (validTiers.includes(parts[0])) {
    if (parts.length === 1) {
      // Inspect a single tier
      const cat = getCatalog();
      const entry = cat[parts[0]];
      const ok = tierAvailable(parts[0]) ? green('OK') : yellow('sem chave configurada');
      console.log(`  ${cyan(parts[0])} -> ${entry.provider}:${entry.model}  [${ok}]`);
      return;
    }

    // Set model for a tier: /model fast|default|image <provider:model>
    const tier = parts[0];
    const modelStr = parts.slice(1).join(' ');
    const colonIdx = modelStr.indexOf(':');
    const provider = colonIdx >= 0 ? modelStr.slice(0, colonIdx) : tier;
    const model = colonIdx >= 0 ? modelStr.slice(colonIdx + 1) : modelStr;

    overrideEntry(tier as any, { provider, model });
    console.log(`  ${green('*')} ${cyan(tier)} alterado para ${cyan(provider)}:${cyan(model)}`);

    // If image tier was changed, sync ctx.providerInfo so the vision
    // pipeline in chat.ts uses the new model immediately.
    if (tier === 'image' && ctx?.providerInfo) {
      ctx.providerInfo.visionProvider = provider;
      ctx.providerInfo.visionModel = model;
      console.log(`  ${dim('(providerInfo.visionModel syncado para o novo modelo)')}`);
    }
    return;
  }

  console.log(`  ${yellow('Uso:')} /model [fast|default|image|refresh]`);
  console.log(`  ${yellow('      ')} /model <tier> <provider:model>`);
}
