/**
 * `makestudio refine` — entry point.
 *
 * The pipeline is split across topic modules:
 *   refine-prompts.ts     — runLocalCLI, ask, askWithTimeout, spinner, UserCancelled
 *   refine-sync.ts        — disk → backend DUM sync, boilerplate snapshot
 *   refine-audit.ts       — audit pass + report display
 *   refine-fix.ts         — corrective DUM generation, weak-DUM regen, description rewrite
 *   refine-steps.ts       — _refineCommandInner orchestrator + per-step helpers
 *   refine-decompose.ts   — runDecompose
 *   refine-types.ts       — AuditReport / AuditBlocker
 */
import chalk from 'chalk';
import { _refineCommandInner } from './refine-steps';
import { UserCancelled } from './refine-prompts';

const dim = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');

export async function refineCommand(options: {
  projectId?: string;
  cli?: string;
  noDecompose?: boolean;
  requirementsOnly?: boolean;
  repo?: string;
}): Promise<void> {
  try {
    return await _refineCommandInner(options);
  } catch (err: any) {
    if (err instanceof UserCancelled || err?.name === 'UserCancelled') {
      console.log(`\n${dim('│')}  ${yellow('⤺')}  Cancelado (Esc Esc). Voltando ao REPL.`);
      process.exit(0);
    }
    throw err;
  }
}

// Re-exports preserved for backwards compatibility (other code imports
// these from `refine`).
export { runDecompose } from './refine-decompose';
