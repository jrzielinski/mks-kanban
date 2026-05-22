import { swallow } from '../utils/log';
/**
 * doctor.ts — `makestudio doctor` standalone command.
 *
 * Runs runtime smoke test across detected stacks (api/web/mobile) and
 * auto-fixes failures via local CLI. Useful to validate a boilerplate
 * or a project without needing to run the full `execute` pipeline.
 */

import * as os from 'os';
import { printBanner } from '../utils/banner';
import { detectInstalledCLIs } from '../core/cli-detector';
import { askProjectLocation } from '../core/workspace-resolver';
import { ensureAuthenticated } from '../network/auth';
import { getApiClient } from '../network/api-client';
import { runDoctor } from '../core/doctor';
import chalk from 'chalk';

const dim = chalk.hex('#64748B');
const cyan = chalk.hex('#22D3EE');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red = chalk.hex('#EF4444');

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer: string) => { rl.close(); resolve(answer.trim()); });
  });
}

export async function doctorCommand(options: {
  projectId?: string;
  cli?: string;
  deep?: boolean;
  skipFix?: boolean;
  maxPasses?: number;
  repo?: string;
}): Promise<void> {
  if (!process.env.MAKESTUDIO_REPL) printBanner('Doctor — Runtime Smoke Test');
  console.log(dim('│'));

  await ensureAuthenticated();
  const api = getApiClient();

  // Resolve CLI
  let selectedCli = options.cli?.toLowerCase();
  if (!selectedCli) {
    const installed = await detectInstalledCLIs();
    if (installed.length === 0) {
      console.log(`${dim('│')}  ${red('✗')} Nenhum CLI de IA encontrado.`);
      process.exit(1);
    }
    if (installed.length === 1) {
      selectedCli = installed[0].name;
    } else {
      console.log(`${dim('│')}  CLIs disponíveis:`);
      installed.forEach((c, i) => console.log(`${dim('│')}    ${dim(`${i + 1})`)} ${cyan(c.name)} ${dim(c.version)}`));
      console.log(dim('│'));
      const answer = await ask(`  Qual CLI usar para auto-fix? [número]: `);
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= installed.length) {
        console.log(`${dim('│')}  ${yellow('⚠')} Seleção inválida.`);
        process.exit(0);
      }
      selectedCli = installed[idx].name;
    }
  }

  // Resolve project (to get workspace path)
  let projectId = options.projectId;
  let projectName = '';

  if (!projectId) {
    try {
      const res = await api.get('/dark-factory/projects', { params: { limit: 50 }, timeout: 10_000 });
      const projects: any[] = res.data?.data || res.data?.projects || res.data || [];
      if (projects.length === 0) {
        console.log(`${dim('│')}  ${red('✗')} Nenhum projeto encontrado.`);
        return;
      }
      console.log(`${dim('│')}  Projetos disponíveis:`);
      console.log(dim('│'));
      projects.slice(0, 30).forEach((p: any, i: number) => {
        const hasSpec = p.specDocument?.enrichedAt ? green('✓ spec') : yellow('✗ spec');
        const statusLabel = dim(`· ${p.status || 'intake'}`);
        console.log(`${dim('│')}    ${dim(`${i + 1})`)} ${cyan(p.name)} ${dim(`(${p.id.slice(0, 8)})`)}  ${hasSpec}  ${statusLabel}`);
      });
      console.log(dim('│'));
      const answer = await ask(`  Qual projeto verificar? [número]: `);
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= projects.length || isNaN(idx)) {
        console.log(`${dim('│')}  ${yellow('⚠')} Seleção inválida.`);
        return;
      }
      projectId = projects[idx].id;
      projectName = projects[idx].name;
    } catch (err: any) {
      console.log(`${dim('│')}  ${red('✗')} Erro ao listar projetos: ${err.message}`);
      return;
    }
  } else {
    try {
      const res = await api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 });
      projectName = res.data?.name || projectId.slice(0, 8);
    } catch {
      projectName = projectId.slice(0, 8);
    }
  }

  console.log(`${dim('│')}  Projeto: ${cyan(projectName)}`);

  // Resolve workspace
  let project: any = {};
  try {
    const r = await api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 });
    project = r.data;
  } catch (err) { swallow(err); }

  const workspace = await askProjectLocation({
    projectId: projectId!,
    projectName,
    repoUrl: project?.repoUrl,
    repoBranch: project?.repoBranch,
    localPath: project?.metadata?.localPath,
    repoOverride: options.repo,
  });

  if (!workspace.hasCodebase || workspace.repoPath === os.tmpdir()) {
    console.log(`${dim('│')}  ${red('✗')} Workspace local não encontrado. Doctor precisa de código no disco.`);
    return;
  }

  // Run doctor
  const report = await runDoctor({
    repoPath: workspace.repoPath,
    cli: selectedCli!,
    deep: options.deep,
    maxPasses: options.maxPasses ?? 3,
    skipFix: options.skipFix,
  });

  console.log(dim('│'));
  if (report.passed) {
    console.log(`${dim('│')}  ${green('✓')} Doctor concluído com sucesso em ${report.passes} passada(s)`);
    process.exit(0);
  } else {
    console.log(`${dim('│')}  ${red('✗')} Doctor falhou após ${report.passes} passada(s)`);
    process.exit(1);
  }
}
