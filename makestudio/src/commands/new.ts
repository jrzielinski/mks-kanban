import { swallow } from '../utils/log';
/**
 * new.ts — `makestudio new` command.
 *
 * Wizard CLI-first project creation. Mirrors the aesthetic of `refine.ts`:
 *   - printBanner('New Project') at top
 *   - dim('│') left sidebar for every line
 *   - numbered step headers (1/8, 2/8, ...)
 *   - Esc Esc cancels and exits cleanly
 *   - raw-mode ask() so the wizard behaves like a real terminal wizard
 *
 * Pipeline phases:
 *   1/8  Interview         — 8-domain elicitation in business language.
 *                            Produces specMarkdown + inferredStack.
 *   2/8  Stack confirm     — show inferred stack; user accepts/edits.
 *   3/8  Boilerplate       — list tenant boilerplates; pick index or skip.
 *   4/8  Git repo          — new (owner+token), existing (url+branch), or skip.
 *   5/8  Summary           — final confirmation before hitting the backend.
 *   6/8  Create project    — POST /dark-factory/projects (full spec as briefing).
 *   7/8  Start analyst     — POST /start-analysis (generates requirements + DUMs).
 *   8/8  Generate pipeline — POST /generate-pipeline (topological order + design).
 *
 *   + optional: create GitHub repo, auto-execute.
 *
 * Zero server-side duplication — reuses the same endpoints the frontend hits.
 */

import chalk from 'chalk';
import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { printBanner } from '../utils/banner';
import { executeCommand } from './execute';

// ── Palette (matches refine.ts exactly) ────────────────────────────────────
const bold   = chalk.bold;
const dim    = chalk.hex('#64748B');
const cyan   = chalk.hex('#22D3EE');
const green  = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red    = chalk.hex('#EF4444');
const blue   = chalk.hex('#60A5FA');

/**
 * Thrown by ask() on Esc-Esc (double-escape) so the top-level command handler
 * can exit cleanly back to the REPL without killing makestudio.
 */
export class UserCancelled extends Error {
  constructor() { super('User cancelled (Esc Esc)'); this.name = 'UserCancelled'; }
}

/**
 * Raw-mode prompt. Mirrors refine.ts ask() byte-for-byte so the cancel UX
 * (Esc clears buffer, Esc-Esc cancels) is identical across wizards.
 */
function ask(question: string): Promise<string> {
  const stdin = process.stdin as any;
  const wasRaw = !!stdin.isRaw;
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  } catch (err) { swallow(err); }
  stdin.removeAllListeners('data');
  stdin.removeAllListeners('keypress');
  if (stdin.isPaused?.()) stdin.resume();

  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    let buf = '';
    let lastEscAt = 0;
    const restore = () => {
      try {
        if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
      } catch (err) { swallow(err); }
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\x1b') {
          const next = s[i + 1];
          if (next === '[' || next === 'O') {
            let j = i + 2;
            while (j < s.length && !/[@-~]/.test(s[j])) j++;
            i = j;
            continue;
          }
          const now = Date.now();
          if (now - lastEscAt < 600) {
            process.stdout.write('\n');
            restore();
            reject(new UserCancelled());
            return;
          }
          lastEscAt = now;
          if (buf.length > 0) {
            process.stdout.write('\r\x1b[K' + question);
            buf = '';
          }
          continue;
        }
        if (ch === '\n' || ch === '\r') {
          process.stdout.write('\n');
          restore();
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') { restore(); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        const code = ch.charCodeAt(0);
        if (code < 32) continue;
        buf += ch;
        process.stdout.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}

function spinner(text: string): () => void {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${dim('│')}  ${cyan(frames[i++ % frames.length])} ${dim(text)}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write('\r' + ' '.repeat(text.length + 10) + '\r');
  };
}

function header(step: string, title: string): void {
  console.log(dim('│'));
  console.log(`${dim('│')}  ${blue(step)} ${bold(title)}`);
  console.log(dim('│'));
}

// ── Types ──────────────────────────────────────────────────────────────────

interface InterviewMsg { role: 'user' | 'assistant'; content: string; }

interface StackSelection {
  backend?: string[];
  frontend?: string[];
  mobile?: string[];
  database?: string[];
  infra?: string[];
}

