import { isJsonMode, emitSuccess } from '../utils/output-format';
import { swallow } from '../utils/log';
/**
 * plugin.ts
 *
 * CLI command for managing MakeStudio plugins.
 * Usage:
 *   makestudio plugin install <source>   — Install from npm, local path, or git
 *   makestudio plugin remove <name>      — Uninstall a plugin
 *   makestudio plugin list               — List installed plugins
 *   makestudio plugin enable <name>      — Enable a disabled plugin
 *   makestudio plugin disable <name>     — Disable a plugin without removing
 */

import chalk from 'chalk';
import { installPlugin, removePlugin, listPlugins, togglePlugin } from '../core/plugin-manager';

export async function pluginInstallCommand(source: string): Promise<void> {
  console.log(chalk.cyan(`Installing plugin from: ${source}...`));
  const manifest = await installPlugin(source);

  if (manifest) {
    console.log();
    console.log(chalk.green('✓ Plugin installed successfully:'));
    console.log(`  Name:    ${chalk.bold(manifest.name)}`);
    console.log(`  Version: ${manifest.version}`);
    console.log(`  Source:  ${manifest.source}`);
    console.log(`  Path:    ${chalk.dim(manifest.path)}`);
    console.log();
    console.log(chalk.dim('Restart the agent for the plugin to take effect.'));
  } else {
    console.log(chalk.red('✗ Failed to install plugin'));
    process.exitCode = 1;
  }
}

export async function pluginRemoveCommand(name: string): Promise<void> {
  console.log(chalk.cyan(`Removing plugin: ${name}...`));
  const success = removePlugin(name);

  if (success) {
    console.log(chalk.green(`✓ Plugin "${name}" removed successfully`));
  } else {
    console.log(chalk.red(`✗ Plugin "${name}" not found`));
    process.exitCode = 1;
  }
}

export function pluginListCommand(options: { json?: boolean } = {}): void {
  const plugins = listPlugins();  if (isJsonMode(options)) {    emitSuccess(plugins.map(p => ({      name: p.name,      version: p.version,      source: p.source,      enabled: p.enabled,    })));    return;  }

  if (plugins.length === 0) {
    console.log([
      chalk.dim('No plugins available.'),
      '',
      chalk.dim('Install one with:'),
      chalk.cyan('  makestudio plugin install <npm-package-or-local-path>'),
    ].join('\n'));
    return;
  }

  // Pull descriptions from the live registry (each MakeStudioPlugin has an
  // optional `description`). A plugin might not be loaded yet (e.g. disabled),
  // in which case we don't have a description — we show "—" instead of
  // a broken layout. `pluginRegistry` is required lazily so this file
  // doesn't pull the whole plugin graph when just listing manifests.
  const descByName = new Map<string, string>();
  try {
    const { pluginRegistry } = require('../core/plugin-registry');
    for (const p of pluginRegistry.getAll?.() || []) {
      if (p?.name && p.description) descByName.set(p.name, p.description);
    }
  } catch (err) { swallow(err); }

  const builtins = plugins.filter(p => (p.source as string) === 'builtin');
  const external = plugins.filter(p => (p.source as string) !== 'builtin');
  const enabledCount = plugins.filter(p => p.enabled).length;

  // Aligned name column — same width for every row so descriptions line up.
  const nameWidth = Math.max(
    ...plugins.map(p => p.name.length + ` v${p.version}`.length + 1),
    12,
  );

  const renderRow = (p: any): string => {
    const status = p.enabled ? chalk.green('●') : chalk.hex('#64748B')('○');
    const nameStr = p.enabled ? chalk.bold(p.name) : chalk.dim(p.name);
    const ver = chalk.dim(`v${p.version}`);
    const nameCol = `${nameStr} ${ver}`;
    // chalk escapes don't count toward the visible length — pad by the raw
    // display chars only, otherwise wide/bold names get over-padded.
    const visibleLen = `${p.name} v${p.version}`.length;
    const padding = ' '.repeat(Math.max(0, nameWidth - visibleLen));
    const desc = descByName.get(p.name);
    const descStr = desc ? chalk.dim(desc) : chalk.dim('—');
    return `  ${status} ${nameCol}${padding}  ${descStr}`;
  };

  const lines: string[] = [];
  lines.push(chalk.bold(`Plugins: ${enabledCount} enabled / ${plugins.length} total`));

  if (builtins.length > 0) {
    lines.push('');
    lines.push(chalk.hex('#E2E8F0').bold.underline('Built-in Plugins'));
    for (const p of builtins) lines.push(renderRow(p));
  }

  if (external.length > 0) {
    lines.push('');
    lines.push(chalk.hex('#E2E8F0').bold.underline('External Plugins'));
    for (const p of external) {
      lines.push(renderRow(p));
      lines.push(`    ${chalk.dim(`source: ${p.source}`)}`);
    }
  }

  lines.push('');
  lines.push(chalk.dim('Enable/disable: makestudio plugin enable <name> | makestudio plugin disable <name>'));

  // Single console.log — in the Ink TUI each console.log becomes a separate
  // `info` message with its own padding, which was causing the blank-line
  // gap between every plugin in the previous implementation. Joined with
  // \n it renders as one contiguous block.
  console.log(lines.join('\n'));
}

export function pluginEnableCommand(name: string): void {
  const success = togglePlugin(name, true);
  if (success) {
    console.log(chalk.green(`✓ Plugin "${name}" enabled`));
    console.log(chalk.dim('Restart the agent for changes to take effect.'));
  }
}

export function pluginDisableCommand(name: string): void {
  const success = togglePlugin(name, false);
  if (success) {
    console.log(chalk.yellow(`○ Plugin "${name}" disabled`));
    console.log(chalk.dim('Restart the agent for changes to take effect.'));
  }
}
