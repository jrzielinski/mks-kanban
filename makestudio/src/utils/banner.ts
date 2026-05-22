import { swallow } from './log';
/**
 * banner.ts
 *
 * Splash screen padrão — ASCII art em degradê, usado por todos os comandos
 * interativos (refine, new, init, analyze, start). Mesma arte do Welcome
 * banner do REPL, pra não confundir o usuário com 2 identidades visuais.
 *
 * Difere do Welcome.tsx em 1 coisa: aqui o subtítulo vira o nome do comando
 * ativo ("New Project", "Refinement"...) em vez do bloco cwd/user/model.
 */

import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read version dynamically from package.json so it always reflects the built version
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

// ── Gradient helpers (duplicated from Welcome.tsx — kept local because
// Welcome.tsx pulls in ink/react which we don't want in CLI command paths) ──

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

function sampleGradient(stops: string[], t: number): string {
  if (stops.length === 1) return stops[0];
  const clamped = Math.max(0, Math.min(1, t));
  const pos = clamped * (stops.length - 1);
  const i = Math.min(Math.floor(pos), stops.length - 2);
  const local = pos - i;
  return lerpHex(hexToRgb(stops[i]), hexToRgb(stops[i + 1]), local);
}

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

const LOGO = [
  '███╗   ███╗ █████╗ ██╗  ██╗███████╗███████╗████████╗██╗   ██╗██████╗ ██╗ ██████╗ ',
  '████╗ ████║██╔══██╗██║ ██╔╝██╔════╝██╔════╝╚══██╔══╝██║   ██║██╔══██╗██║██╔═══██╗',
  '██╔████╔██║███████║█████╔╝ █████╗  ███████╗   ██║   ██║   ██║██║  ██║██║██║   ██║',
  '██║╚██╔╝██║██╔══██║██╔═██╗ ██╔══╝  ╚════██║   ██║   ██║   ██║██║  ██║██║██║   ██║',
  '██║ ╚═╝ ██║██║  ██║██║  ██╗███████╗███████║   ██║   ╚██████╔╝██████╔╝██║╚██████╔╝',
  '╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝ ',
];

/**
 * Resolve the theme gradient stops. Falls back to default pink→cyan→violet
 * when the theme module isn't loadable (e.g. during unit tests that skip the
 * full REPL bootstrap).
 */
function gradientStops(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const theme = require('../repl/theme');
    const palette = theme.colors();
    if (Array.isArray(palette?.bannerGradient) && palette.bannerGradient.length >= 2) {
      return palette.bannerGradient;
    }
  } catch (err) { swallow(err); }
  return ['#F472B6', '#22D3EE', '#A78BFA'];
}

/**
 * Render the standard MakeStudio banner.
 * @param subtitle  Optional label for the current command ("New Project",
 *                  "Refinement", etc.) shown in yellow under the logo.
 */
export function printBanner(subtitle?: string): void {
  const stops = gradientStops();
  const grad = (s: string) => gradientLine(s, stops);
  const dim = chalk.hex('#64748B');
  const yellow = chalk.hex('#FBBF24').bold;

  const build = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();

  let plugins = 0;
  try {
    const { pluginRegistry } = require('../core/plugin-registry');
    plugins = pluginRegistry.count();
  } catch (err) { swallow(err); }

  const lines: string[] = [];
  lines.push('');
  for (const row of LOGO) lines.push(grad(row));
  lines.push('');
  lines.push(dim('Autonomous AI Development'));
  lines.push('');
  lines.push(
    chalk.hex('#FBBF24').bold(`v${VERSION}`) +
    dim(`  ·  build ${build}`) +
    (plugins > 0 ? dim(`  ·  ${plugins} plugins`) : ''),
  );
  lines.push(dim(`© 2024-${year} Z Software Consultoria  ·  MIT License`));
  if (subtitle) {
    lines.push('');
    lines.push(yellow('▸ ') + chalk.hex('#F1F5F9')(subtitle));
  }
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
}
