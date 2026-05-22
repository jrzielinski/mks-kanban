import * as React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { ReplContext } from '../context';

// Build info — read from package.json at runtime.
function getBuildInfo(): { version: string; build: string; plugins: number } {
  try {
    const pkg = require('../../../package.json');
    let plugins = 0;
    try {
      const { pluginRegistry } = require('../../core/plugin-registry');
      plugins = pluginRegistry.count();
    } catch {}
    return {
      version: pkg.version || '?',
      build: new Date().toISOString().slice(0, 10),
      plugins,
    };
  } catch {
    return { version: '?', build: '?', plugins: 0 };
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function lerpHex(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return '#' + [r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Piecewise-linear gradient across N stops. t∈[0,1]. */
function sampleGradient(stops: string[], t: number): string {
  if (stops.length === 1) return stops[0];
  const clamped = Math.max(0, Math.min(1, t));
  const pos = clamped * (stops.length - 1);
  const i = Math.min(Math.floor(pos), stops.length - 2);
  const local = pos - i;
  return lerpHex(hexToRgb(stops[i]), hexToRgb(stops[i + 1]), local);
}

/** Paint each char of `line` with a colour sampled from a multi-stop gradient. */
function gradientLine(line: string, stops: string[]): string {
  const n = line.length;
  let out = '';
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : i / (n - 1);
    const ch = line[i];
    out += ch === ' ' ? ch : chalk.hex(sampleGradient(stops, t)).bold(ch);
  }
  return out;
}

/**
 * Print the welcome banner DIRECTLY to stdout before the Ink TUI mounts.
 * This avoids Ink repainting the ASCII art on every re-render, which was
 * the root cause of visible flicker while typing.
 */
export function printWelcomeBanner(ctx: ReplContext): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const theme = require('../theme');
  const palette = theme.colors();
  const dim = chalk.hex(palette.dim);
  const primary = chalk.hex(palette.primary).bold;
  const muted = chalk.hex(palette.dim);
  const modelColor = chalk.hex(palette.primary);
  const successColor = chalk.hex(palette.success);

  const email = ctx.user?.email || 'not authenticated';
  const project = ctx.activeProject?.name;
  const model = ctx.providerInfo
    ? `${ctx.providerInfo.provider} · ${ctx.providerInfo.model}`
    : ctx.provider || 'no model';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os');
  const cwd = process.cwd();
  const home = os.homedir();
  const shortCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const displayCwd = shortCwd.length > 52 ? '\u2026' + shortCwd.slice(-49) : shortCwd;
  const info = getBuildInfo();

  // Gradient wordmark for the Amiga-style ASCII art base
  const wordmark = gradientLine('MakeStudio', palette.bannerGradient);
  const accent = chalk.hex(palette.accent).bold;

  const SEP = muted(' \u00b7 '); // · separator

  // IBM monitor ASCII art — frame in gradient, MakeStudio in gradient
  const gline = (s: string) => gradientLine(s, palette.bannerGradient);
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const padR = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
  const MON_W = 30; // visual width of widest monitor line
  const GAP = '   '; // gap between monitor and info

  const inner = 19;
  const verLine  = (` v${info.version}`).padEnd(inner);
  const dateLine = (` ${info.build}`).padEnd(inner);
  const monLines = [
    gline('   .---------------------.'),
    gline('   |.-------------------.|'),
    gline('   ||') + accent(' >code#') + gline('            ||'),
    gline('   ||                   ||'),
    gline('   ||') + muted(verLine)  + gline('||'),
    gline('   ||') + muted(dateLine) + gline('||'),
    gline("   |'-------------------'|"),
    gline('.--^---------------------^---.'),
    gline('|      ---~  ') + wordmark + gline('      |'),
    gline("'----------------------------'"),
  ];

  // Info lines shown to the right of the monitor (aligned by row)
  const infoLines: string[] = [
    '',
    primary('MakeStudio') + muted(`  v${info.version}`),
    muted('Autonomous AI Development Studio'),
    '',
    muted('model  ') + modelColor(model),
    muted('path   ') + muted(displayCwd),
    muted('user   ') + muted(email),
    project ? muted('proj   ') + successColor(project) : '',
    '',
    muted('\u2191\u2193 history') + SEP + muted('Tab') + SEP + muted('/help') + SEP + muted('Ctrl+C'),
  ];

  // Tip (appended after the side-by-side block)
  let tip = '';
  try {
    const { bumpStartupAndPickTip } = require('../tips');
    tip = bumpStartupAndPickTip() || '';
  } catch { /* optional */ }

  const lines: string[] = [''];
  const rows = Math.max(monLines.length, infoLines.length);
  for (let i = 0; i < rows; i++) {
    const m = monLines[i] ?? '';
    const inf = infoLines[i] ?? '';
    lines.push(padR(m, MON_W) + (inf ? GAP + inf : ''));
  }
  if (tip) {
    lines.push('');
    lines.push(muted('  tip  ') + chalk.hex(palette.text)(tip));
  }
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

function WelcomeImpl({ ctx }: { ctx: ReplContext; cols: number }): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const theme = require('../theme');
  const palette = theme.colors();

  const email = ctx.user?.email || 'not authenticated';
  const project = ctx.activeProject?.name;
  const model = ctx.providerInfo
    ? `${ctx.providerInfo.provider} · ${ctx.providerInfo.model}`
    : ctx.provider || 'no model';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('os');
  const cwd = process.cwd();
  const home = os.homedir();
  const shortCwd = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const displayCwd = shortCwd.length > 52 ? '\u2026' + shortCwd.slice(-49) : shortCwd;
  const info = getBuildInfo();

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box flexDirection="row" alignItems="flex-start">
        {/* Monitor */}
        <Box flexDirection="column">
          <Text color={palette.primary}>{'   .---------------------.  '}</Text>
          <Text color={palette.primary}>{'   |.-------------------.|  '}</Text>
          <Box><Text color={palette.primary}>{'   ||'}</Text><Text color={palette.accent} bold>{' >code#'}</Text><Text color={palette.primary}>{'            ||'}</Text></Box>
          <Text color={palette.primary}>{'   ||                   ||'}</Text>
          <Box><Text color={palette.primary}>{'   ||'}</Text><Text color={palette.dim}>{(` v${info.version}`).padEnd(19)}</Text><Text color={palette.primary}>{'||'}</Text></Box>
          <Box><Text color={palette.primary}>{'   ||'}</Text><Text color={palette.dim}>{(` ${info.build}`).padEnd(19)}</Text><Text color={palette.primary}>{'||'}</Text></Box>
          <Text color={palette.primary}>{"   |'-------------------'|"}</Text>
          <Text color={palette.primary}>{'.--^---------------------^---.'}</Text>
          <Box><Text color={palette.primary}>{'|      ---~  '}</Text><Text color={palette.accent} bold>{'MakeStudio'}</Text><Text color={palette.primary}>{'      |'}</Text></Box>
          <Text color={palette.primary}>{"'----------------------------'"}</Text>
        </Box>
        {/* Info panel to the right */}
        <Box flexDirection="column" marginLeft={3} justifyContent="center">
          <Box><Text color={palette.primary} bold>{'MakeStudio'}</Text><Text color={palette.dim}>{`  v${info.version}`}</Text></Box>
          <Text color={palette.dim}>{'Autonomous AI Development Studio'}</Text>
          <Box marginTop={1} flexDirection="column">
            <Box><Text color={palette.dim}>{'model  '}</Text><Text color={palette.primary}>{model}</Text></Box>
            <Box><Text color={palette.dim}>{'path   '}</Text><Text color={palette.dim}>{displayCwd}</Text></Box>
            <Box><Text color={palette.dim}>{'user   '}</Text><Text color={palette.dim}>{email}</Text></Box>
            {project ? <Box><Text color={palette.dim}>{'proj   '}</Text><Text color={palette.success}>{project}</Text></Box> : null}
          </Box>
          <Box marginTop={1}>
            <Text color={palette.dim}>{'↑↓ history · Tab · /help · Ctrl+C'}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// Welcome state depends only on ctx identity (user, project, providerInfo) —
// memoize to avoid re-render on every statsTick.
export const Welcome = React.memo(WelcomeImpl, (prev, next) => {
  return prev.ctx === next.ctx && prev.cols === next.cols;
});
