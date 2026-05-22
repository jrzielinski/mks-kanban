import { swallow } from './utils/log';
// Suppress Node.js deprecation warnings from dependencies (axios url.parse)
process.removeAllListeners('warning');

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { startCommand } from './commands/start';
import { statusCommand } from './commands/status';
import { tasksCommand, taskDetailCommand } from './commands/tasks';
import { projectsCommand, projectDeleteCommand } from './commands/projects';
import { hoursLogCommand, hoursTodayCommand, hoursWeekCommand, timerStartCommand, timerStopCommand } from './commands/hours';
import { agentsCommand } from './commands/agents';
import { historyCommand } from './commands/history';
import { telemetryCommand } from './commands/telemetry';
import { prListCommand } from './commands/pr';
import { execCommand } from './commands/exec';
import { configCommand } from './commands/config';
import { healthCommand } from './commands/health';
import { analyzeCommand } from './commands/analyze';
import { planCommand } from './commands/plan';
import { syncCommand } from './commands/sync';
import { initCommand } from './commands/init';
import { refineCommand } from './commands/refine';
import { executeCommand } from './commands/execute';
import { newProjectCommand } from './commands/new';
import { doctorCommand } from './commands/doctor';
import { securityReviewCommand } from './commands/security-review';
import { pluginInstallCommand, pluginRemoveCommand, pluginListCommand, pluginEnableCommand, pluginDisableCommand } from './commands/plugin';
import { providerListCommand, providerRemoveCommand, providerSetCommand } from './commands/provider';
import { boilerplateCommand } from './commands/boilerplate';
import { attachBoilerplateCommand } from './commands/attach-boilerplate';
import { dumViewCommand } from './commands/dum-view';
import { scheduledRunCommand } from './commands/scheduled-run';
import { loadAllPlugins } from './core/plugin-manager';
import { pluginRegistry } from './core/plugin-registry';