interface RepoSelection {
  mode: 'new' | 'existing' | 'skip';
  repoUrl?: string;
  repoBranch?: string;
  gitOwner?: string;
  gitName?: string;
  gitToken?: string;
  gitPrivate?: boolean;
}

export interface NewProjectOptions {
  specFile?: string;
  autoExecute?: boolean;
  onlyDecompose?: boolean;
  stack?: string;
  name?: string;
  apiConfigId?: string;
  nonInteractive?: boolean;
}

// ── Interview prompt (English for LLM efficiency — responses are per-user language) ──

const INTERVIEW_SYSTEM_PROMPT = `You are a senior software architect and business analyst conducting a requirements elicitation interview with a NON-TECHNICAL client (business owner, entrepreneur, or manager). Your goal is to gather enough information to write a COMPLETE system specification.

AUDIENCE — CRITICAL RULES:
- The person you are talking to is NOT a developer. They do not know what NestJS, React, PostgreSQL, REST, OAuth, or any technical term means.
- NEVER ask about technology stack, programming languages, frameworks, databases, or infrastructure. You will decide the stack yourself based on the project type.
- NEVER use technical jargon. Ask about business flows, not implementations.
- Translate every technical concept into business language.

STACK INFERENCE (you decide silently, never ask the user):
- Mobile app mentioned → Flutter
- Web dashboard/panel → React + Next.js
- Bot/automation/API → NestJS + PostgreSQL
- Real-time features → Socket.io
- Payments → integrate with gateway the client mentions (Stripe, Pix, etc.)
- Default stack: NestJS + React/Next.js + PostgreSQL + Docker

INTERVIEW RULES:
- Ask ONE focused question at a time. Never multiple questions.
- Follow up on vague answers in business terms.
- Go deep on business rules, not implementation.
- Be conversational, warm, encouraging.
- Always respond in the same language the user is writing in (pt-BR, en, es).

DOMAINS TO COVER before isComplete=true:
- context: business problem, target market, revenue model, differentiators
- users: all personas with permissions, workflows, pain points
- features: ALL core modules with sub-features, edge cases, business rules
- data: main entities, relationships, volume estimates, retention
- integrations: third-party services (payment, notifications, WhatsApp, etc.)
- nfr: expected users, uptime, performance (in business terms)
- stack: AUTO-INFERRED — never ask
- rules: validation, approvals, automation triggers, exception handling

WHEN TO DECLARE isComplete:
Only when you have DEEP coverage of all 8 domains. A good test: could a developer build the system from what you know? If not, keep asking.

RESPONSE FORMAT — you ALWAYS respond with a JSON object:
{
  "message": "<next question or final summary, in the user's language>",
  "coveredTopics": ["context", "users", ...],
  "isComplete": false,
  "detectedName": "<best guess at project name when available, else null>",
  "inferredStack": { "backend": [...], "frontend": [...], "mobile": [...], "database": [...], "infra": [...] }
}

When isComplete=true:
- Include full "specMarkdown" with sections: Overview, Users, Features (per module), Data Model, Integrations, Non-Functional, Stack Decision, Business Rules.
- Include "inferredStack" populated with all arrays (empty arrays OK for tiers the project doesn't need).

Your response MUST be pure JSON — no code fences, no prose outside the JSON.`;

// ── Helpers ────────────────────────────────────────────────────────────────

