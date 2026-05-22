import chalk from 'chalk';

const cyan = chalk.hex('#22D3EE');
const dim = chalk.hex('#64748B');
const white = chalk.white;
const bold = chalk.bold;

export interface SlashSubcommand {
  name: string;
  description: string;
  usage?: string;
}

export interface SlashFlag {
  name: string;
  description: string;
}

export interface SlashCommandHelp {
  description: string;
  usage?: string;
  aliases?: string[];
  subcommands?: SlashSubcommand[];
  flags?: SlashFlag[];
  examples?: string[];
  notes?: string;
}

/**
 * Registry of help metadata for built-in slash commands.
 *
 * Keys are the canonical command name WITHOUT the leading slash. Aliases point
 * to the same entry via the `aliases` field on the canonical entry and via
 * duplicate keys in ALIAS_MAP below.
 *
 * New commands added to router.ts SHOULD add a matching entry here so that
 * `/<cmd> --help` shows useful guidance. If no entry exists, the generic
 * fallback renderer still prints a minimal "no help available" message.
 */
export const COMMAND_HELP: Record<string, SlashCommandHelp> = {
  // ── Core ─────────────────────────────────────────────────────────────
  help: {
    description: 'Mostra o índice geral de comandos.',
    usage: '/help',
    aliases: ['/h'],
    examples: ['/help', '/cluster --help'],
    notes: 'Para ajuda detalhada de um comando específico, use /<cmd> --help.',
  },
  quit: {
    description: 'Sai do MakeStudio.',
    usage: '/quit',
    aliases: ['/exit', '/q'],
  },
  clear: {
    description: 'Limpa o histórico da conversa atual.',
    usage: '/clear',
  },
  version: {
    description: 'Mostra a versão do agente.',
    usage: '/version',
  },
  restart: {
    description: 'Reinicia o REPL preservando a sessão.',
    usage: '/restart',
  },

  // ── Sessão ───────────────────────────────────────────────────────────
  save: {
    description: 'Snapshot da sessão atual.',
    usage: '/save [nome]',
    examples: ['/save', '/save antes-do-refactor'],
  },
  load: {
    description: 'Restaura um snapshot de sessão (lista se sem nome).',
    usage: '/load [nome]',
  },
  sessions: {
    description: 'Lista sessões salvas e permite continuar uma anterior.',
    usage: '/sessions',
    aliases: ['/continue'],
  },
  continue: {
    description: 'Continua a última sessão.',
    usage: '/continue',
    aliases: ['/sessions'],
  },
  fork: {
    description: 'Bifurca a conversa atual em nova sessão (mantém a original intacta).',
    usage: '/fork [título]',
  },
  resume: {
    description: 'Retoma execução automatizada de onde parou.',
    usage: '/resume',
  },
  tag: {
    description: 'Marca ou desmarca a sessão atual com uma tag.',
    usage: '/tag [nome]',
  },
  history: {
    description: 'Histórico de execuções do projeto.',
    usage: '/history [--status <x>] [--limit <n>]',
  },
  'history-file': {
    description: 'Mostra o caminho do arquivo de histórico.',
    usage: '/history-file',
  },
  undo: {
    description: 'Desfaz a última interação com a IA.',
    usage: '/undo',
  },
  'undo-file': {
    description: 'Desfaz a última edição feita pela IA em arquivos.',
    usage: '/undo-file',
  },
  rewind: {
    description: 'Reverte DUMs de um ponto em diante para pending.',
    usage: '/rewind <DUM-NNN>',
    examples: ['/rewind DUM-005'],
  },
  compact: {
    description: 'Comprime o histórico da conversa para liberar context.',
    usage: '/compact',
    aliases: ['/summarize'],
  },
  summarize: {
    description: 'Comprime o histórico da conversa para liberar context.',
    usage: '/summarize',
    aliases: ['/compact'],
  },
  uncompact: {
    description: 'Desfaz a última compactação.',
    usage: '/uncompact',
    aliases: ['/undo-compact'],
  },
  'undo-compact': {
    description: 'Desfaz a última compactação.',
    usage: '/undo-compact',
    aliases: ['/uncompact'],
  },
  summary: {
    description: 'Gera um resumo da sessão atual.',
    usage: '/summary',
  },

  // ── Projeto ──────────────────────────────────────────────────────────
  projects: {
    description: 'Lista projetos disponíveis no servidor.',
    usage: '/projects',
  },
  project: {
    description: 'Seleciona o projeto ativo.',
    usage: '/project <id|número>',
    examples: ['/project 3', '/project abc12345'],
  },
  status: {
    description: 'Status do servidor, do projeto ativo e dos agents.',
    usage: '/status',
  },
  tasks: {
    description: 'Lista tasks do projeto ativo.',
    usage: '/tasks [--status <pending|running|done|failed>]',
  },
  'add-dir': {
    description: 'Adiciona um diretório extra ao contexto da sessão.',
    usage: '/add-dir <path>',
  },

  // ── IA / Modelo ──────────────────────────────────────────────────────
  ai: {
    description: 'Troca o provider de IA.',
    usage: '/ai <provider>',
    subcommands: [
      { name: 'claude', description: 'Usar Claude Code como executor.' },
      { name: 'codex', description: 'Usar Codex como executor.' },
      { name: 'gemini', description: 'Usar Gemini como executor.' },
    ],
    examples: ['/ai claude', '/ai codex'],
  },
  model: {
    description: 'Visualiza ou atualiza o catálogo de modelos.',
    usage: '/model [tier]',
    subcommands: [
      { name: 'fast', description: 'Selecionar tier rápido.' },
      { name: 'default', description: 'Selecionar tier padrão.' },
      { name: 'image', description: 'Selecionar tier de imagem.' },
    ],
  },
  fast: {
    description: 'Alterna para o modo rápido (modelo menor, menor latência).',
    usage: '/fast [on|off]',
  },
  effort: {
    description: 'Define nível de esforço do modelo.',
    usage: '/effort <low|medium|high|max>',
    examples: ['/effort high'],
  },
  verbose: {
    description: 'Alterna modo verboso (mostra detalhes de tool calls).',
    usage: '/verbose [on|off]',
  },
  retry: {
    description: 'Regenera a última resposta da IA.',
    usage: '/retry',
    aliases: ['/regenerate'],
  },
  regenerate: {
    description: 'Regenera a última resposta da IA.',
    usage: '/regenerate',
    aliases: ['/retry'],
  },
  edit: {
    description: 'Edita a última mensagem do usuário e refaz o retry.',
    usage: '/edit <novo texto>',
  },
  refine: {
    description: 'Refina spec e DUMs do projeto ativo.',
    usage: '/refine [flags]',
  },
  plan: {
    description: 'Entra em plan mode (bloqueia Write/Edit/Bash até aprovar o plano).',
    usage: '/plan [hint]',
  },
  debug: {
    description: 'Mostra detalhes da última tool call.',
    usage: '/debug',
  },
  cost: {
    description: 'Tokens consumidos e custo estimado na sessão.',
    usage: '/cost',
    aliases: ['/usage'],
  },
  usage: {
    description: 'Tokens consumidos e custo estimado na sessão.',
    usage: '/usage',
    aliases: ['/cost'],
  },
  ctx: {
    description: 'Uso atual do context window.',
    usage: '/ctx',
    aliases: ['/context'],
  },
  context: {
    description: 'Uso atual do context window.',
    usage: '/context',
    aliases: ['/ctx'],
  },

  // ── Automação ────────────────────────────────────────────────────────
  execute: {
    description: 'Executa projeto seguindo topological sort das DUMs.',
    usage: '/execute [flags]',
  },
  doctor: {
    description: 'Smoke test das stacks configuradas.',
    usage: '/doctor [flags]',
  },
  analyze: {
    description: 'Analisa o codebase do projeto.',
    usage: '/analyze [flags]',
  },
  verify: {
    description: 'Valida o estado do projeto contra o plan.',
    usage: '/verify',
  },
  init: {
    description: 'Inicializa um projeto a partir de boilerplate.',
    usage: '/init [flags]',
  },
  start: {
    description: 'Conecta este agent a um projeto remoto.',
    usage: '/start [--repo <path>] [--cli <claude|codex|gemini>]',
  },
  stats: {
    description: 'Estatísticas agregadas da sessão.',
    usage: '/stats',
  },

  // ── Git / PR ─────────────────────────────────────────────────────────
  diff: {
    description: 'Mostra git diff do projeto ativo.',
    usage: '/diff',
  },
  branch: {
    description: 'Lista branches do repositório.',
    usage: '/branch',
  },
  commit: {
    description: 'Cria um commit (IA gera mensagem se nenhuma for passada).',
    usage: '/commit [mensagem]',
  },
  'commit-push-pr': {
    description: 'Commit + push + cria PR via gh.',
    usage: '/commit-push-pr',
    aliases: ['/cpp'],
  },
  cpp: {
    description: 'Atalho para /commit-push-pr.',
    usage: '/cpp',
    aliases: ['/commit-push-pr'],
  },
  pr: {
    description: 'Operações de PR no GitHub.',
    usage: '/pr [subcomando]',
    notes: 'Requer gh CLI autenticado.',
  },
  'pr-comments': {
    description: 'Lê comentários do PR atual.',
    usage: '/pr-comments',
  },
  'autofix-pr': {
    description: 'Tenta corrigir automaticamente falhas de CI do PR.',
    usage: '/autofix-pr',
  },
  issue: {
    description: 'Trabalha com issues do GitHub.',
    usage: '/issue [subcomando]',
  },
  'release-notes': {
    description: 'Gera release notes a partir do histórico.',
    usage: '/release-notes [--from <tag>] [--to <tag>]',
  },
  review: {
    description: 'Revisão multi-agente do branch atual ou PR.',
    usage: '/review [<PR#>]',
  },
  'security-review': {
    description: 'Revisão de segurança das mudanças pendentes.',
    usage: '/security-review',
    aliases: ['/secreview'],
  },
  secreview: {
    description: 'Atalho para /security-review.',
    usage: '/secreview',
    aliases: ['/security-review'],
  },

  // ── Cluster ──────────────────────────────────────────────────────────
  cluster: {
    description: 'Mesh entre agents makestudio na rede local (identidade Ed25519).',
    usage: '/cluster [subcomando]',
    subcommands: [
      { name: 'list', description: 'Lista peers descobertos (default).', usage: '/cluster list' },
      { name: 'enable', description: 'Inicia discovery e advertising.', usage: '/cluster enable' },
      { name: 'disable', description: 'Para discovery.', usage: '/cluster disable' },
      { name: 'info', description: 'Mostra configuração local (peerId, portas).', usage: '/cluster info' },
      {
        name: 'trust',
        description: 'Gerencia permissões por peer (bash/write), opcionalmente com escopo por path.',
        usage: '/cluster trust [<peer-id> [--scope <path>] --allow-bash|--deny-bash|--allow-write|--deny-write|--revoke]',
      },
    ],
    flags: [
      { name: '--scope <path>', description: 'Aplica a permissão apenas quando o cwd estiver dentro desse path.' },
      { name: '--allow-bash', description: 'Concede execução de bash ao peer.' },
      { name: '--deny-bash', description: 'Revoga execução de bash.' },
      { name: '--allow-write', description: 'Concede permissão de escrita.' },
      { name: '--deny-write', description: 'Revoga permissão de escrita.' },
      { name: '--revoke', description: 'Remove permissões (do escopo, ou globais se sem --scope).' },
    ],
    examples: [
      '/cluster enable',
      '/cluster list',
      '/cluster trust m-5fe4e83f2d --allow-bash  (global)',
      '/cluster trust m-5fe4e83f2d --scope /home/me/develop/myrepo --allow-bash --allow-write',
      '/cluster trust m-5fe4e83f2d --scope /home/me/develop/myrepo --revoke',
    ],
  },

  // ── Skills / Plugins / Schedule ──────────────────────────────────────
  skills: {
    description: 'Lista skills instaladas.',
    usage: '/skills',
    notes: 'Execute uma skill com /<nome> ou /<nome> arg1 arg2.',
  },
  plugin: {
    description: 'Gerencia plugins.',
    usage: '/plugin <subcomando> [nome]',
    aliases: ['/plugins'],
    subcommands: [
      { name: 'list', description: 'Lista plugins instalados.' },
      { name: 'install', description: 'Instala plugin de npm, local ou git.', usage: '/plugin install <source>' },
      { name: 'remove', description: 'Remove plugin.', usage: '/plugin remove <nome>' },
      { name: 'enable', description: 'Habilita plugin.', usage: '/plugin enable <nome>' },
      { name: 'disable', description: 'Desabilita plugin.', usage: '/plugin disable <nome>' },
    ],
  },
  plugins: {
    description: 'Gerencia plugins (alias de /plugin).',
    usage: '/plugins <subcomando> [nome]',
    aliases: ['/plugin'],
  },
  'reload-plugins': {
    description: 'Recarrega plugins sem reiniciar o REPL.',
    usage: '/reload-plugins',
  },
  schedule: {
    description: 'Agendamentos cron de comandos do makestudio.',
    usage: '/schedule <subcomando>',
    subcommands: [
      { name: 'list', description: 'Lista agendamentos (default).' },
      { name: 'add', description: 'Cria agendamento.', usage: '/schedule add <nome> "<cron>" <comando>' },
      { name: 'remove', description: 'Remove agendamento.', usage: '/schedule remove <nome>' },
      { name: 'enable', description: 'Habilita agendamento.', usage: '/schedule enable <nome>' },
      { name: 'disable', description: 'Desabilita agendamento.', usage: '/schedule disable <nome>' },
      { name: 'next', description: 'Calcula próxima execução para uma expressão cron.', usage: '/schedule next "<cron>"' },
      { name: 'daemon', description: 'Gerencia o daemon (install/uninstall/status).', usage: '/schedule daemon <install|uninstall|status>' },
    ],
    examples: [
      '/schedule add nightly-audit "0 2 * * *" /analyze --audit',
      '/schedule next "0 9 * * 1-5"',
      '/schedule daemon install',
    ],
  },

  // ── Memória / Hooks / MCP ────────────────────────────────────────────
  memory: {
    description: 'Memória persistente entre sessões (com CRDT sync entre peers).',
    usage: '/memory <subcomando>',
    aliases: ['/mem'],
    subcommands: [
      { name: 'list', description: 'Lista tópicos (default).' },
      { name: 'save', description: 'Salva novo tópico.', usage: '/memory save <nome> <corpo>' },
      { name: 'delete', description: 'Remove tópico (tombstone propaga via sync).', usage: '/memory delete <nome>' },
      { name: 'rebuild', description: 'Regenera o index semântico.' },
      { name: 'prune', description: 'Remove tópicos stale (>180d sem acesso).' },
      { name: 'similar', description: 'Detecta tópicos similares para possível merge.' },
      { name: 'sync', description: 'Puxa memory de um peer do cluster (merge LWW + vclock).', usage: '/memory sync <peer-id>' },
      { name: 'conflicts', description: 'Lista conflitos de sync concorrentes pendentes de resolução.' },
    ],
    examples: [
      '/memory save arquitetura-auth JWT via Passport, sessão em Redis',
      '/memory sync m-5fe4e83f2d',
      '/memory conflicts',
    ],
  },
  mem: {
    description: 'Memória persistente (alias de /memory).',
    usage: '/mem <subcomando>',
    aliases: ['/memory'],
  },
  hooks: {
    description: 'Lista hooks configurados. `/hooks status` mostra async hooks em execução.',
    usage: '/hooks [status]',
  },
  'quality-hold': {
    description:
      'Lista tasks bloqueadas pelo quality gate (ISO/IEC/IEEE 29148:2018) e permite reanalisar/editar.',
    usage: '/quality-hold [list|summary|reanalyze <taskId>|edit <taskId>]',
    aliases: ['/qhold', '/qh'],
  },
  qhold: {
    description: 'Alias de /quality-hold.',
    usage: '/qhold [subcomando]',
    aliases: ['/quality-hold'],
  },
  qh: {
    description: 'Alias curto de /quality-hold.',
    usage: '/qh [subcomando]',
    aliases: ['/quality-hold'],
  },
  mcp: {
    description: 'Gerencia servidores MCP.',
    usage: '/mcp [subcomando]',
  },

  // ── Permissões / Sandbox / Trust ─────────────────────────────────────
  permissions: {
    description: 'Gerencia regras de permissão do agent.',
    usage: '/permissions [subcomando]',
    aliases: ['/perms'],
  },
  perms: {
    description: 'Gerencia regras de permissão do agent.',
    usage: '/perms [subcomando]',
    aliases: ['/permissions'],
  },
  'permission-mode': {
    description: 'Alterna modo de permissão (ask/allow/deny).',
    usage: '/permission-mode [modo]',
    aliases: ['/pmode'],
  },
  pmode: {
    description: 'Alterna modo de permissão.',
    usage: '/pmode [modo]',
    aliases: ['/permission-mode'],
  },
  sandbox: {
    description: 'Controla o sandbox de execução de comandos.',
    usage: '/sandbox [on|off|status]',
  },
  trust: {
    description: 'Modo confiável (skip de aprovações).',
    usage: '/trust [on|off]',
  },

  // ── Agents / Coordinator ─────────────────────────────────────────────
  agents: {
    description: 'Lista subagentes disponíveis.',
    usage: '/agents',
  },
  agent: {
    description: 'Invoca um subagente ou gerencia configuração.',
    usage: '/agent [subcomando]',
  },
  coordinator: {
    description: 'Ativa ou controla o coordinator (orquestra vários agents).',
    usage: '/coordinator [subcomando]',
  },

  // ── UI / Output ──────────────────────────────────────────────────────
  theme: {
    description: 'Troca o tema de cores do TUI.',
    usage: '/theme [nome]',
  },
  vim: {
    description: 'Alterna modo vim no input.',
    usage: '/vim [on|off]',
  },
  'output-style': {
    description: 'Troca o estilo de saída.',
    usage: '/output-style [nome]',
    aliases: ['/ostyle'],
  },
  ostyle: {
    description: 'Atalho para /output-style.',
    usage: '/ostyle [nome]',
    aliases: ['/output-style'],
  },
  keybindings: {
    description: 'Mostra/edita atalhos de teclado.',
    usage: '/keybindings',
    aliases: ['/keys', '/shortcuts'],
  },
  keys: {
    description: 'Mostra atalhos de teclado.',
    usage: '/keys',
    aliases: ['/keybindings', '/shortcuts'],
  },
  shortcuts: {
    description: 'Mostra atalhos de teclado.',
    usage: '/shortcuts',
    aliases: ['/keybindings', '/keys'],
  },
  statusline: {
    description: 'Configura a statusline do TUI.',
    usage: '/statusline [config]',
  },
  copy: {
    description: 'Copia última resposta para o clipboard.',
    usage: '/copy',
  },
  export: {
    description: 'Exporta a sessão atual para arquivo.',
    usage: '/export [--format md|json] [--out <path>]',
  },
  'export-svg': {
    description: 'Exporta artefatos gerados em SVG.',
    usage: '/export-svg [--out <path>]',
  },
  paste: {
    description: 'Cola conteúdo do clipboard como mensagem.',
    usage: '/paste',
    aliases: ['/paste-image'],
  },
  'paste-image': {
    description: 'Cola imagem do clipboard como anexo.',
    usage: '/paste-image',
    aliases: ['/paste'],
  },
  rename: {
    description: 'Renomeia a sessão atual.',
    usage: '/rename <novo-nome>',
  },
  search: {
    description: 'Busca no histórico de conversas.',
    usage: '/search <query>',
  },

  // ── Diagnóstico / Infra ──────────────────────────────────────────────
  login: {
    description: 'Autentica no servidor do MakeStudio.',
    usage: '/login',
  },
  logout: {
    description: 'Desconecta do servidor.',
    usage: '/logout',
  },
  env: {
    description: 'Mostra variáveis de ambiente relevantes.',
    usage: '/env',
  },
  feedback: {
    description: 'Envia feedback ao time do MakeStudio.',
    usage: '/feedback <texto>',
  },
  upgrade: {
    description: 'Atualiza o agente para a última versão publicada.',
    usage: '/upgrade',
  },
  health: {
    description: 'Verifica CLIs e configuração do ambiente.',
    usage: '/health',
  },
  record: {
    description: 'Grava uma cassette da sessão para replay.',
    usage: '/record [--out <nome>]',
  },
  replay: {
    description: 'Replay de uma cassette gravada.',
    usage: '/replay <cassette>',
  },
  cassettes: {
    description: 'Lista cassettes gravadas.',
    usage: '/cassettes',
  },

  // ── Outros ───────────────────────────────────────────────────────────
  boilerplate: {
    description: 'Lista boilerplates registrados.',
    usage: '/boilerplate',
    aliases: ['/bp'],
  },
  bp: {
    description: 'Atalho para /boilerplate.',
    usage: '/bp',
    aliases: ['/boilerplate'],
  },
  kanban: {
    description: 'Abre um kanban board no terminal.',
    usage: '/kanban',
  },
};