// Read version from package.json at runtime — single source of truth.
// Works in dev (build/index.js → ../package.json), production bundle
// (dist/index.js → ../package.json) and globally linked install
// (node_modules/@makestudio/agent/dist/index.js → ../package.json).
const PKG_VERSION: string = (() => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const program = new Command();

program
  .name('makestudio')
  .description('MakeStudio — Plataforma autônoma de desenvolvimento de software com IA')
  .version(PKG_VERSION);

// ── Auth ─────────────────────────────────────────────────────────

program
  .command('login')
  .description('Autenticar no servidor MakeStudio (email + senha)')
  .option('-s, --server <url>', 'URL do servidor (default: https://api.zielinski.dev.br)', 'https://api.zielinski.dev.br')
  .option('-e, --email <email>', 'Endereço de email (pergunta se não informado)')
  .action(loginCommand);

program
  .command('logout')
  .description('Remover credenciais salvas e desconectar do servidor')
  .action(logoutCommand);

// ── Agent ────────────────────────────────────────────────────────

// CLI-first project creation — entrevista interativa + spec + decomposição
// + pipeline. Não requer frontend. Quem instala `makestudio` no terminal
// roda este comando uma vez e ganha o ciclo completo até o `execute`.
program
  .command('new')
  .alias('create')
  .description('Criar projeto do zero via entrevista interativa (spec → DUMs → pipeline)')
  .option('-s, --spec <file>', 'Pular entrevista e carregar spec markdown já pronta de um arquivo')
  .option('-n, --name <name>', 'Nome do projeto (pergunta se não informado)')
  .option('--stack <stack>', 'Override de stack (ex: "nest+next+postgres"); inferido se omitido')
  .option('--api-config <id>', 'ID do ApiConfig a usar para a entrevista (usa default do tenant se omitido)')
  .option('--auto-execute', 'Depois de gerar DUMs, dispara `execute` automaticamente')
  .option('--only-decompose', 'Parar após decomposição; não gerar pipeline nem executar')
  .option('--non-interactive', 'Pula perguntas após a entrevista — usa defaults (sem boilerplate/repo, stack inferida)')
  .action((opts) => newProjectCommand({
    specFile: opts.spec,
    name: opts.name,
    stack: opts.stack,
    apiConfigId: opts.apiConfig,
    autoExecute: opts.autoExecute,
    onlyDecompose: opts.onlyDecompose,
    nonInteractive: opts.nonInteractive,
  }));

program
  .command('refine')
  .description('Refinar projeto existente — re-enriquece spec, valida requisitos e opcionalmente re-decompõe')
  .option('--project-id <id>', 'ID do projeto (ou seleciona interativamente)')
  .option('-c, --cli <name>', 'CLI de IA: makestudio (self-hosted), claude, codex ou gemini')
  .option('--no-decompose', 'Pular decomposição de pipeline (só spec + requisitos)')
  .option('--requirements-only', 'Pular enriquecimento de spec, só validar requisitos')
  .option('--repo <path>', 'Caminho do repositório local (bypass wizard)')
  .action((opts) => refineCommand({
    projectId: opts.projectId,
    cli: opts.cli,
    noDecompose: opts.noDecompose,
    requirementsOnly: opts.requirementsOnly,
    repo: opts.repo,
  }));

program
  .command('init')
  .description('Inicializar projeto a partir de um boilerplate — cria repo GitHub, troca remote e adapta com IA')
  .option('-p, --path <dir>', 'Diretório do projeto (default: diretório atual)')
  .option('-c, --cli <name>', 'CLI de IA para adaptação: claude, codex ou gemini')
  .option('-y, --yes', 'Aceitar defaults sem perguntar (modo não-interativo)')
  .action(initCommand);

program
  .command('start')
  .description('Conectar agent ao servidor e aguardar tasks via WebSocket (modo persistente)')
  .option('-r, --repo <path>', 'Caminho do repositório único (ou configure por layer abaixo)')
  .option('--repo-backend <path>', 'Caminho local do repo backend (bypass wizard)')
  .option('--repo-frontend <path>', 'Caminho local do repo frontend (bypass wizard)')
  .option('--repo-mobile <path>', 'Caminho local do repo mobile (bypass wizard)')
  .option('-c, --cli <name>', 'CLI de IA para execução: claude, codex ou gemini')
  .option('--simple', 'Saída texto simples em vez de TUI interativo')
  .option('--reconfigure', 'Forçar re-execução do wizard de configuração de repos')
  .option('--auto', 'Modo autônomo: buscar e executar tasks pendentes automaticamente')
  .option('--auto-poll <seconds>', 'Intervalo de polling no modo auto (padrão: 30s)', parseInt)
  .action(startCommand);

program
  .command('status')
  .description('Exibir status da conexão, licença, versões de CLI e agents conectados')
  .option('--json', 'Output in JSON format')
  .action((opts) => statusCommand({ json: opts.json }));

// ── Tasks ────────────────────────────────────────────────────────

program
  .command('tasks')
  .description('Listar tasks atribuídas ao usuário com filtros opcionais')
  .option('-p, --project-id <id>', 'Filtrar por projeto')
  .option('-d, --dum-id <id>', 'Filtrar por DUM (unidade de trabalho)')
  .option('-s, --status <status>', 'Filtrar por status: pending, in_progress, completed, failed')
  .option('--json', 'Output in JSON format')
  .action((opts) => tasksCommand({ projectId: opts.projectId, dumId: opts.dumId, status: opts.status, json: opts.json }));

program
  .command('task <id>')
  .description('Ver detalhes completos de uma task (prompt, status, artifacts, custo)')
  .option('--json', 'Output in JSON format')
  .action((id, opts) => taskDetailCommand(id as string, { json: opts?.json }));

program
  .command('exec <taskId>')
  .description('Executar task manualmente na máquina local usando o CLI de IA conectado')
  .action(execCommand);

program
  .command('execute')
  .description('Execução completa do projeto — topological sort, task a task com contexto acumulado')
  .option('-p, --project-id <id>', 'ID do projeto (interativo se omitido)')
  .option('-c, --cli <name>', 'CLI de IA: makestudio (self-hosted, default), claude, codex ou gemini', 'makestudio')
  .option('--skip-checkpoint', 'Pular verificação de compilação após cada DUM')
  .option('--only-dum <number>', 'Executar apenas um DUM específico (ex: DUM-003)')
  .option('--dry-run', 'Mostrar o que seria executado sem rodar')
  .option('--skip-doctor', 'Pular o smoke test final')
  .option('--doctor-deep', 'Incluir flutter build apk no doctor (lento, ~5min)')
  .option('--plan', 'Pedir aprovação de plano antes de cada DUM (gera .makestudio/plans/<dum>.md)')
  .option('--plan-dums <list>', 'DUMs que exigem plano (ex: DUM-021,DUM-032)')
  .option('--skip-review', 'Pular code review pós-DUM')
  .option('--review-fix', 'Auto-corrigir findings bloqueantes do code review')
  .option('--isolate', 'Rodar cada DUM em git worktree isolada (.makestudio/worktrees/<dum>)')
  .option('--isolate-dums <list>', 'DUMs específicos para isolar (ex: DUM-021,DUM-032)')
  .action((opts) => executeCommand({
    projectId: opts.projectId,
    cli: opts.cli,
    skipCheckpoint: opts.skipCheckpoint,
    onlyDum: opts.onlyDum,
    dryRun: opts.dryRun,
    skipDoctor: opts.skipDoctor,
    doctorDeep: opts.doctorDeep,
    plan: opts.plan,
    planDums: opts.planDums,
    skipReview: opts.skipReview,
    reviewFix: opts.reviewFix,
    isolate: opts.isolate,
    isolateDums: opts.isolateDums,
  }));

program
  .command('doctor')
  .description('Runtime smoke test — sobe as stacks (api/web/mobile) e corrige erros automaticamente')
  .option('-p, --project-id <id>', 'ID do projeto (interativo se omitido)')
  .option('-c, --cli <name>', 'CLI de IA para auto-fix', 'claude')
  .option('--deep', 'Incluir flutter build apk (lento, ~5min)')
  .option('--skip-fix', 'Apenas verificar, sem tentar corrigir')
  .option('--max-passes <n>', 'Máximo de tentativas de auto-fix', '3')
  .option('--repo <path>', 'Caminho local do repo (override)')
  .action((opts) => doctorCommand({
    projectId: opts.projectId,
    cli: opts.cli,
    deep: opts.deep,
    skipFix: opts.skipFix,
    maxPasses: parseInt(opts.maxPasses, 10),
    repo: opts.repo,
  }));

program
  .command('security-review')
  .description('Auditoria de seguranca focada nas mudancas pendentes da branch')
  .option('-c, --cli <name>', 'CLI de IA: makestudio (self-hosted, default), claude, codex ou gemini', 'makestudio')
  .option('-b, --base <ref>', 'Ref de comparacao (default: origin/HEAD ou fallback)')
  .option('-o, --output <path>', 'Caminho do relatorio (default: .makestudio/security-reviews/<timestamp>.md)')
  .action((opts) => securityReviewCommand({
    cli: opts.cli,
    base: opts.base,
    outputFile: opts.output,
  }));

// ── Projects ─────────────────────────────────────────────────────

const projectsCmd = program
  .command('projects')
  .description('Gerenciar projetos — listar, excluir');

projectsCmd
  .command('list')
  .description('Listar todos os projetos com status, tasks e custo')
  .option('--json', 'Output in JSON format')
  .action((opts) => projectsCommand({ json: opts?.json }));

projectsCmd
  .command('delete <id>')
  .description('Excluir um projeto pelo ID (pede confirmação)')
  .option('-f, --force', 'Excluir sem pedir confirmação')
  .action(projectDeleteCommand);

// Alias: `makestudio projects` sem subcomando = list
projectsCmd
  .option('--json', 'Output in JSON format')
  .action((opts) => projectsCommand({ json: opts?.json }));

// ── Attach boilerplate to existing project ─────────────────────

program
  .command('attach-boilerplate [projectId] [slug]')
  .alias('attach-boil')
  .description('Anexar um boilerplate a um projeto JÁ existente (preenche boilerplateId, opcionalmente cria repo e refaz analyst)')
  .option('--re-analyze', 'Re-rodar /start-analysis depois de anexar (refaz DUMs com o promptContext do boilerplate)')
  .option('--create-repo', 'Bootstrapar repo no GitHub a partir do boilerplate')
  .option('--owner <owner>', 'GitHub owner (user ou org) — necessário com --create-repo')
  .option('--name <name>', 'Nome do repo (default: slug do nome do projeto)')
  .option('--git-token <token>', 'PAT com scope `repo` (default: usa gh auth do agent local via /repo/create-via-agent)')
  .option('--public', 'Criar o repo como público (default: privado)')
  .action((projectId, slug, opts) => attachBoilerplateCommand(projectId, slug, {
    reAnalyze: !!opts.reAnalyze,
    createRepo: !!opts.createRepo,
    owner: opts.owner,
    name: opts.name,
    gitToken: opts.gitToken,
    private: !opts.public,
  }));

// ── Analyze & Audit ──────────────────────────────────────────────

program
  .command('analyze')
  .description('Analisar ou auditar codebase — IA lê código localmente, envia apenas metadados JSON ao servidor')
  .option('-p, --path <dir>', 'Diretório do projeto (default: diretório atual)')
  .option('--deep', 'Análise profunda: lê TODAS entities, controllers, services, migrations')
  .option('--audit', 'Auditoria completa: segurança, qualidade, testes, arquitetura + backlog + roadmap')
  .option('-c, --cli <name>', 'CLI de IA: makestudio (self-hosted, default), claude, codex ou gemini', 'makestudio')
  .option('--project-id <id>', 'Enviar resultado para projeto existente em vez de criar novo')
  .option('--force', 'Ignorar cache e forçar nova análise completa')
  .action(analyzeCommand);

// ── Plan ─────────────────────────────────────────────────────────

program
  .command('plan <description>')
  .description('Descrever mudança em linguagem natural — dispara pipeline: análise → requisitos → DUM → tasks → agent')
  .option('--project-id <id>', 'ID do projeto alvo (default: auto-detecta pelo diretório ou mais recente)')
  .action(planCommand);

// ── Hours / Timesheet ────────────────────────────────────────────

const hours = program
  .command('hours')
  .description('Controle de horas — registrar horas, relatórios diários/semanais, timers');

hours
  .command('log <taskId> <hours>')
  .description('Registrar horas trabalhadas em uma task')
  .option('-d, --description <text>', 'O que foi feito nessas horas')
  .action(hoursLogCommand);

hours
  .command('today')
  .description('Mostrar horas registradas hoje com detalhamento por task')
  .action(hoursTodayCommand);

hours
  .command('week')
  .description('Mostrar horas da semana com detalhamento diário')
  .action(hoursWeekCommand);

hours
  .command('timer:start')
  .description('Iniciar timer de controle de tempo')
  .option('-t, --task-id <id>', 'Associar timer a uma task específica')
  .action(timerStartCommand);

hours
  .command('timer:stop <id>')
  .description('Parar timer e registrar o tempo decorrido')
  .action(timerStopCommand);

// ── Agents ───────────────────────────────────────────────────────

program
  .command('agents')
  .description('Mostrar agents conectados ao servidor (hostname, CLI, status)')
  .option('--json', 'Output in JSON format')
  .action((opts) => agentsCommand({ json: opts.json }));

// ── History ──────────────────────────────────────────────────────

program
  .command('history')
  .description('Histórico de execuções — tasks executadas com status, custo e duração')
  .option('-l, --limit <number>', 'Máximo de resultados (default: 50)', '50')
  .option('-p, --project-id <id>', 'Filtrar por projeto')
  .option('--json', 'Output in JSON format')
  .action((opts) => historyCommand({ limit: opts.limit, projectId: opts.projectId, json: opts.json }));

// ── Telemetry ────────────────────────────────────────────────────

program
  .command('telemetry')
  .description('Resumo da telemetria de decomposição de DUMs (tempo, retry rate, causas)')
  .option('--all', 'Agregar todos os arquivos JSONL em .makestudio/telemetry/')
  .option('--json', 'Imprimir saída em JSON cru')
  .option('--file <path>', 'Caminho específico de um arquivo .jsonl')
  .action(telemetryCommand);

// ── PRs ──────────────────────────────────────────────────────────

const pr = program
  .command('pr')
  .description('Pull requests — listar e acompanhar PRs criadas pelo pipeline');

pr
  .command('list')
  .description('Listar pull requests abertas com branch, status e review')
  .option('-p, --project-id <id>', 'Filtrar por projeto')
  .option('--json', 'Output in JSON format')
  .action((opts) => prListCommand({ projectId: opts.projectId, json: opts.json }));

// ── Sync ─────────────────────────────────────────────────────────

program
  .command('sync')
  .description('Sincronizar fila offline — reenviar análises/auditorias pendentes')
  .action(syncCommand);

// ── Config ───────────────────────────────────────────────────────

program
  .command('config')
  .description('Ver ou atualizar configuração local (URL do servidor, credenciais)')
  .option('-s, --server <url>', 'Definir URL do servidor MakeStudio')
  .option('--show', 'Exibir valores atuais da configuração')
  .option('--json', 'Output in JSON format')
  .action((opts) => configCommand({ server: opts.server, show: opts.show, json: opts.json }));

// ── Plugins ─────────────────────────────────────────────────────

const pluginCmd = program
  .command('plugin')
  .description('Gerenciar plugins — instalar, remover, listar, habilitar/desabilitar');

pluginCmd
  .command('install <source>')
  .description('Instalar plugin (npm package, local path ou git URL)')
  .action(pluginInstallCommand);

pluginCmd
  .command('remove <name>')
  .description('Remover plugin instalado')
  .action(pluginRemoveCommand);

pluginCmd
  .command('list')
  .description('Listar plugins instalados com status')
  .option('--json', 'Output in JSON format')
  .action((opts) => pluginListCommand({ json: opts?.json }));

pluginCmd
  .command('enable <name>')
  .description('Habilitar plugin desabilitado')
  .action(pluginEnableCommand);

pluginCmd
  .command('disable <name>')
  .description('Desabilitar plugin sem remover')
  .action(pluginDisableCommand);

// Alias: `makestudio plugin` sem subcomando = list
pluginCmd.option('--json', 'Output in JSON format').action((opts) => pluginListCommand({ json: opts?.json }));

// ── Provider Credentials ────────────────────────────────────────

const providerCmd = program
  .command('provider')
  .description('Gerenciar chaves de API dos providers diretos (OpenAI, Anthropic, Groq, Cerebras, DeepSeek)');

providerCmd
  .command('list')
  .description('Listar providers configurados e status das chaves')
  .option('--json', 'Output in JSON format')
  .action((opts) => providerListCommand({ json: opts?.json }));

providerCmd
  .command('set <name>')
  .description('Salvar chave API (criptografada) para um provider')
  .option('--key <key>', 'Chave da API (pergunta se omitida)')
  .action(providerSetCommand);

providerCmd
  .command('remove <name>')
  .description('Remover chave de um provider')
  .action(providerRemoveCommand);

// Alias: `makestudio provider` sem subcomando = list
providerCmd.option('--json', 'Output in JSON format').action((opts) => providerListCommand({ json: opts?.json }));

// ── Boilerplate Registry ──────────────────────────────────────────

const bpCmd = program
  .command('boilerplate')
  .description('Gerenciar registro de boilerplates locais')
  .option('-l, --list', 'Listar boilerplates registrados')
  .option('-s, --setup [dir]', 'Auto-registrar de ~/develop/boilerplates/ (ou dir especificado)')
  .option('-r, --remove <slug>', 'Remover boilerplate')
  .option('-t, --test <stack>', 'Testar matching (ex: "NestJS,React:10")')
  .action((opts) => boilerplateCommand({
    list: opts.list,
    setup: opts.setup,
    remove: opts.remove,
    test: opts.test,
  }));

bpCmd
  .command('add <slug> <localPath>')
  .description('Registrar boilerplate manualmente')
  .action((slug, localPath) => boilerplateCommand({ add: [slug, localPath] }));

// ── DUM Viewer ───────────────────────────────────────────────────

program
  .command('dum-view [files...]')
  .description('Gerar visualização web bonita de DUMs — lê JSON e abre no browser')
  .option('-o, --output <path>', 'Caminho do arquivo HTML de saída')
  .option('--no-open', 'Não abrir automaticamente no browser')
  .action((files, opts) => dumViewCommand(files || [], { output: opts.output, noOpen: !opts.open }));

// ── Scheduled run (daemon entry point) ───────────────────────────
program
  .command('scheduled-run')
  .description('Run all due scheduled tasks and exit (for launchd/systemd/cron)')
  .action(scheduledRunCommand);

// ── Health Check ─────────────────────────────────────────────────

program
  .command('health')
  .description('Verificar se o agent está funcionando corretamente (config, CLIs, execução)')
  .option('-c, --cli <name>', 'Testar apenas um CLI específico (claude, codex, gemini)')
  .option('-v, --verbose', 'Mostrar saída completa dos CLIs')
  .action(healthCommand);

// ── Custom colored help ──────────────────────────────────────────

import chalk from 'chalk';

const v = chalk.hex('#60A5FA');      // blue (flags/options)
const c = chalk.hex('#22D3EE');      // cyan bright (comandos)
const g = chalk.hex('#94A3B8');      // slate-400 (descrições - mais claro)
const w = chalk.white;
const b = chalk.bold;
const dim = chalk.hex('#64748B');    // slate-500 (args opcionais)

function showDetailedHelp() {
  const line = chalk.hex('#475569')('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const cmd = (s: string) => c.bold(s);
  const flag = (s: string) => v(s);
  const desc = (s: string) => g(s);
  const section = (s: string) => chalk.hex('#E2E8F0').bold.underline(s);

  console.log();
  console.log(line);
  console.log();
  console.log(`  ${chalk.hex('#38BDF8').bold('REFERÊNCIA DETALHADA DE COMANDOS')}`);

  // Auth
  console.log();
  console.log(`  ${section('Autenticação')}`);
  console.log();
  console.log(`  ${cmd('makestudio login')} ${dim('[-s <url>] [-e <email>]')}`);
  console.log(`    ${flag('-s, --server <url>')}     ${desc('URL do servidor (default: https://api.zielinski.dev.br)')}`);
  console.log(`    ${flag('-e, --email <email>')}    ${desc('Email de login (pergunta se não informado)')}`);
  console.log();
  console.log(`  ${cmd('makestudio logout')}`);
  console.log(`    ${desc('Remove token salvo de ~/.makestudio/config.json')}`);

  // New + Init + Refine
  console.log();
  console.log(`  ${section('Criação e Refinamento de Projetos')}`);
  console.log();
  console.log(`  ${cmd('makestudio new')} ${dim('[-n <name>] [-s <spec.md>] [--auto-execute] [--only-decompose]')}`);
  console.log(`    ${desc('CRIA projeto DO ZERO via entrevista interativa (não-técnica) com o cliente.')}`);
  console.log(`    ${desc('Entrevista → spec markdown → enriquecimento → DUMs → pipeline → (opcional) execute.')}`);
  console.log(`    ${flag('-n, --name <name>')}       ${desc('Nome do projeto (perguntado se omitido)')}`);
  console.log(`    ${flag('-s, --spec <file>')}        ${desc('Pular entrevista e carregar spec markdown já pronta')}`);
  console.log(`    ${flag('--stack <stack>')}          ${desc('Override de stack (ex: "nest+next+postgres")')}`);
  console.log(`    ${flag('--api-config <id>')}        ${desc('ApiConfig para a entrevista (usa default do tenant)')}`);
  console.log(`    ${flag('--auto-execute')}           ${desc('Dispara execute automaticamente depois dos DUMs')}`);
  console.log(`    ${flag('--only-decompose')}         ${desc('Parar após decomposição; não gerar pipeline')}`);
  console.log();
  console.log(`  ${cmd('makestudio init')} ${dim('[-p <dir>] [-c <cli>] [-y]')}`);
  console.log(`    ${desc('Inicializa um boilerplate como novo projeto real.')}`);
  console.log(`    ${desc('Cria repo GitHub, troca remote origin, faz push e adapta o código com IA.')}`);
  console.log(`    ${flag('-p, --path <dir>')}     ${desc('Diretório do projeto (default: diretório atual)')}`);
  console.log(`    ${flag('-c, --cli <name>')}      ${desc('CLI de IA para adaptação: claude, codex ou gemini')}`);
  console.log(`    ${flag('-y, --yes')}             ${desc('Aceitar defaults sem perguntar')}`);
  console.log();
  console.log(`  ${cmd('makestudio refine')} ${dim('[--project-id <id>] [--no-decompose] [--repo <path>]')}`);
  console.log(`    ${desc('Corrige projetos criados antes dos quality gates.')}`);
  console.log(`    ${desc('Re-enriquece spec, valida requisitos e opcionalmente re-decompõe pipeline.')}`);
  console.log(`    ${flag('--project-id <id>')}    ${desc('ID do projeto (seleção interativa se omitido)')}`);
  console.log(`    ${flag('--no-decompose')}        ${desc('Pular decomposição de pipeline')}`);
  console.log(`    ${flag('--requirements-only')}   ${desc('Pular enriquecimento de spec')}`);
  console.log(`    ${flag('--repo <path>')}         ${desc('Caminho do repositório local (bypass wizard)')}`);

  // Agent
  console.log();
  console.log(`  ${section('Agent')}`);
  console.log();
  console.log(`  ${cmd('makestudio start')} ${dim('[-r <path>] [-c <cli>] [--simple]')}`);
  console.log(`    ${flag('-r, --repo <path>')}     ${desc('Caminho do repositório (default: diretório atual)')}`);
  console.log(`    ${flag('-c, --cli <name>')}      ${desc('CLI de IA: makestudio (self-hosted, default), claude, codex ou gemini')}`);
  console.log(`    ${flag('--simple')}              ${desc('Saída texto simples em vez de TUI interativo')}`);
  console.log();
  console.log(`  ${cmd('makestudio status')}`);
  console.log(`    ${desc('Exibe licença, seats, versões de CLI e agents conectados')}`);

  // Tasks
  console.log();
  console.log(`  ${section('Tasks')}`);
  console.log();
  console.log(`  ${cmd('makestudio tasks')} ${dim('[-p <id>] [-d <id>] [-s <status>]')}`);
  console.log(`    ${flag('-p, --project-id <id>')} ${desc('Filtrar por projeto')}`);
  console.log(`    ${flag('-d, --dum-id <id>')}     ${desc('Filtrar por DUM (unidade de trabalho)')}`);
  console.log(`    ${flag('-s, --status <status>')} ${desc('Filtrar: pending | in_progress | completed | failed')}`);
  console.log();
  console.log(`  ${cmd('makestudio task <id>')}`);
  console.log(`    ${desc('Detalhes completos: prompt, status, artifacts, git info, custo')}`);
  console.log();
  console.log(`  ${cmd('makestudio exec <taskId>')}`);
  console.log(`    ${desc('Despachar task para execução imediata no agent local')}`);
  console.log();
  console.log(`  ${cmd('makestudio execute')} ${dim('[-p <id>] [-c <cli>] [--skip-checkpoint] [--only-dum <num>] [--dry-run]')}`);
  console.log(`    ${flag('-p, --project-id <id>')} ${desc('ID do projeto (interativo se omitido)')}`);
  console.log(`    ${flag('-c, --cli <name>')}      ${desc('CLI de IA: makestudio (self-hosted, default), claude, codex ou gemini')}`);
  console.log(`    ${flag('--skip-checkpoint')}     ${desc('Pular verificação de compilação após cada DUM')}`);
  console.log(`    ${flag('--only-dum <number>')}   ${desc('Executar apenas um DUM específico (ex: DUM-003)')}`);
  console.log(`    ${flag('--dry-run')}             ${desc('Mostrar o que seria executado sem rodar nada')}`);

  // Projects
  console.log();
  console.log(`  ${section('Projetos')}`);
  console.log();
  console.log(`  ${cmd('makestudio projects')}             ${desc('Lista todos os projetos com status, tasks e custo')}`);
  console.log(`  ${cmd('makestudio projects list')}        ${desc('Mesmo que acima')}`);
  console.log(`  ${cmd('makestudio projects delete <id>')} ${dim('[-f]')}`);
  console.log(`    ${flag('<id>')}                  ${desc('ID do projeto (ou os primeiros 8 caracteres)')}`);
  console.log(`    ${flag('-f, --force')}           ${desc('Excluir sem pedir confirmação')}`);

  // Analyze
  console.log();
  console.log(`  ${section('Análise & Auditoria')}`);
  console.log();
  console.log(`  ${cmd('makestudio analyze')} ${dim('[-p <dir>] [--deep] [--audit] [-c <cli>] [--project-id <id>]')}`);
  console.log(`    ${flag('-p, --path <dir>')}      ${desc('Diretório do projeto (default: diretório atual)')}`);
  console.log(`    ${flag('--deep')}                ${desc('Lê TODAS entities, controllers, services, migrations')}`);
  console.log(`    ${flag('--audit')}               ${desc('Auditoria: segurança, qualidade, testes, arquitetura + backlog + roadmap')}`);
  console.log(`    ${flag('-c, --cli <name>')}      ${desc('CLI de IA: makestudio (self-hosted, default), claude, codex ou gemini')}`);
  console.log(`    ${flag('--project-id <id>')}     ${desc('Enviar para projeto existente em vez de criar novo')}`);

  // Plan
  console.log();
  console.log(`  ${section('Planejamento')}`);
  console.log();
  console.log(`  ${cmd('makestudio plan <descrição>')} ${dim('[--project-id <id>]')}`);
  console.log(`    ${flag('<descrição>')}            ${desc('Pedido de mudança em linguagem natural (entre aspas)')}`);
  console.log(`    ${flag('--project-id <id>')}     ${desc('Projeto alvo (default: auto-detecta pelo diretório ou mais recente)')}`);

  // Hours
  console.log();
  console.log(`  ${section('Controle de Horas')}`);
  console.log();
  console.log(`  ${cmd('makestudio hours log <taskId> <horas>')} ${dim('[-d <texto>]')}`);
  console.log(`    ${flag('-d, --description')}     ${desc('O que foi feito nessas horas')}`);
  console.log();
  console.log(`  ${cmd('makestudio hours today')}    ${desc('Horas registradas hoje com detalhamento por task')}`);
  console.log(`  ${cmd('makestudio hours week')}     ${desc('Horas da semana com detalhamento diário')}`);
  console.log(`  ${cmd('makestudio hours timer:start')} ${dim('[-t <taskId>]')}  ${desc('Iniciar timer')}`);
  console.log(`  ${cmd('makestudio hours timer:stop <id>')}           ${desc('Parar timer e registrar tempo')}`);

  // Agents & History
  console.log();
  console.log(`  ${section('Agents & Histórico')}`);
  console.log();
  console.log(`  ${cmd('makestudio agents')}`);
  console.log(`    ${desc('Agents conectados: hostname, CLI, repo, status')}`);
  console.log();
  console.log(`  ${cmd('makestudio history')} ${dim('[-l <n>] [-p <id>]')}`);
  console.log(`    ${flag('-l, --limit <n>')}       ${desc('Máximo de resultados (default: 50)')}`);
  console.log(`    ${flag('-p, --project-id <id>')} ${desc('Filtrar por projeto')}`);

  // PRs
  console.log();
  console.log(`  ${section('Pull Requests')}`);
  console.log();
  console.log(`  ${cmd('makestudio pr list')} ${dim('[-p <id>]')}`);
  console.log(`    ${flag('-p, --project-id <id>')} ${desc('Filtrar por projeto')}`);

  // Config
  console.log();
  console.log(`  ${section('Sincronização Offline')}`);
  console.log();
  console.log(`  ${cmd('makestudio sync')}`);
  console.log(`    ${desc('Reenviar análises e auditorias que falharam por falta de conexão')}`);
  console.log(`    ${desc('Itens são salvos automaticamente em ~/.makestudio/offline-queue.json')}`);

  // Config
  console.log();
  console.log(`  ${section('Configuração')}`);
  console.log();
  console.log(`  ${cmd('makestudio config')} ${dim('[-s <url>] [--show]')}`);
  console.log(`    ${flag('-s, --server <url>')}    ${desc('Definir URL do servidor')}`);
  console.log(`    ${flag('--show')}               ${desc('Exibir configuração atual')}`);

  // Plugins
  console.log();
  console.log(`  ${section('Plugins')}`);
  console.log();
  console.log(`  ${cmd('makestudio plugin list')}              ${desc('Listar plugins instalados com status')}`);
  console.log(`  ${cmd('makestudio plugin install <source>')}  ${desc('Instalar plugin (npm, local ou git)')}`);
  console.log(`  ${cmd('makestudio plugin remove <name>')}     ${desc('Remover plugin instalado')}`);
  console.log(`  ${cmd('makestudio plugin enable <name>')}     ${desc('Habilitar plugin desabilitado')}`);
  console.log(`  ${cmd('makestudio plugin disable <name>')}    ${desc('Desabilitar plugin sem remover')}`);

  // Examples
  console.log();
  console.log(line);
  console.log();
  console.log(`  ${w.bold('Exemplos')}`);
  console.log();
  console.log(`  ${g('$')} ${c('makestudio login')} ${v('-e')} admin@empresa.com`);
  console.log(`  ${g('$')} ${c('makestudio new')}                              ${g('# entrevista → spec → DUMs → pipeline (CLI-first)')}`);
  console.log(`  ${g('$')} ${c('makestudio new')} ${v('--auto-execute')}              ${g('# entrevista e já começa a executar')}`);
  console.log(`  ${g('$')} ${c('makestudio new')} ${v('--spec')} spec.md ${v('-n')} ${w('"ACME CRM"')}  ${g('# pula entrevista, usa spec pronta')}`);
  console.log(`  ${g('$')} ${c('makestudio init')}                         ${g('# boilerplate → projeto real')}`);
  console.log(`  ${g('$')} ${c('makestudio init')} ${v('--cli')} claude              ${g('# com adaptação de IA')}`);
  console.log(`  ${g('$')} ${c('makestudio refine')}                          ${g('# corrigir projeto com spec/reqs fracos')}`);
  console.log(`  ${g('$')} ${c('makestudio refine')} ${v('--project-id')} abc123 ${v('--no-decompose')}`);
  console.log(`  ${g('$')} ${c('makestudio analyze')} ${v('--deep')}`);
  console.log(`  ${g('$')} ${c('makestudio analyze')} ${v('--audit')} ${v('--project-id')} abc123`);
  console.log(`  ${g('$')} ${c('makestudio plan')} ${w('"Adicionar campo telefone no cadastro"')}`);
  console.log(`  ${g('$')} ${c('makestudio start')} ${v('--cli')} claude`);
  console.log(`  ${g('$')} ${c('makestudio tasks')} ${v('-s')} pending`);
  console.log(`  ${g('$')} ${c('makestudio hours log')} task-123 2.5 ${v('-d')} ${w('"Implementação do módulo"')}`);
  console.log(`  ${g('$')} ${c('makestudio plugin install')} @makestudio/plugin-eslint`);
  console.log(`  ${g('$')} ${c('makestudio plugin install')} ./my-local-plugin`);
  console.log(`  ${g('$')} ${c('makestudio plugin list')}`);
  console.log();

  // REPL + Headless (one-shot)
  console.log();
  console.log(`  ${chalk.hex('#E2E8F0').bold.underline('REPL interativo + modo one-shot')}`);
  console.log();
  console.log(`  ${c('makestudio')}                                ${g('# abre REPL interativo (TUI)')}`);
  console.log(`  ${c('makestudio')} ${v('-c')}                             ${g('# retoma sessão mais recente')}`);
  console.log(`  ${c('makestudio')} ${v('--resume')} <uuid>                ${g('# retoma sessão específica')}`);
  console.log();
  console.log(`  ${c('makestudio')} ${v('-p')} ${w('"resuma o README.md"')}        ${g('# ONE-SHOT: roda, imprime resposta, sai')}`);
  console.log(`  ${c('makestudio')} ${v('--print')} ${w('"faça tal coisa"')}        ${g('# long form, mesmo comportamento')}`);
  console.log(`  ${c('makestudio')} ${v('-p')} ${w('"rm tmp"')} ${v('--yes')}                ${g('# --yes: bypass permission prompts (CUIDADO)')}`);
  console.log(`  ${c('makestudio')} ${v('-p')} ${w('"..."')} ${v('--json')}                  ${g('# JSON stream (uma linha/msg em stderr)')}`);
  console.log(`  ${c('makestudio')} ${v('-p')} ${w('"..."')} ${v('-q')}                      ${g('# quiet: só a resposta final em stdout')}`);
  console.log(`  ${c('makestudio')} ${v('-p')} ${w('"continue o trabalho"')} ${v('-c')}      ${g('# retoma sessão + novo prompt (headless)')}`);
  console.log();
  console.log(`  ${dim('Pipe-friendly:')}`);
  console.log(`  ${g('$')} ${c('makestudio')} ${v('-p')} ${w('"summary of src/main.ts"')} ${v('-q')} ${g('| pbcopy')}`);
  console.log(`  ${g('$')} ${c('X=$(makestudio')} ${v('-p')} ${w('"list failing tests"')} ${v('-q')}${c(')')}`);
  console.log();
  console.log(`  ${dim('Exit codes:')} ${g('0')}=ok  ${g('1')}=auth  ${g('2')}=empty prompt  ${g('3')}=ctx full  ${g('4')}=tool breaker  ${g('5')}=provider error`);
  console.log();
}

program.addHelpText('after', () => { showDetailedHelp(); return ''; });

// ── Plugin system: load plugins and register dynamic commands ────

// Suppress plugin startup logs for display-only commands (kanban, plugin list, etc.)
const QUIET_COMMANDS = ['kanban', 'dashboard'];
const firstArg = process.argv[2];
if (firstArg && QUIET_COMMANDS.includes(firstArg)) {
  const { setQuiet } = require('./ui/terminal');
  setQuiet(true);
}

(async () => {
  let loadedPlugins = 0;
  try {
    // Silence all plugin startup logs — show only summary after logo
    const { setQuiet } = require('./ui/terminal');
    setQuiet(true);
    loadedPlugins = await loadAllPlugins();
    setQuiet(false);

    // Register commands contributed by plugins
    if (loadedPlugins > 0) {
      for (const cmd of pluginRegistry.getCommands()) {
        const sub = program.command(cmd.name).description(`[plugin] ${cmd.description}`);
        if (cmd.options) {
          for (const opt of cmd.options) {
            sub.option(opt.flags, opt.description, opt.defaultValue);
          }
        }
        sub.action(cmd.handler);
      }
    }
  } catch {
    // Plugin loading failure is non-fatal — agent works without plugins
  }

  // Parse REPL-only flags (-c / --continue / --resume) which keep the user
  // in the interactive REPL instead of dispatching to a subcommand.
  //
  // All three accept an optional session id:
  //   makestudio                     → fresh REPL
  //   makestudio -c                  → resume most recent (no id)
  //   makestudio --continue          → same as -c
  //   makestudio --continue <uuid>   → resume that specific session
  //   makestudio --resume <uuid>     → canonical form; same semantic
  //   makestudio --resume            → alone = same as -c (most recent)
  //
  // Older goodbye messages printed `--continue <uuid>`; parser accepts
  // both --continue and --resume with optional id so those copies don't
  // die with "unknown option".
  const argv = process.argv.slice(2);
  const replFlags = new Set([
    '-c', '--continue', '--resume',
    '--debug', '-v', '--verbose',
    '--yes', '--dangerously-skip-permissions',
    '--coordinator', '--monitor', '--worker', '--session',
    '--teleport',
  ]);

  // ── Headless one-shot mode (port of Claude Code's `claude -p "<prompt>"`) ─
  //
  //   makestudio -p "summary of README.md"        → one-shot; runs + exits
  //   makestudio --print "..."                    → long form
  //   makestudio -p "..." --yes                   → skip permission prompts
  //   makestudio -p "..." --json                  → JSON-stream (one msg per line)
  //   makestudio -p "..." -q                      → quiet: only final answer in stdout
  //   makestudio -p "..." -c                      → resume most-recent session first
  //   makestudio -p "..." --resume <uuid>         → resume specific session
  //
  // Explicit flag only. Implicit `makestudio "text"` was rejected — too
  // easy to collide with subcommand dispatch ("plan", "start" etc. are
  // valid subcommands but also plausible prompt openings).
  const HEADLESS_FLAGS = new Set(['-p', '--print']);
  const headlessIdx = argv.findIndex((a) => HEADLESS_FLAGS.has(a));
  if (headlessIdx >= 0) {
    const yes = argv.includes('--yes') || argv.includes('--dangerously-skip-permissions');
    const quiet = argv.includes('-q') || argv.includes('--quiet');
    const format = (argv.includes('--json') || argv.includes('--jsonl')) ? 'json' : 'text';
    // --max-turns N caps the tool-loop. Used by DarkFactory executor when
    // spawning `makestudio -p --yes --json --max-turns N` as the `--cli makestudio`
    // strategy (self-hosting). Silently dropped when absent (unlimited up
    // to internal MAX_TOOL_LOOPS=200).
    const maxTurnsIdx = argv.findIndex((a) => a === '--max-turns');
    const maxTurns = maxTurnsIdx >= 0 && argv[maxTurnsIdx + 1]
      ? parseInt(argv[maxTurnsIdx + 1], 10)
      : undefined;
    // Resume / continue passthrough
    let continueSession = false;
    let resumeSessionId: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-c' || a === '--continue' || a === '--resume') {
        const next = argv[i + 1];
        if (next && !next.startsWith('-') && !HEADLESS_FLAGS.has(next)) {
          resumeSessionId = next; i++;
        } else continueSession = true;
      }
    }
    // Parse prompt: collect any non-flag positional tokens from argv,
    // consuming known value-taking flags so their arguments aren't mistaken
    // for prompt tokens. Lets the user order flags freely:
    //   makestudio -p --yes --max-turns 3 "faça X"
    //   makestudio --yes -p "faça X" --max-turns 3
    //   makestudio -p faça X agora --yes
    // All produce prompt="faça X [agora]" + the right flag set.
    const VALUE_FLAGS = new Set(['--max-turns', '--resume']);
    const BOOL_FLAGS = new Set([
      '-p', '--print', '--yes', '--dangerously-skip-permissions',
      '-q', '--quiet', '--json', '--jsonl', '-c', '--continue',
    ]);
    const promptTokens: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const tok = argv[i];
      if (BOOL_FLAGS.has(tok)) continue;
      if (VALUE_FLAGS.has(tok)) { i++; continue; } // consume value
      if (tok.startsWith('-')) continue;           // unknown flag — ignore
      promptTokens.push(tok);
    }
    const prompt = promptTokens.join(' ');

    const { runHeadless } = require('./repl/headless');
    runHeadless({
      prompt,
      yes,
      quiet,
      format,
      resumeSessionId,
      continueSession,
      maxTurns,
    })
      .then((code: number) => process.exit(code))
      .catch((err: any) => {
        process.stderr.write(`[fatal] headless run threw: ${err.message || err}\n`);
        process.exit(5);
      });
    return;
  }

  // ── Headless worker mode (--worker <id> --session <sessionId>) ──────────
  //
  // Spawned by coordinator-runtime.ts spawnSubprocess() as:
  //   node <entrypoint> --worker <workerId> --session <coordinatorSessionId>
  //
  // When these flags are present we bypass ALL REPL startup — no welcome
  // screen, no TUI, no readline — and run the JSON-lines protocol instead.
  const workerIdx = argv.indexOf('--worker');
  const sessionFlagIdx = argv.indexOf('--session');
  if (workerIdx >= 0) {
    const workerId = argv[workerIdx + 1];
    const sessionId = sessionFlagIdx >= 0 ? argv[sessionFlagIdx + 1] : '';
    if (workerId && !workerId.startsWith('-')) {
      if (!sessionId) {
        process.stderr.write('[worker] --session <session-id> is required with --worker\n');
        process.exit(1);
      }
      const { runHeadlessWorker } = require('./repl/headless-worker');
      runHeadlessWorker(workerId, sessionId).catch((err: any) => {
        process.stderr.write(`[fatal] headless-worker threw: ${err.message || err}\n`);
        process.exit(1);
      });
      return; // do not fall through to REPL or commander
    }
  }

  // ── Coordinator CLI flags (--coordinator / --monitor) ────────────────────
  //
  //   makestudio --coordinator "analyse auth flow"
  //     → starts REPL with coordinator mode pre-activated and initial prompt
  //   makestudio --coordinator "..." --monitor dashboard
  //     → same, with dashboard monitoring mode
  //   makestudio --monitor linear   (alone — ignored; only meaningful with --coordinator)
  const coordinatorIdx = argv.indexOf('--coordinator');
  const monitorIdx = argv.indexOf('--monitor');
  let coordinatorTask: string | undefined;
  let coordinatorMonitorFlag: 'linear' | 'dashboard' | 'silent' = 'linear';
  if (coordinatorIdx >= 0) {
    const nextArg = argv[coordinatorIdx + 1];
    if (nextArg && !nextArg.startsWith('-')) {
      coordinatorTask = nextArg;
    } else {
      console.warn('[coordinator] --coordinator flag requires a task argument. Example: --coordinator "refactor auth module"');
    }
  }
  if (monitorIdx >= 0) {
    const monitorVal = argv[monitorIdx + 1];
    if (monitorVal === 'dashboard' || monitorVal === 'linear' || monitorVal === 'silent') {
      coordinatorMonitorFlag = monitorVal;
    } else {
      console.warn(`[coordinator] Invalid --monitor value: "${monitorVal}". Valid: dashboard, linear, silent. Using "linear".`);
    }
  }

  const isReplLaunch =
    argv.length === 0 ||
    argv.every((a, i) => {
      if (replFlags.has(a)) return true;
      // Allow --coordinator and its value, --monitor and its value
      if (a === '--coordinator' || a === '--monitor') return true;
      const prev = i > 0 ? argv[i - 1] : undefined;
      if (prev && (replFlags.has(prev) || prev === '--coordinator' || prev === '--monitor')) return true;   // value slot
      return false;
    });

  if (isReplLaunch) {
    let continueSession = false;
    let teleportCode: string | undefined;
    let resumeSessionId: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-c' || a === '--continue' || a === '--resume') {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) { resumeSessionId = next; i++; }
        else continueSession = true;        // alone → resume most recent
      }
      if (a === '--teleport') {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) { teleportCode = next; i++; }
      }
    }

    // --verbose / -v flag: activate verbose mode for this session
    if (argv.includes('--verbose') || argv.includes('-v')) {
      try { require('./repl/settings').saveSettings({ verbose: true }); } catch (err) { swallow(err); }
    }

    // --debug flag or DEBUG=1 env: activate session audit log
    if (argv.includes('--debug') || process.env.DEBUG === '1') {
      try { require('./repl/debug-log').initDebugLog(true); } catch (err) { swallow(err); }
    } else {
      try { require('./repl/debug-log').initDebugLog(); } catch (err) { swallow(err); }
    }

    const autoApprove = argv.includes('--yes') || argv.includes('--dangerously-skip-permissions');
    const hasTty = process.stdin.isTTY && process.stdout.isTTY;
    // MAKESTUDIO_PTY=1 forces TUI mode when spawned via node-pty inside Electron:
    // ELECTRON_RUN_AS_NODE=1 prevents isTTY from being reported correctly even
    // though the process IS connected to a real PTY via node-pty.
    const forcePty = process.env.MAKESTUDIO_PTY === '1';
    const useTui = !process.env.MAKESTUDIO_PLAIN && (hasTty || forcePty);
    const { startRepl } = useTui ? require('./repl/tui-index') : require('./repl');

    // If --coordinator was provided, seed the coordinator options so startRepl
    // can activate coordinator mode before the first AI turn.
    const replOpts: any = { continueSession, resumeSessionId, autoApprove, teleportCode };
    if (coordinatorTask !== undefined) {
      replOpts.coordinatorTask = coordinatorTask;
      replOpts.coordinatorMonitor = coordinatorMonitorFlag;
    }

    startRepl(replOpts).catch((err: any) => {
      console.error(`Erro ao iniciar REPL: ${err.message || err}`);
      process.exit(1);
    });
  } else {
    program.parse(process.argv);
  }
})();