async function callInterviewTurn(
  history: InterviewMsg[],
  apiConfigId?: string,
): Promise<{
  message: string;
  coveredTopics: string[];
  isComplete: boolean;
  detectedName?: string;
  specMarkdown?: string;
  inferredStack?: StackSelection;
}> {
  const api = getApiClient();
  const res = await api.post('/ai/complete', {
    ...(apiConfigId ? { apiConfigId } : {}),
    maxTokens: 8192,
    system: INTERVIEW_SYSTEM_PROMPT,
    messages: history.map((m) => ({ role: m.role, content: m.content })),
    jsonMode: true,
  });
  const raw = (res.data?.content || res.data?.message?.content || '').toString().trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Interview model returned non-JSON: ${raw.slice(0, 200)}`);
  try { return JSON.parse(match[0]); }
  catch (e: any) { throw new Error(`Interview JSON parse failed: ${e.message}. Raw: ${raw.slice(0, 200)}`); }
}

function parseStackShorthand(raw: string): StackSelection {
  const parts = raw.split(/[+,\s]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const stack: StackSelection = { backend: [], frontend: [], mobile: [], database: [], infra: [] };
  for (const p of parts) {
    if (/^(nest|nestjs)$/.test(p)) stack.backend!.push('NestJS');
    else if (/^(next|nextjs)$/.test(p)) stack.frontend!.push('Next.js');
    else if (/^react$/.test(p)) stack.frontend!.push('React');
    else if (/^flutter$/.test(p)) stack.mobile!.push('Flutter');
    else if (/^(react-?native|rn)$/.test(p)) stack.mobile!.push('React Native');
    else if (/^(postgres|postgresql|pg)$/.test(p)) stack.database!.push('PostgreSQL');
    else if (/^mysql$/.test(p)) stack.database!.push('MySQL');
    else if (/^mongo(db)?$/.test(p)) stack.database!.push('MongoDB');
    else if (/^redis$/.test(p)) stack.database!.push('Redis');
    else if (/^docker$/.test(p)) stack.infra!.push('Docker');
  }
  for (const k of Object.keys(stack) as Array<keyof StackSelection>) {
    if (!stack[k]?.length) delete stack[k];
  }
  return stack;
}

function printStack(stack: StackSelection): void {
  const tiers: Array<[string, string[] | undefined]> = [
    ['backend ', stack.backend],
    ['frontend', stack.frontend],
    ['mobile  ', stack.mobile],
    ['database', stack.database],
    ['infra   ', stack.infra],
  ];
  const any = tiers.some(([, v]) => v?.length);
  if (!any) {
    console.log(`${dim('│')}    ${dim('(sem stack — o analyst vai detectar do briefing)')}`);
    return;
  }
  for (const [label, values] of tiers) {
    if (values?.length) {
      console.log(`${dim('│')}    ${cyan(label)}  ${values.join(', ')}`);
    }
  }
}

// ── Phases ─────────────────────────────────────────────────────────────────

async function phaseInterview(
  options: NewProjectOptions,
): Promise<{ spec: string; name: string; inferredStack?: StackSelection }> {
  header('1/8', 'Entrevista — vamos conversar sobre o projeto');
  console.log(`${dim('│')}  ${dim('Responda em linguagem do negócio. Digite /cancel ou Esc-Esc pra sair.')}`);
  console.log(dim('│'));

  if (options.specFile) {
    const fs = require('fs');
    if (!fs.existsSync(options.specFile)) {
      console.log(`${dim('│')}  ${red('✗')} Spec file not found: ${options.specFile}`);
      process.exit(1);
    }
    const spec = fs.readFileSync(options.specFile, 'utf8');
    console.log(`${dim('│')}  ${green('✓')} Spec carregada de ${cyan(options.specFile)} ${dim(`(${Math.round(spec.length / 1024)}KB)`)}`);
    const m = spec.match(/^#\s+(.+)/m);
    const name = options.name || (m ? m[1].trim() : '');
    return { spec, name };
  }

  const history: InterviewMsg[] = [];
  history.push({
    role: 'user',
    content: options.name
      ? `Quero iniciar um projeto chamado "${options.name}". Faça as perguntas necessárias para construir a especificação completa.`
      : 'Quero iniciar um novo projeto. Faça as perguntas necessárias para construir a especificação completa.',
  });

  const MAX_TURNS = 40;
  let turn = 0;
  let detectedName = options.name || '';
  let inferredStack: StackSelection | undefined;

  while (turn < MAX_TURNS) {
    turn++;
    const stop = spinner('pensando na próxima pergunta...');
    let reply;
    try { reply = await callInterviewTurn(history, options.apiConfigId); }
    catch (e: any) { stop(); throw new Error(`Entrevista falhou: ${e.message}`); }
    stop();

    console.log(`${dim('│')}  ${cyan('▸')} ${reply.message}`);
    if (reply.coveredTopics?.length) {
      console.log(`${dim('│')}    ${dim(`(domínios: ${reply.coveredTopics.join(', ')})`)}`);
    }
    if (reply.detectedName && !detectedName) detectedName = reply.detectedName;

    if (reply.isComplete && reply.specMarkdown) {
      inferredStack = reply.inferredStack;
      console.log(dim('│'));
      console.log(`${dim('│')}  ${green('✓')} Entrevista completa. Spec de ${cyan(`${Math.round(reply.specMarkdown.length / 1024)}KB`)} gerada.`);
      return { spec: reply.specMarkdown, name: detectedName, inferredStack };
    }

    console.log(dim('│'));
    const answer = await ask(`${dim('│')}  ${bold('você')} › `);
    const trimmed = answer.trim();
    if (trimmed.toLowerCase() === '/cancel' || trimmed.toLowerCase() === '/quit') {
      throw new UserCancelled();
    }
    if (!trimmed) {
      console.log(`${dim('│')}  ${yellow('!')} resposta vazia — Esc-Esc pra cancelar.`);
      turn--;
      continue;
    }
    history.push({ role: 'assistant', content: JSON.stringify(reply) });
    history.push({ role: 'user', content: trimmed });
  }
  throw new Error('Entrevista não completou em 40 turnos.');
}

async function phaseStackConfirm(
  inferred: StackSelection | undefined,
  nonInteractive: boolean,
  override?: string,
): Promise<StackSelection> {
  if (override) {
    const parsed = parseStackShorthand(override);
    header('2/8', 'Stack (via --stack)');
    printStack(parsed);
    return parsed;
  }
  if (nonInteractive) return inferred || {};

  header('2/8', 'Stack tecnológico');
  if (inferred && Object.keys(inferred).length) {
    console.log(`${dim('│')}  ${dim('Inferido pela entrevista:')}`);
    printStack(inferred);
  } else {
    console.log(`${dim('│')}  ${dim('(nenhuma stack inferida — o analyst detecta do briefing)')}`);
  }
  console.log(dim('│'));
  const ans = (await ask(`${dim('│')}  Aceitar stack? ${dim('[S/n/e=editar]')}: `)).toLowerCase();
  if (ans === 'n' || ans === 'no') {
    console.log(`${dim('│')}  ${dim('→ ok, backend vai detectar do briefing')}`);
    return {};
  }
  if (ans === 'e' || ans === 'edit') {
    const raw = await ask(`${dim('│')}  Shorthand ${dim('(ex: "nest+next+postgres+docker")')}: `);
    if (raw.trim()) {
      const parsed = parseStackShorthand(raw);
      console.log(`${dim('│')}  ${dim('Stack editada:')}`);
      printStack(parsed);
      return parsed;
    }
    return inferred || {};
  }
  return inferred || {};
}

interface BoilerplateEntry {
  id: string;
  name: string;
  description?: string;
  stack?: string;
}

async function phaseBoilerplate(nonInteractive: boolean): Promise<string | null> {
  if (nonInteractive) return null;
  header('3/8', 'Boilerplate');

  const api = getApiClient();
  const stop = spinner('buscando boilerplates...');
  let list: BoilerplateEntry[] = [];
  try {
    const res = await api.get('/dark-factory/boilerplates');
    list = res.data?.boilerplates || res.data || [];
  } catch (err) { swallow(err); }
  stop();

  if (!list.length) {
    console.log(`${dim('│')}  ${dim('(nenhum boilerplate cadastrado neste tenant)')}`);
    return null;
  }

  console.log(`${dim('│')}  ${dim('Disponíveis:')}`);
  console.log(`${dim('│')}    ${bold('0)')} ${dim('Sem boilerplate — projeto vazio')}`);
  list.forEach((b, i) => {
    const tag = b.stack ? dim(` · ${b.stack}`) : '';
    console.log(`${dim('│')}    ${bold(`${i + 1})`)} ${cyan(b.name)}${tag}`);
    if (b.description) console.log(`${dim('│')}       ${dim(b.description.slice(0, 80))}`);
  });
  console.log(dim('│'));
  const ans = (await ask(`${dim('│')}  Escolha ${dim(`[0-${list.length}]`)}: `)).trim();
  const idx = parseInt(ans, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx > list.length) {
    console.log(`${dim('│')}  ${yellow('!')} ${dim('escolha inválida — seguindo sem boilerplate')}`);
    return null;
  }
  if (idx === 0) return null;
  const chosen = list[idx - 1];
  console.log(`${dim('│')}  ${green('✓')} ${cyan(chosen.name)} selecionado`);
  return chosen.id;
}

async function phaseRepo(projectName: string, nonInteractive: boolean): Promise<RepoSelection> {
  if (nonInteractive) return { mode: 'skip' };
  header('4/8', 'Repositório Git');

  console.log(`${dim('│')}  ${dim('Como conectar o projeto a Git?')}`);
  console.log(`${dim('│')}    ${bold('n)')} criar novo repo privado no GitHub`);
  console.log(`${dim('│')}    ${bold('e)')} usar repo existente (URL + branch)`);
  console.log(`${dim('│')}    ${bold('s)')} pular — sem Git agora`);
  console.log(dim('│'));
  const ans = (await ask(`${dim('│')}  Escolha ${dim('[n/e/S]')}: `)).toLowerCase();

  if (ans === 'n' || ans === 'new') {
    const defaultName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const owner = (await ask(`${dim('│')}  GitHub owner ${dim('(user ou org)')}: `)).trim();
    if (!owner) { console.log(`${dim('│')}  ${yellow('!')} owner vazio — pulando`); return { mode: 'skip' }; }
    const name = (await ask(`${dim('│')}  Nome do repo ${dim(`[${defaultName}]`)}: `)).trim() || defaultName;
    const token = (await ask(`${dim('│')}  Personal Access Token ${dim('(scope: repo)')}: `)).trim();
    if (!token) { console.log(`${dim('│')}  ${yellow('!')} token vazio — pulando`); return { mode: 'skip' }; }
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
      console.log(`${dim('│')}  ${yellow('!')} ${dim('token não tem prefixo esperado (ghp_ / github_pat_) — seguindo assim mesmo')}`);
    }
    return { mode: 'new', gitOwner: owner, gitName: name, gitToken: token, gitPrivate: true };
  }

  if (ans === 'e' || ans === 'existing') {
    const url = (await ask(`${dim('│')}  URL ${dim('(git@... ou https://...)')}: `)).trim();
    if (!url) { console.log(`${dim('│')}  ${yellow('!')} URL vazia — pulando`); return { mode: 'skip' }; }
    const branch = (await ask(`${dim('│')}  Branch ${dim('[main]')}: `)).trim() || 'main';
    return { mode: 'existing', repoUrl: url, repoBranch: branch };
  }

  return { mode: 'skip' };
}

async function phaseSummary(
  projectName: string,
  specLen: number,
  stack: StackSelection,
  boilerplateId: string | null,
  repo: RepoSelection,
  nonInteractive: boolean,
): Promise<boolean> {
  if (nonInteractive) return true;
  header('5/8', 'Resumo');

  console.log(`${dim('│')}  ${dim('Nome:')}        ${cyan(projectName)}`);
  console.log(`${dim('│')}  ${dim('Spec:')}        ${cyan(`${Math.round(specLen / 1024)}KB`)} ${dim('(da entrevista)')}`);
  console.log(dim('│'));
  if (Object.keys(stack).length) {
    console.log(`${dim('│')}  ${dim('Stack:')}`);
    printStack(stack);
  } else {
    console.log(`${dim('│')}  ${dim('Stack:')}        ${dim('(analyst vai detectar)')}`);
  }
  console.log(`${dim('│')}  ${dim('Boilerplate:')} ${boilerplateId ? cyan(boilerplateId.slice(0, 36)) : dim('(nenhum)')}`);
  if (repo.mode === 'new') {
    console.log(`${dim('│')}  ${dim('Repo:')}        ${green('novo')} github.com/${repo.gitOwner}/${repo.gitName} ${dim('(privado)')}`);
  } else if (repo.mode === 'existing') {
    console.log(`${dim('│')}  ${dim('Repo:')}        ${cyan(repo.repoUrl!)} ${dim(`(branch ${repo.repoBranch})`)}`);
  } else {
    console.log(`${dim('│')}  ${dim('Repo:')}        ${dim('(sem Git)')}`);
  }
  console.log(dim('│'));
  console.log(`${dim('│')}  ${dim('Em seguida: analyst gera requisitos + DUMs (2-10min), depois pipeline.')}`);
  console.log(dim('│'));
  const ans = (await ask(`${dim('│')}  Confirmar e criar? ${dim('[S/n]')}: `)).toLowerCase();
  return ans !== 'n' && ans !== 'no';
}

// ──────────────────────────────────────────────────────────────────────────

export async function newProjectCommand(options: NewProjectOptions = {}): Promise<void> {
  try {
    return await _newProjectInner(options);
  } catch (err: any) {
    if (err instanceof UserCancelled || err?.name === 'UserCancelled') {
      const inRepl = process.env.MAKESTUDIO_REPL === '1';
      const suffix = inRepl ? ' Voltando ao REPL.' : '';
      console.log(`\n${dim('│')}  ${yellow('⤺')}  Cancelado.${suffix}`);
      process.exit(0);
    }
    console.log();
    console.log(`${dim('│')}  ${red('✗')} ${err.message || err}`);
    process.exit(1);
  }
}

async function _newProjectInner(options: NewProjectOptions): Promise<void> {
  if (!process.env.MAKESTUDIO_REPL) printBanner('New Project');
  console.log(dim('│'));

  await ensureAuthenticated();

  // ── Phase 1: Interview ──────────────────────────────────────
  const { spec, name: interviewName, inferredStack } = await phaseInterview(options);
  let projectName = interviewName;
  if (!projectName) {
    console.log(dim('│'));
    projectName = (await ask(`${dim('│')}  Nome do projeto: `)).trim();
  }
  if (!projectName) throw new Error('Nome do projeto é obrigatório.');

  // ── Phase 2: Stack ──────────────────────────────────────────
  const stack = await phaseStackConfirm(inferredStack, !!options.nonInteractive, options.stack);

  // ── Phase 3: Boilerplate ────────────────────────────────────
  const boilerplateId = await phaseBoilerplate(!!options.nonInteractive);

  // ── Phase 4: Repo ───────────────────────────────────────────
  const repo = await phaseRepo(projectName, !!options.nonInteractive);

  // ── Phase 5: Summary/confirm ────────────────────────────────
  const confirmed = await phaseSummary(
    projectName, spec.length, stack, boilerplateId, repo, !!options.nonInteractive,
  );
  if (!confirmed) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${yellow('⤺')} Cancelado pelo usuário.`);
    return;
  }

  // ── Phase 6: Create project ─────────────────────────────────
  // Payload mirrors flowbuilder/src/pages/DarkFactory.tsx:6254 exactly.
  header('6/8', 'Criando projeto no backend');
  const api = getApiClient();
  const createPayload: any = {
    name: projectName,
    description: spec,
    briefing: spec,
    analystStrategy: 'makestudio',
    automationLevel: 'full',
    decompositionStrategy: 'autonomous',
    metadata: {
      specMarkdown: spec,
      createdVia: 'cli-new-command',
      ...(repo.gitToken ? { gitToken: repo.gitToken } : {}),
    },
  };
  if (Object.keys(stack).length) createPayload.stack = stack;
  if (boilerplateId) createPayload.boilerplateId = boilerplateId;
  if (repo.mode === 'existing' && repo.repoUrl) {
    createPayload.repoUrl = repo.repoUrl;
    createPayload.repoBranch = repo.repoBranch;
  }

  const stopCreate = spinner('POST /dark-factory/projects...');
  let project: any;
  try {
    const res = await api.post('/dark-factory/projects', createPayload);
    project = res.data;
  } finally { stopCreate(); }
  if (!project?.id) throw new Error('Criação do projeto falhou (resposta inesperada).');
  console.log(`${dim('│')}  ${green('✓')} Projeto criado: ${cyan(project.id)}`);

  // ── Phase 7: Start analyst ──────────────────────────────────
  // `/start-analysis` is the REAL requirements+DUM generator.
  header('7/8', 'Analyst autônomo — gerando requisitos e DUMs');
  console.log(`${dim('│')}  ${dim('Extrai RF/RNF/regras do briefing e agrupa em DUMs. Pode levar 2-10min.')}`);

  const startedAt = Date.now();
  const stopAnalyst = spinner('start-analysis em execução...');
  try {
    const res = await api.post(
      `/dark-factory/projects/${project.id}/start-analysis`,
      { automationLevel: 'full' },
      { timeout: 20 * 60 * 1000 },
    );
    stopAnalyst();
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const reqs = res.data?.requirementsCreated ?? res.data?.requirements?.length ?? '?';
    const dums = res.data?.dumCreated ?? res.data?.dums?.length ?? '?';
    console.log(`${dim('│')}  ${green('✓')} Analyst concluiu em ${elapsed}s ${dim(`· requisitos: ${reqs} · DUMs: ${dums}`)}`);
  } catch (e: any) {
    stopAnalyst();
    console.log(`${dim('│')}  ${red('✗')} Analyst falhou: ${e.message?.slice(0, 150)}`);
    console.log(`${dim('│')}  ${dim(`→ Projeto ${project.id} foi criado; rode \`makestudio refine --project-id ${project.id}\` pra re-tentar.`)}`);
    return;
  }

  if (options.onlyDecompose) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${green('✓')} Projeto pronto.`);
    console.log(`${dim('│')}  ${dim('Próximo:')} ${cyan(`makestudio execute --project-id ${project.id}`)}`);
    return;
  }

  // ── Phase 8: Generate pipeline ──────────────────────────────
  header('8/8', 'Gerando pipeline');
  const stopPipe = spinner('POST /generate-pipeline...');
  try {
    await api.post(`/dark-factory/projects/${project.id}/generate-pipeline`, {});
    stopPipe();
    console.log(`${dim('│')}  ${green('✓')} Pipeline gerado (ordem topológica + design por DUM)`);
  } catch (e: any) {
    stopPipe();
    console.log(`${dim('│')}  ${yellow('!')} Pipeline falhou (seguindo): ${dim(e.message?.slice(0, 100))}`);
  }

  // ── Optional: Create GitHub repo ────────────────────────────
  if (repo.mode === 'new' && repo.gitOwner && repo.gitName && repo.gitToken && boilerplateId) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${blue('+')} Criando repo github.com/${repo.gitOwner}/${repo.gitName}`);
    const stopRepo = spinner('POST /repo/create...');
    try {
      await api.post(`/dark-factory/projects/${project.id}/repo/create`, {
        owner: repo.gitOwner,
        name: repo.gitName,
        private: repo.gitPrivate !== false,
        gitToken: repo.gitToken,
      });
      stopRepo();
      console.log(`${dim('│')}  ${green('✓')} Repo criado e linkado`);
    } catch (e: any) {
      stopRepo();
      console.log(`${dim('│')}  ${yellow('!')} Repo falhou (projeto criado mesmo assim): ${dim(e.message?.slice(0, 150))}`);
    }
  } else if (repo.mode === 'new' && !boilerplateId) {
    console.log(`${dim('│')}  ${yellow('!')} ${dim('repo novo pedido sem boilerplate — nada pra dar push. use makestudio init depois.')}`);
  }

  // ── Optional: auto-execute ──────────────────────────────────
  if (options.autoExecute) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${blue('▶')} ${bold('Iniciando execução do pipeline...')}`);
    console.log();
    await executeCommand({ projectId: project.id, cli: 'makestudio' });
    return;
  }

  console.log(dim('│'));
  console.log(`${dim('│')}  ${green('✓')} ${bold('Projeto pronto.')}`);
  console.log(dim('│'));
  console.log(`${dim('│')}  ${dim('Próximos passos:')}`);
  console.log(`${dim('│')}    ${cyan('makestudio execute')} ${dim(`--project-id ${project.id}`)}              ${dim('# executa o pipeline')}`);
  console.log(`${dim('│')}    ${cyan('makestudio execute')} ${dim(`--project-id ${project.id} --plan`)}       ${dim('# aprovação de plano por DUM')}`);
  console.log(`${dim('│')}    ${cyan('makestudio execute')} ${dim(`--project-id ${project.id} --isolate`)}    ${dim('# cada DUM em worktree')}`);
  console.log(`${dim('│')}    ${cyan('makestudio refine')}  ${dim(`--project-id ${project.id}`)}              ${dim('# ajusta spec/requisitos/DUMs')}`);
  console.log();
}