const ALIAS_MAP = new Map<string, string>();
for (const [canonical, help] of Object.entries(COMMAND_HELP)) {
  if (help.aliases) {
    for (const alias of help.aliases) {
      ALIAS_MAP.set(alias.replace(/^\//, '').toLowerCase(), canonical);
    }
  }
}

/**
 * Detects `--help` / `-h` anywhere in the rest-args. Placed early so a user
 * typing `/cluster trust --help` gets help for /cluster instead of
 * executing the trust subcommand.
 */
export function isHelpRequested(rest: string[]): boolean {
  return rest.some((a) => a === '--help' || a === '-h');
}

function resolveHelp(bareName: string): { key: string; help: SlashCommandHelp } | null {
  const lower = bareName.toLowerCase();
  if (COMMAND_HELP[lower]) return { key: lower, help: COMMAND_HELP[lower] };
  const aliased = ALIAS_MAP.get(lower);
  if (aliased && COMMAND_HELP[aliased]) return { key: aliased, help: COMMAND_HELP[aliased] };
  return null;
}

// ── Rendering helpers ─────────────────────────────────────────────────
//
// All helpers append to a string[] buffer so the whole help card is emitted
// as ONE console.log call. The TUI bridge intercepts every console.log as a
// separate chat message and inserts vertical padding between them — so 30
// log calls became 30 padded blocks. A single multi-line log = one block.

function pushHeader(buf: string[], name: string, description: string): void {
  buf.push(`  ${cyan.bold('/' + name)}  ${dim('—')} ${description}`);
}

function pushSection(buf: string[], title: string): void {
  buf.push(`  ${white.bold(title)}`);
}

function pushKV(buf: string[], key: string, value: string, keyWidth = 24): void {
  buf.push(`    ${cyan(key.padEnd(keyWidth))}${dim(value)}`);
}

function pushRaw(buf: string[], line: string): void {
  buf.push(`    ${dim(line)}`);
}

function buildBuiltinHelp(name: string, help: SlashCommandHelp): string[] {
  const buf: string[] = [];
  pushHeader(buf, name, help.description);

  if (help.usage) {
    pushSection(buf, 'Uso');
    pushRaw(buf, help.usage);
  }

  if (help.aliases && help.aliases.length > 0) {
    pushSection(buf, 'Aliases');
    pushRaw(buf, help.aliases.join(', '));
  }

  if (help.subcommands && help.subcommands.length > 0) {
    pushSection(buf, 'Subcomandos');
    const width = Math.max(...help.subcommands.map((s) => s.name.length)) + 2;
    for (const s of help.subcommands) {
      const desc = s.usage ? `${s.description}  ${dim('— ' + s.usage)}` : s.description;
      pushKV(buf, s.name, desc, width);
    }
  }

  if (help.flags && help.flags.length > 0) {
    pushSection(buf, 'Flags');
    const width = Math.max(...help.flags.map((f) => f.name.length)) + 2;
    for (const f of help.flags) {
      pushKV(buf, f.name, f.description, width);
    }
  }

  if (help.examples && help.examples.length > 0) {
    pushSection(buf, 'Exemplos');
    for (const ex of help.examples) {
      buf.push(`    ${cyan(ex)}`);
    }
  }

  if (help.notes) {
    pushSection(buf, 'Notas');
    pushRaw(buf, help.notes);
  }

  return buf;
}

function buildPluginHelp(bareName: string): string[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { listPluginSlashCommands } = require('./slash-utils');
    const plugins: Array<{ name: string; description: string; argumentHint?: string; help?: SlashCommandHelp }> =
      listPluginSlashCommands();
    const match = plugins.find((p) => p.name.toLowerCase() === bareName.toLowerCase());
    if (!match) return null;
    if (match.help) return buildBuiltinHelp(match.name, match.help);

    const buf: string[] = [];
    pushHeader(buf, match.name, match.description);
    pushSection(buf, 'Uso');
    pushRaw(buf, `/${match.name}${match.argumentHint ? ' ' + match.argumentHint : ''}`);
    pushRaw(buf, '(comando de plugin — sem help detalhado registrado)');
    return buf;
  } catch {
    return null;
  }
}

function buildSkillHelp(bareName: string, cwd: string): string[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadAllSkills, findSkill } = require('./skills');
    const skills = loadAllSkills(cwd);
    const sk = findSkill(skills, bareName);
    if (!sk) return null;
    const buf: string[] = [];
    pushHeader(buf, sk.name, sk.description || '(skill)');
    pushSection(buf, 'Tipo');
    pushRaw(buf, `skill ${sk.source ? `[${sk.source}]` : ''}`);
    pushSection(buf, 'Uso');
    pushRaw(buf, `/${sk.name} [args]`);
    if (sk.userInvocable === false) {
      pushSection(buf, 'Notas');
      pushRaw(buf, 'Esta skill não é invocável diretamente pelo usuário (userInvocable: false).');
    }
    return buf;
  } catch {
    return null;
  }
}

/**
 * Entry point: renders help for a given command. Looks up built-in metadata
 * first, then plugin commands, then skills, then falls back to a generic
 * "no help available" message.
 *
 * The entire card is emitted as a single console.log — the TUI bridge
 * renders one log call as one message, which avoids the extra vertical
 * spacing the bridge inserts between separate messages.
 */
export function renderSlashHelp(bareName: string, cwd?: string): boolean {
  const resolved = resolveHelp(bareName);
  let buf: string[] | null = null;

  if (resolved) {
    buf = buildBuiltinHelp(resolved.key, resolved.help);
  } else {
    buf = buildPluginHelp(bareName);
    if (!buf && cwd) buf = buildSkillHelp(bareName, cwd);
  }

  if (!buf) {
    buf = [
      `  ${cyan.bold('/' + bareName)}`,
      `  ${dim('Nenhuma ajuda detalhada registrada para este comando.')}`,
      `  ${dim('Use')} ${cyan('/help')} ${dim('para ver o índice geral.')}`,
    ];
  }

  console.log(buf.join('\n'));
  return true;
}
