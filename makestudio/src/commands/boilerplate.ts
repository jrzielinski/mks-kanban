/**
 * boilerplate.ts
 *
 * makestudio boilerplate — manage the local boilerplate registry.
 *
 * Commands:
 *   makestudio boilerplate --list              List all registered boilerplates
 *   makestudio boilerplate --setup             Auto-register from ~/develop/boilerplates/
 *   makestudio boilerplate --setup <dir>       Auto-register from a custom directory
 *   makestudio boilerplate --add <slug> <path> Register a boilerplate manually
 *   makestudio boilerplate --remove <slug>     Remove a boilerplate
 *   makestudio boilerplate --test <stack>      Show which boilerplate would be selected
 */

import * as path from 'path';
import * as fs from 'fs';
import chalk from 'chalk';
import {
  getBoilerplates,
  addBoilerplate,
  removeBoilerplate,
  setupBoilerplates,
  findBestBoilerplate,
  detectBoilerplatesBaseDir,
  DEFAULT_BOILERPLATES,
} from '../core/boilerplate-registry';
import { loadConfig } from '../config/config';

const dim    = chalk.hex('#64748B');
const cyan   = chalk.hex('#22D3EE');
const green  = chalk.hex('#4ADE80');
const yellow = chalk.hex('#FBBF24');
const red    = chalk.hex('#F87171');
const white  = chalk.hex('#F1F5F9');
const bold   = chalk.bold;

function line(char = '─', width = 54) {
  return dim(char.repeat(width));
}

export async function boilerplateCommand(options: {
  list?: boolean;
  setup?: string | boolean;
  add?: string[];
  remove?: string;
  test?: string;
}): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log(red('✗ Não autenticado. Execute makestudio start primeiro.'));
    process.exit(1);
  }

  // ── --list ─────────────────────────────────────────────────────────────────
  if (options.list) {
    const boilerplates = getBoilerplates();
    console.log('');
    console.log(line());
    console.log(bold(white('  Boilerplates Registrados')));
    console.log(line());

    if (boilerplates.length === 0) {
      console.log(yellow('  Nenhum boilerplate registrado.'));
      console.log(dim('  Execute: makestudio boilerplate --setup'));
    } else {
      for (const b of boilerplates) {
        const exists = fs.existsSync(b.localPath);
        const status = exists ? green('✓') : red('✗ path não encontrado');
        const diff = b.difficultyMin !== undefined
          ? dim(` [nível ${b.difficultyMin}–${b.difficultyMax}]`)
          : '';
        console.log(`  ${status}  ${cyan(b.slug)}${diff}`);
        console.log(`     ${dim(b.localPath)}`);
        console.log(`     ${dim(b.stacks.join(', '))}`);
        console.log('');
      }
      console.log(line());
      console.log(dim(`  ${boilerplates.length} boilerplate(s) registrado(s)`));
    }
    console.log('');
    return;
  }

  // ── --setup ────────────────────────────────────────────────────────────────
  if (options.setup !== undefined) {
    const baseDir = typeof options.setup === 'string' && options.setup
      ? options.setup
      : detectBoilerplatesBaseDir();

    console.log('');
    console.log(line());
    console.log(bold(white('  Setup de Boilerplates')));
    console.log(line());

    if (!baseDir) {
      console.log(yellow('  Diretório de boilerplates não encontrado.'));
      console.log(dim('  Esperado: ~/develop/boilerplates'));
      console.log(dim('  Ou: makestudio boilerplate --setup <caminho>'));
      console.log('');
      process.exit(1);
    }

    console.log(`  ${dim('Diretório:')} ${cyan(baseDir)}`);
    console.log('');

    const { registered, skipped } = setupBoilerplates(baseDir);

    if (registered.length > 0) {
      console.log(green(`  ✓ ${registered.length} boilerplate(s) registrado(s):`));
      for (const name of registered) {
        console.log(`    ${green('+')} ${name}`);
      }
    } else {
      console.log(yellow('  Nenhum diretório encontrado em ' + baseDir));
    }

    console.log('');
    console.log(line());
    console.log(dim(`  Total: ${registered.length} registrado(s)`));
    console.log(dim('  Use: makestudio boilerplate --list para verificar'));
    console.log('');
    return;
  }

  // ── --add <slug> <path> ────────────────────────────────────────────────────
  if (options.add && options.add.length >= 2) {
    const [slug, localPath] = options.add;
    const resolved = path.resolve(localPath);

    if (!fs.existsSync(resolved)) {
      console.log(red(`✗ Caminho não encontrado: ${resolved}`));
      process.exit(1);
    }

    const def = DEFAULT_BOILERPLATES.find(b => b.slug === slug);
    const entry = {
      slug,
      name: def?.name || slug,
      localPath: resolved,
      stacks: def?.stacks || [],
      difficultyMin: def?.difficultyMin,
      difficultyMax: def?.difficultyMax,
      description: def?.description,
    };

    addBoilerplate(entry);
    console.log(green(`✓ Boilerplate "${slug}" registrado em ${resolved}`));
    return;
  }

  // ── --remove <slug> ────────────────────────────────────────────────────────
  if (options.remove) {
    const removed = removeBoilerplate(options.remove);
    if (removed) {
      console.log(green(`✓ Boilerplate "${options.remove}" removido.`));
    } else {
      console.log(yellow(`⚠ Boilerplate "${options.remove}" não encontrado.`));
    }
    return;
  }

  // ── --test <stack> ─────────────────────────────────────────────────────────
  if (options.test) {
    const parts = options.test.split(':');
    const stackStr = parts[0];
    const difficulty = parts[1] ? parseInt(parts[1], 10) : undefined;

    const match = findBestBoilerplate(stackStr, difficulty);
    console.log('');
    console.log(bold(white('  Teste de Matching')));
    console.log(dim(`  Stack: ${stackStr}`));
    if (difficulty !== undefined) console.log(dim(`  Nível: ${difficulty}`));
    console.log('');

    if (match) {
      console.log(green(`  ✓ Melhor match: ${cyan(match.slug)}`));
      console.log(dim(`    ${match.description || ''}`));
      console.log(dim(`    ${match.localPath}`));
    } else {
      console.log(yellow('  Nenhum boilerplate compatível encontrado.'));
      console.log(dim('  Verifique: makestudio boilerplate --list'));
    }
    console.log('');
    return;
  }

  // ── Help (no option) ──────────────────────────────────────────────────────
  console.log('');
  console.log(line());
  console.log(bold(white('  makestudio boilerplate')));
  console.log(line());
  console.log(`  ${cyan('--list')}              Lista boilerplates registrados`);
  console.log(`  ${cyan('--setup [dir]')}       Auto-registra de ~/develop/boilerplates/`);
  console.log(`  ${cyan('--add <slug> <path>')} Registra boilerplate manualmente`);
  console.log(`  ${cyan('--remove <slug>')}     Remove boilerplate`);
  console.log(`  ${cyan('--test <stack[:nível]>')}  Testa qual boilerplate seria usado`);
  console.log('');
  console.log(dim('  Exemplos:'));
  console.log(dim('    makestudio boilerplate --setup'));
  console.log(dim('    makestudio boilerplate --test "NestJS,React,PostgreSQL:10"'));
  console.log(dim('    makestudio boilerplate --test "Flutter,NestJS:13"'));
  console.log('');
}
