import chalk from 'chalk';

/** Set MAKESTUDIO_QUIET=1 or call setQuiet(true) to suppress info/success plugin logs */
let quietMode = process.env.MAKESTUDIO_QUIET === '1' || process.env.MAKESTUDIO_QUIET === 'true';
export function setQuiet(q: boolean): void { quietMode = q; }
export function isQuiet(): boolean { return quietMode; }

export function logInfo(message: string): void {
  if (quietMode) return;
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`${chalk.hex('#94A3B8')(`[${time}]`)} ${chalk.cyan('ℹ')} ${chalk.hex('#CBD5E1')(message)}`);
}

export function logSuccess(message: string): void {
  if (quietMode) return;
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`${chalk.hex('#94A3B8')(`[${time}]`)} ${chalk.hex('#34D399')('✓')} ${chalk.hex('#E2E8F0')(message)}`);
}

export function logError(message: string): void {
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`${chalk.hex('#94A3B8')(`[${time}]`)} ${chalk.hex('#F87171')('✗')} ${chalk.hex('#F87171')(message)}`);
}

export function logWarning(message: string): void {
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`${chalk.hex('#94A3B8')(`[${time}]`)} ${chalk.hex('#FBBF24')('⚠')} ${chalk.hex('#FBBF24')(message)}`);
}

export function logTool(tool: string, detail: string): void {
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`${chalk.hex('#94A3B8')(`[${time}]`)} ${chalk.hex('#FBBF24')('⚡')} ${chalk.hex('#38BDF8').bold(tool)}: ${chalk.hex('#CBD5E1')(detail)}`);
}

export function logTask(taskId: string, title: string): void {
  console.log();
  console.log(chalk.cyan.bold(`  ─── TASK: ${title} ───`));
  console.log(chalk.gray(`  ID: ${taskId}`));
  console.log();
}

export function logDivider(): void {
  console.log(chalk.gray('  ────────────────────────────────────────'));
}
