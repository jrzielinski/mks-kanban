import { ReplContext } from '../context';

import { swallow } from '../../utils/log';
/** Emit coordinator log line based on current monitor mode. */
export function coordinatorLog(ctx: ReplContext, workerId: string, message: string): void {
  if (ctx.coordinatorMonitor === 'silent') return;
  const prefix = workerId === 'coordinator' ? '[coordinator]' : `[${workerId}]`;
  const text = `${prefix}  ${message}`;
  // Route through TUI bridge when in TUI mode so direct writes never corrupt Ink's layout.
  try {
    const { getTuiBridge } = require('../tui/bridge');
    const bridge = getTuiBridge?.();
    if (bridge) {
      bridge.addMessage({ role: 'info', text });
      return;
    }
  } catch (err) { swallow(err); }
  process.stderr.write(`\x1B[36m${prefix}\x1B[0m  ${message}\n`);
}
