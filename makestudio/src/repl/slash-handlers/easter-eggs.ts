import { swallow } from '../../utils/log';
/**
 * Hidden / easter-egg slash commands.
 *
 * Registered via the registry directly; NOT routed through router.ts case
 * statements (which would expose them to the Tab-complete scanner). The
 * `hidden: true` flag also keeps them out of /help and any future
 * programmatic listings.
 */
import type { SlashCommand, SlashContext } from '../slash-registry';

function enterFullscreen(): void {
  // Capture current screen, switch to alt-screen, clear it, hide cursor.
  // Done BEFORE flipping the React state so alt-screen captures the
  // live chat (not Ink's mid-transition erase escapes).
  try {
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
  } catch (err) { swallow(err); }
}

async function handleSlashMatrix(_sc: SlashContext): Promise<void> {
  enterFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setMatrixOpen } = require('../tui/bridge');
  setMatrixOpen(true);
}

async function handleSlashFire(_sc: SlashContext): Promise<void> {
  enterFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setFireOpen } = require('../tui/bridge');
  setFireOpen(true);
}

async function handleSlashFireworks(_sc: SlashContext): Promise<void> {
  enterFullscreen();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setFireworksOpen } = require('../tui/bridge');
  setFireworksOpen(true);
}

export const EASTER_EGG_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/matrix'], handler: handleSlashMatrix, hidden: true },
  { names: ['/fire'], handler: handleSlashFire, hidden: true },
  { names: ['/fireworks'], handler: handleSlashFireworks, hidden: true },
];
