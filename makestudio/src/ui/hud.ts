import chalk from 'chalk';

// ── HUD state (single-task — agent CLI processes one task at a time) ──

interface HudState {
  mode: 'idle' | 'task' | 'pipeline' | 'auto-pick';
  taskTitle?: string;
  taskType?: string;
  taskIndex?: number;
  totalTasks?: number;
  modelTier?: string;
  costUsd: number;
  tasksCompleted: number;
  tasksFailed: number;
  startedAt: number;
  toolCalls: number;
  currentTool?: string;
  verifyAttempt?: number;
  maxRetries?: number;
}

const state: HudState = {
  mode: 'idle',
  costUsd: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
  startedAt: Date.now(),
  toolCalls: 0,
};

// ── State management ─────────────────────────────────────────────

export function hudStartTask(opts: {
  title: string;
  type?: string;
  index?: number;
  total?: number;
  tier?: string;
}): void {
  state.mode = 'task';
  state.taskTitle = opts.title;
  state.taskType = opts.type;
  state.taskIndex = opts.index;
  state.totalTasks = opts.total;
  state.modelTier = opts.tier;
  state.startedAt = Date.now();
  state.toolCalls = 0;
  state.currentTool = undefined;
  printHud();
}

export function hudStartPipeline(totalTasks: number): void {
  state.mode = 'pipeline';
  state.totalTasks = totalTasks;
  state.tasksCompleted = 0;
  state.tasksFailed = 0;
  state.costUsd = 0;
  state.startedAt = Date.now();
  printHud();
}

export function hudStartAutoPick(): void {
  state.mode = 'auto-pick';
  state.startedAt = Date.now();
  printHud();
}

export function hudToolCall(tool: string): void {
  state.toolCalls++;
  state.currentTool = tool;
}

export function hudTaskCompleted(costUsd: number): void {
  state.tasksCompleted++;
  state.costUsd += costUsd;
  state.currentTool = undefined;
}

export function hudTaskFailed(): void {
  state.tasksFailed++;
  state.currentTool = undefined;
}

export function hudVerifyAttempt(attempt: number, max: number): void {
  state.verifyAttempt = attempt;
  state.maxRetries = max;
}

export function hudClearVerify(): void {
  state.verifyAttempt = undefined;
  state.maxRetries = undefined;
}

export function hudReset(): void {
  state.mode = 'idle';
  state.taskTitle = undefined;
  state.taskType = undefined;
  state.taskIndex = undefined;
  state.totalTasks = undefined;
  state.modelTier = undefined;
  state.currentTool = undefined;
  state.verifyAttempt = undefined;
  state.maxRetries = undefined;
}

// ── Render ────────────────────────────────────────────────────────

export function printHud(): void {
  const elapsed = formatElapsed(Date.now() - state.startedAt);
  const cost = chalk.hex('#34D399')(`$${state.costUsd.toFixed(4)}`);

  const parts: string[] = [];

  switch (state.mode) {
    case 'task': {
      const tier = state.modelTier
        ? chalk.hex('#FBBF24')(`[${state.modelTier}]`)
        : '';
      const type = state.taskType
        ? chalk.hex('#38BDF8')(state.taskType.toUpperCase())
        : '';
      const progress = state.taskIndex && state.totalTasks
        ? chalk.hex('#94A3B8')(`[${state.taskIndex}/${state.totalTasks}]`)
        : '';
      const verify = state.verifyAttempt
        ? chalk.hex('#F87171')(` retry ${state.verifyAttempt}/${state.maxRetries}`)
        : '';

      parts.push(
        `  ${chalk.cyan.bold('▶')} ${progress} ${type} ${tier}${verify}`,
        `  ${chalk.hex('#E2E8F0')(state.taskTitle || '')}`,
        `  ${chalk.hex('#94A3B8')(`${elapsed} | ${cost} | ${state.toolCalls} tools`)}`,
      );
      break;
    }
    case 'pipeline': {
      const completed = chalk.hex('#34D399')(`${state.tasksCompleted}✓`);
      const failed = state.tasksFailed > 0 ? chalk.hex('#F87171')(` ${state.tasksFailed}✗`) : '';
      const remaining = (state.totalTasks || 0) - state.tasksCompleted - state.tasksFailed;

      parts.push(
        `  ${chalk.cyan.bold('⚡ PIPELINE')} ${completed}${failed} ${chalk.hex('#94A3B8')(`${remaining} remaining`)}`,
        `  ${chalk.hex('#94A3B8')(`${elapsed} | ${cost}`)}`,
      );
      break;
    }
    case 'auto-pick':
      parts.push(
        `  ${chalk.hex('#FBBF24').bold('🤖 AUTO-PICK')} ${chalk.hex('#94A3B8')(`polling... | ${elapsed}`)}`,
      );
      break;
    default:
      parts.push(`  ${chalk.hex('#94A3B8')('⏸ Idle — aguardando tasks')}`);
  }

  console.log(chalk.hex('#475569')('  ──────────────────────────────────────'));
  parts.forEach(line => console.log(line));
  console.log(chalk.hex('#475569')('  ──────────────────────────────────────'));
}

export function printTaskSummary(opts: {
  title: string;
  type?: string;
  costUsd: number;
  durationMs: number;
  toolCalls: number;
  verified: boolean;
  retries: number;
}): void {
  const dur = formatElapsed(opts.durationMs);
  const cost = chalk.hex('#34D399')(`$${opts.costUsd.toFixed(4)}`);
  const verify = opts.verified
    ? chalk.hex('#34D399')('✓ verified')
    : chalk.hex('#F87171')('✗ unverified');
  const retries = opts.retries > 0
    ? chalk.hex('#FBBF24')(` (${opts.retries} retries)`)
    : '';

  console.log();
  console.log(`  ${chalk.hex('#34D399').bold('✓')} ${chalk.hex('#E2E8F0')(opts.title)}`);
  console.log(`    ${dur} | ${cost} | ${opts.toolCalls} tools | ${verify}${retries}`);
  console.log();
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m${String(sec).padStart(2, '0')}s`;
}
