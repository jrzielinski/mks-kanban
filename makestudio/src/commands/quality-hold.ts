import { swallow } from '../utils/log';
/**
 * /quality-hold — TUI for managing tasks held by the quality gate.
 *
 * Subcommands (all hit the backend's /api/v1/dark-factory/projects/:id/quality-* endpoints):
 *   /quality-hold                 → list (default)
 *   /quality-hold list            → list held tasks
 *   /quality-hold summary         → counts by criterion + total
 *   /quality-hold reanalyze <id>  → trigger backend reanalyze (uses tenant's api-config)
 *   /quality-hold edit <id>       → open task in $EDITOR, validate via gate, save if passes
 *
 * The list/summary commands are read-only and fast. Reanalyze can take 30-60s
 * with extended thinking — we show a progress dot animation while waiting.
 *
 * Project resolution: command needs the active projectId. We accept --project <id>
 * or fall back to the project bound to the current REPL session (refine state /
 * recent task). If neither, we error out with a clear message.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';

// Reuse the same color helpers used elsewhere in the agent. Keep the API
// surface identical to other commands so the look-and-feel is consistent.
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const SEVERITY_BADGE: Record<string, string> = {
  BLOCKER: '\x1b[41m\x1b[37m BLOCKER \x1b[0m',
  MAJOR: '\x1b[43m\x1b[30m  MAJOR  \x1b[0m',
  MINOR: '\x1b[44m\x1b[37m  MINOR  \x1b[0m',
};

interface HeldTask {
  id: string;
  title: string;
  type: string;
  dumId: string | null;
  qualityStatus: string;
  issuesCount: number;
  issues: Array<{
    criterion: string;
    severity: string;
    code: string;
    message: string;
    fixHint: string;
  }>;
  // Returned by /quality-hold/list — populated so the manual-edit UI can
  // open the task content without a second fetch.
  description?: string;
  acceptanceCriteria?: string[];
}

interface Summary {
  totalHeld: number;
  totalTasks: number;
  byCriterion: Array<{ criterion: string; severity: string; count: number }>;
  averageIssuesPerHeld: number;
}

export async function runQualityHoldCommand(args: string[], ctx: { projectId?: string }): Promise<void> {
  const projectId = resolveProjectId(args, ctx);
  if (!projectId) {
    console.log(c.yellow('  ⚠  Nenhum projeto ativo. Use --project <id> ou abra um projeto antes.'));
    return;
  }

  const sub = (args[0] || 'list').toLowerCase();

  await ensureAuthenticated();
  const api = getApiClient();

  switch (sub) {
    case 'list':
      await renderList(api, projectId);
      break;
    case 'summary':
      await renderSummary(api, projectId);
      break;
    case 'reanalyze':
    case 'reanalisar': {
      const taskId = args[1];
      if (taskId === '--all' || taskId === 'all') {
        const concIdx = args.findIndex((a) => a === '--concurrency' || a === '-c');
        const concurrency = concIdx >= 0 && args[concIdx + 1] ? parseInt(args[concIdx + 1], 10) : undefined;
        await runReanalyzeAll(api, projectId, concurrency);
        break;
      }
      if (!taskId) {
        console.log(c.yellow('  Uso: /quality-hold reanalyze <taskId>  ou  --all [--concurrency N]'));
        return;
      }
      await runReanalyze(api, projectId, taskId);
      break;
    }
    case 'edit':
    case 'editar': {
      const taskId = args[1];
      if (!taskId) {
        console.log(c.yellow('  Uso: /quality-hold edit <taskId>'));
        return;
      }
      await runEdit(api, projectId, taskId);
      break;
    }
    default:
      console.log(c.yellow(`  Subcomando desconhecido: "${sub}"`));
      console.log(c.dim('  Disponíveis: list, summary, reanalyze <id|--all>, edit <id>'));
  }
}

function resolveProjectId(args: string[], ctx: { projectId?: string }): string | null {
  // Inline --project flag wins. Capture the value BEFORE splicing —
  // after splice(flagIdx, 2), args[flagIdx] is the element that used to
  // be at flagIdx+2, not the flag's value.
  const flagIdx = args.findIndex((a) => a === '--project' || a === '-p');
  if (flagIdx >= 0 && args[flagIdx + 1]) {
    const value = args[flagIdx + 1];
    args.splice(flagIdx, 2);
    return value;
  }
  return ctx.projectId || null;
}

async function renderSummary(api: any, projectId: string): Promise<void> {
  try {
    const res = await api.get(`/dark-factory/projects/${projectId}/quality-hold/summary`);
    const s = res.data as Summary;
    console.log();
    console.log(c.cyan('  ◆ Quality Hold Summary'));
    console.log(c.dim('  ────────────────────────────────────'));
    console.log(`  Tasks em hold:       ${c.bold(String(s.totalHeld))} / ${s.totalTasks}`);
    console.log(`  Issues médios/task:  ${s.averageIssuesPerHeld.toFixed(1)}`);
    console.log();
    if (s.byCriterion.length === 0) {
      console.log(c.dim('  Nenhum issue. Tudo passou no gate.'));
      return;
    }
    console.log(c.dim('  Top issues por critério:'));
    for (const row of s.byCriterion.slice(0, 10)) {
      const badge = SEVERITY_BADGE[row.severity] || `[${row.severity}]`;
      console.log(`    ${badge} ${c.bold(row.criterion.padEnd(20))} ${String(row.count).padStart(4)}`);
    }
    console.log();
  } catch (err: any) {
    console.log(c.red(`  ✗ Falha: ${err.response?.data?.message || err.message}`));
  }
}

async function renderList(api: any, projectId: string): Promise<void> {
  try {
    const res = await api.get(`/dark-factory/projects/${projectId}/quality-hold/list`);
    const data = res.data as { total: number; tasks: HeldTask[] };

    console.log();
    console.log(c.cyan(`  ◆ Quality Hold — ${data.total} tasks bloqueadas`));
    console.log(c.dim('  ' + '─'.repeat(70)));

    if (data.total === 0) {
      console.log(c.green('  ✓ Nenhuma task em hold. Pode avançar pra designer/executor.'));
      console.log();
      return;
    }

    for (const t of data.tasks) {
      const sevBadge = highestSeverityBadge(t.issues);
      const idShort = t.id.slice(0, 8);
      console.log(`  ${sevBadge} ${c.dim(idShort)} ${c.bold(t.title.slice(0, 60))}`);
      console.log(`            ${c.dim(`type=${t.type} | issues=${t.issuesCount}`)}`);
      const top = t.issues.slice(0, 2);
      for (const i of top) {
        console.log(c.dim(`              • [${i.criterion}] ${i.message.slice(0, 90)}`));
      }
      if (t.issues.length > 2) {
        console.log(c.dim(`              ... +${t.issues.length - 2} issue(s)`));
      }
      console.log();
    }

    console.log(c.dim('  Ações:'));
    console.log(c.dim(`    /quality-hold reanalyze <id>   — reanálise via provider configurado em api-configs`));
    console.log(c.dim(`    /quality-hold edit <id>        — editor interativo + validação`));
    console.log();
  } catch (err: any) {
    console.log(c.red(`  ✗ Falha: ${err.response?.data?.message || err.message}`));
  }
}

function highestSeverityBadge(issues: HeldTask['issues']): string {
  const order = { BLOCKER: 3, MAJOR: 2, MINOR: 1 } as const;
  let highest: 'BLOCKER' | 'MAJOR' | 'MINOR' = 'MINOR';
  for (const i of issues) {
    const sev = i.severity as 'BLOCKER' | 'MAJOR' | 'MINOR';
    if (order[sev] > order[highest]) highest = sev;
  }
  return SEVERITY_BADGE[highest];
}

async function runReanalyze(api: any, projectId: string, taskIdArg: string): Promise<void> {
  // Allow short-id matching: if user passes "abcd1234", find the full id by prefix.
  const fullId = await resolveTaskId(api, projectId, taskIdArg);
  if (!fullId) {
    console.log(c.red(`  ✗ Task "${taskIdArg}" não encontrada no projeto`));
    return;
  }

  console.log();
  console.log(c.cyan(`  ◆ Reanalisando ${fullId.slice(0, 8)}... (via provider configurado em api-configs)`));

  const spinner = startSpinner('aguardando provider...');
  let res: any;
  try {
    res = await api.post(
      `/dark-factory/projects/${projectId}/tasks/${fullId}/reanalyze`,
      {},
      { timeout: 5 * 60 * 1000 }, // 5 min — extended thinking can take a while
    );
  } catch (err: any) {
    spinner.stop();
    if (err.response?.status === 409) {
      console.log(c.yellow(`  ⚠  Task em uso por outra reanálise (lock). Tente em alguns segundos.`));
      return;
    }
    console.log(c.red(`  ✗ Falha: ${err.response?.data?.message || err.message}`));
    return;
  }
  spinner.stop();

  const r = res.data;
  const elapsed = ((r.attemptDurationMs ?? 0) / 1000).toFixed(1);
  const cost = (typeof r.costUsd === 'number' ? r.costUsd : 0).toFixed(4);

  if (r.passed) {
    console.log(c.green(`  ✓ Task passou no gate. (${elapsed}s, ~$${cost})`));
  } else if (r.rewritten) {
    console.log(c.yellow(`  ⚠  Reescrita aplicada mas ainda restam ${r.issuesCount} issue(s).`));
    console.log(c.dim(`     Tempo: ${elapsed}s, custo: ~$${cost}`));
    for (const i of (r.issues || []).slice(0, 5)) {
      console.log(c.dim(`     • [${i.severity}] ${i.criterion}: ${i.message.slice(0, 90)}`));
    }
    console.log(c.dim('     Use /quality-hold edit <id> para editar manualmente.'));
  } else {
    console.log(c.red(`  ✗ Reescrita falhou. ${r.issuesCount} issue(s) permanecem.`));
    console.log(c.dim(`     Tempo: ${elapsed}s`));
  }
  console.log();
}

async function runReanalyzeAll(api: any, projectId: string, concurrency?: number): Promise<void> {
  // Pre-fetch the count so we can show a meaningful header before the call.
  let initialCount = 0;
  try {
    const sumRes = await api.get(`/dark-factory/projects/${projectId}/quality-hold/summary`);
    initialCount = sumRes.data?.totalHeld || 0;
  } catch (err) { swallow(err); }

  if (initialCount === 0) {
    console.log();
    console.log(c.green('  ✓ Nenhuma task em hold pra reanalisar.'));
    console.log();
    return;
  }

  const cap = concurrency ?? 3;
  console.log();
  console.log(c.cyan(`  ◆ Reanalisar todas — ${initialCount} tasks · concorrência=${cap}`));
  console.log(c.dim('  ' + '─'.repeat(60)));
  console.log(c.dim('  Pode levar minutos pra projetos grandes. Aguarde...'));

  const spinner = startSpinner('processando');
  let res: any;
  try {
    // Long timeout — bulk on a 1000-DUM project at concurrency 3 / ~3s/task
    // ≈ 17 min worst case. We cap at 30 min absolute.
    res = await api.post(
      `/dark-factory/projects/${projectId}/quality-hold/reanalyze-bulk`,
      { concurrency: cap },
      { timeout: 30 * 60 * 1000 },
    );
  } catch (err: any) {
    spinner.stop();
    console.log(c.red(`  ✗ Falha: ${err?.response?.data?.message || err?.message || 'erro desconhecido'}`));
    return;
  }
  spinner.stop();

  const r = res.data;
  const elapsed = ((r.durationMs ?? 0) / 1000).toFixed(1);
  const cost = (typeof r.costUsd === 'number' ? r.costUsd : 0).toFixed(4);
  console.log();
  console.log(c.bold('  Resultado:'));
  console.log(`    ${c.green('✓ passed:')}     ${r.passed} / ${r.total}`);
  console.log(`    ${c.yellow('⚠ ainda hold:')} ${r.failed}`);
  if (r.skipped > 0) console.log(`    ${c.dim('  skipped:')}     ${r.skipped} (lock conflict)`);
  console.log(`    ${c.dim('total:')}       ${elapsed}s · ~$${cost}`);
  console.log();
  if (r.failed > 0) {
    console.log(c.dim(`  ${r.failed} task(s) ainda em hold. Tente:`));
    console.log(c.dim('    /quality-hold reanalyze --all     (rodar de novo, escalation pode encontrar provider melhor)'));
    console.log(c.dim('    /quality-hold edit <taskId>       (resolver manualmente)'));
    console.log();
  }
}

async function runEdit(api: any, projectId: string, taskIdArg: string): Promise<void> {
  const fullId = await resolveTaskId(api, projectId, taskIdArg);
  if (!fullId) {
    console.log(c.red(`  ✗ Task "${taskIdArg}" não encontrada`));
    return;
  }

  // Fetch current state
  let task: HeldTask | null = null;
  try {
    const res = await api.get(`/dark-factory/projects/${projectId}/quality-hold/list`);
    task = (res.data.tasks as HeldTask[]).find((t) => t.id === fullId) || null;
  } catch (err: any) {
    console.log(c.red(`  ✗ Falha ao buscar task: ${err.message}`));
    return;
  }
  if (!task) {
    console.log(c.red(`  ✗ Task ${fullId.slice(0, 8)} não está em hold`));
    return;
  }

  // Build a markdown file for $EDITOR. Header is a comment block listing issues.
  const issuesBlock = task.issues
    .map(
      (i, idx) =>
        `> ${idx + 1}. [${i.severity}] ${i.criterion}/${i.code}\n>    ${i.message}\n>    Fix: ${i.fixHint}`,
    )
    .join('\n>\n');

  const tmpDir = path.join(os.homedir(), '.makestudio', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `quality-hold-${fullId.slice(0, 8)}.md`);

  const content = `<!--
QUALITY HOLD EDIT — task ${fullId}
${task.title}

ISSUES (29148-§5.2.5/§5.2.6):
${issuesBlock || '> (none)'}

INSTRUÇÕES:
> 1. Edite título / descrição / acceptance criteria abaixo.
> 2. Mantenha as 3 seções: TITLE, DESCRIPTION, ACCEPTANCE_CRITERIA (uma por linha).
> 3. Salve e feche o editor pra revalidar.
> 4. Cancele (sem salvar) pra desistir.
-->

# TITLE
${task.title}

# DESCRIPTION
${task.description || ''}

# ACCEPTANCE_CRITERIA
${(task.acceptanceCriteria || []).join('\n')}
`;

  fs.writeFileSync(file, content, 'utf8');

  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const proc = spawn(editor, [file], { stdio: 'inherit' });
  await new Promise<void>((resolve) => proc.on('close', () => resolve()));

  // Re-read file
  let edited: string;
  try {
    edited = fs.readFileSync(file, 'utf8');
  } catch {
    console.log(c.yellow('  ⚠  Arquivo de edição desapareceu — operação cancelada'));
    return;
  }

  const parsed = parseEditFile(edited);
  if (!parsed) {
    console.log(c.red('  ✗ Não consegui parsear o arquivo. Mantenha as seções TITLE/DESCRIPTION/ACCEPTANCE_CRITERIA.'));
    return;
  }

  // PUT to manual-edit endpoint
  let res: any;
  try {
    res = await api.put(`/dark-factory/projects/${projectId}/tasks/${fullId}/quality-edit`, parsed, {
      timeout: 60_000,
    });
  } catch (err: any) {
    if (err.response?.status === 409) {
      console.log(c.yellow('  ⚠  Task locked — tente em alguns segundos'));
      return;
    }
    console.log(c.red(`  ✗ Falha: ${err.response?.data?.message || err.message}`));
    return;
  }

  if (res.data.accepted) {
    console.log(c.green(`  ✓ Aceito — task passou no gate`));
    try { fs.unlinkSync(file); } catch (err) { swallow(err); }
  } else {
    console.log(c.yellow(`  ⚠  Ainda há ${res.data.issuesCount} issue(s):`));
    for (const i of (res.data.issues || []).slice(0, 5)) {
      console.log(c.dim(`     • [${i.severity}] ${i.criterion}: ${i.message.slice(0, 90)}`));
    }
    console.log(c.dim(`     Edição salva em: ${file}`));
    console.log(c.dim(`     Re-edite e rode /quality-hold edit ${fullId.slice(0, 8)} de novo.`));
  }
}

function parseEditFile(content: string): { title: string; description: string; acceptanceCriteria: string[] } | null {
  // Strip the leading <!-- ... --> block.
  const stripped = content.replace(/^<!--[\s\S]*?-->\s*/, '');

  const titleMatch = stripped.match(/^#\s*TITLE\s*\n([\s\S]*?)(?=\n#\s*DESCRIPTION\b|$)/im);
  const descMatch = stripped.match(/^#\s*DESCRIPTION\s*\n([\s\S]*?)(?=\n#\s*ACCEPTANCE_CRITERIA\b|$)/im);
  const acMatch = stripped.match(/^#\s*ACCEPTANCE_CRITERIA\s*\n([\s\S]*?)$/im);

  if (!titleMatch || !descMatch || !acMatch) return null;

  const title = titleMatch[1].trim();
  const description = descMatch[1].trim();
  const acceptanceCriteria = acMatch[1]
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

  if (!title) return null;
  return { title, description, acceptanceCriteria };
}

async function resolveTaskId(api: any, projectId: string, taskIdArg: string): Promise<string | null> {
  // If it looks like a full UUID, return as-is.
  if (/^[0-9a-f-]{36}$/i.test(taskIdArg)) return taskIdArg;

  // Otherwise treat as prefix and look up in the held list.
  try {
    const res = await api.get(`/dark-factory/projects/${projectId}/quality-hold/list`);
    const matches = (res.data.tasks as HeldTask[]).filter((t) => t.id.startsWith(taskIdArg));
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      console.log(c.yellow(`  ⚠  "${taskIdArg}" é ambíguo. ${matches.length} matches.`));
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

interface SpinnerHandle {
  stop: () => void;
}

function startSpinner(label: string): SpinnerHandle {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r  ${c.dim(frames[i])} ${c.dim(label)}   `);
    i = (i + 1) % frames.length;
  }, 80);
  return {
    stop: () => {
      clearInterval(t);
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    },
  };
}
