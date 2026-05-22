/**
 * attach-boilerplate.ts — anexa um boilerplate em um projeto JÁ EXISTENTE.
 *
 * O `makestudio new` só serve pra projeto do zero. Quando o projeto já foi
 * criado no backend (status `intake` por exemplo) e ainda não tem
 * `boilerplateId` setado, esse comando preenche o gap:
 *
 *   1. PUT /dark-factory/projects/:id { boilerplateId }
 *   2. (opcional --create-repo) POST /:id/repo/create — bootstrap do repo
 *   3. (opcional --re-analyze)   POST /:id/start-analysis — refaz DUMs
 *
 * Suporta IDs parciais (prefixo) pra projeto e prefixo pra slug do
 * boilerplate, e cai pra menu interativo se faltar argumento. Sem
 * `--git-token` o create-repo usa o agent local (gh auth) via
 * `/repo/create-via-agent`.
 */
import * as readline from 'readline';
import chalk from 'chalk';
import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logSuccess, logError, logWarning, logDivider } from '../ui/terminal';

const dim = chalk.hex('#64748B');
const cyan = chalk.hex('#22D3EE');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

export interface AttachBoilerplateOptions {
  reAnalyze?: boolean;
  createRepo?: boolean;
  owner?: string;
  name?: string;
  gitToken?: string;
  private?: boolean;
}

export async function attachBoilerplateCommand(
  projectIdArg: string | undefined,
  slugArg: string | undefined,
  options: AttachBoilerplateOptions,
): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    // ── 1. Resolve project ───────────────────────────────────────
    const project = await pickProject(api, projectIdArg);
    if (!project) return;
    const projectId: string = project.id;

    // ── 2. Resolve boilerplate ───────────────────────────────────
    const boilerplate = await pickBoilerplate(api, slugArg);
    if (!boilerplate) return;
    const slug: string = boilerplate.id;

    // ── 3. Confirm summary ───────────────────────────────────────
    logDivider();
    console.log(`  ${dim('Projeto:')}     ${chalk.white.bold(project.name)} ${dim(`(${project.id.slice(0, 8)})`)}`);
    console.log(`  ${dim('Status:')}      ${project.status}`);
    console.log(`  ${dim('Boilerplate:')} ${cyan(slug)} ${dim(`level ${boilerplate.level}`)}`);
    if (project.boilerplateId && project.boilerplateId !== slug) {
      console.log(`  ${yellow('!')} ${dim('Já tem boilerplate:')} ${project.boilerplateId} ${dim('(será sobrescrito)')}`);
    }
    if (options.createRepo) {
      console.log(`  ${dim('Repo:')}        ${cyan(`${options.owner || '?'}/${options.name || project.name}`)} ${dim(options.gitToken ? '(via PAT)' : '(via agent local gh auth)')}`);
    }
    if (options.reAnalyze) {
      console.log(`  ${dim('Re-analyze:')}  ${yellow('sim')} ${dim('(vai refazer DUMs)')}`);
    }
    logDivider();

    if (!process.env.MAKESTUDIO_NONINTERACTIVE) {
      const ans = (await ask(`  Confirmar? ${dim('[S/n]')}: `)).toLowerCase();
      if (ans === 'n' || ans === 'no') {
        logInfo('Cancelado.');
        return;
      }
    }

    // ── 4. PUT boilerplateId ─────────────────────────────────────
    process.stdout.write(`  ${dim('→')} Atualizando projeto... `);
    try {
      await api.put(`/dark-factory/projects/${projectId}`, { boilerplateId: slug });
      console.log(green('✓'));
    } catch (err: any) {
      console.log(chalk.red('✗'));
      logError(err?.response?.data?.message || err.message);
      process.exit(1);
    }

    // ── 5. Optional: bootstrap repo ──────────────────────────────
    if (options.createRepo) {
      const owner = options.owner;
      const repoName = options.name || project.name?.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      if (!owner || !repoName) {
        logError('--create-repo precisa de --owner e (--name ou nome do projeto compatível).');
        process.exit(1);
      }

      process.stdout.write(`  ${dim('→')} Bootstrapando repo no GitHub... `);
      try {
        if (options.gitToken) {
          const { data } = await api.post(`/dark-factory/projects/${projectId}/repo/create`, {
            owner,
            name: repoName,
            private: options.private !== false,
            gitToken: options.gitToken,
          });
          console.log(green('✓'));
          console.log(`     ${dim('repo:')} ${cyan(data.repoUrl)} ${dim(`branch ${data.branch}`)}`);
        } else {
          const { data } = await api.post(`/dark-factory/projects/${projectId}/repo/create-via-agent`, {
            owner,
            name: repoName,
            private: options.private !== false,
          });
          if (!data.success) {
            console.log(chalk.red('✗'));
            logError(data.message || 'Falha no agent local');
            process.exit(1);
          }
          console.log(green('✓'));
          console.log(`     ${dim('repo:')} ${cyan(data.repoUrl)} ${dim(`branch ${data.branch}`)}`);
        }
      } catch (err: any) {
        console.log(chalk.red('✗'));
        logError(err?.response?.data?.message || err.message);
        process.exit(1);
      }
    }

    // ── 6. Optional: re-run analyst ──────────────────────────────
    if (options.reAnalyze) {
      process.stdout.write(`  ${dim('→')} Rodando analyst (pode levar 2-10min)... `);
      try {
        const { data } = await api.post(
          `/dark-factory/projects/${projectId}/start-analysis`,
          { automationLevel: 'full' },
          { timeout: 20 * 60 * 1000 },
        );
        console.log(green('✓'));
        const reqs = data?.requirementsCreated ?? data?.requirements?.length ?? '?';
        const dums = data?.dumCreated ?? data?.dums?.length ?? '?';
        console.log(`     ${dim('requisitos:')} ${reqs}  ${dim('DUMs:')} ${dums}`);
      } catch (err: any) {
        console.log(chalk.red('✗'));
        logWarning(`analyst falhou: ${err?.response?.data?.message || err.message}`);
        logInfo(`Rodar manual: makestudio refine --project-id ${projectId}`);
      }
    }

    logDivider();
    logSuccess(`Boilerplate ${cyan(slug)} anexado em ${chalk.bold(project.name)}.`);
    if (!options.createRepo && !project.repoUrl) {
      console.log(`  ${dim('Próximo:')} ${cyan(`makestudio attach-boilerplate ${projectId.slice(0, 8)} ${slug} --create-repo --owner <gh-owner>`)}`);
    } else if (!options.reAnalyze) {
      console.log(`  ${dim('Próximo:')} ${cyan(`makestudio refine --project-id ${projectId}`)} ${dim('# refaz spec/DUMs com o boilerplate')}`);
      console.log(`  ${dim('  ou:')}    ${cyan(`makestudio execute --project-id ${projectId}`)}`);
    }
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

async function pickProject(api: any, idArg: string | undefined): Promise<any | null> {
  // Full UUID → fetch direct (1 row from DB, not the whole tenant's list).
  if (idArg && idArg.length === 36) {
    try {
      const { data } = await api.get(`/dark-factory/projects/${idArg}`);
      return data;
    } catch {
      logError(`Projeto não encontrado: ${idArg}`);
      return null;
    }
  }

  // Partial id OR free-text search → push the filter down to the backend
  // (?idPrefix=…&q=…&limit=20) so we don't drag the whole tenant's project
  // list across the wire just to filter client-side.
  let candidates: any[];
  if (idArg) {
    const looksLikeUuidPrefix = /^[0-9a-fA-F-]+$/.test(idArg);
    const params = new URLSearchParams();
    if (looksLikeUuidPrefix) params.set('idPrefix', idArg);
    else params.set('q', idArg);
    params.set('limit', '20');

    const { data } = await api.get(`/dark-factory/projects?${params.toString()}`);
    candidates = Array.isArray(data) ? data : (data.projects || data.data || []);

    // A short hex token can also be a substring of a name (e.g. "ekkle"
    // is a 5-char string but isn't a UUID prefix). If the prefix path
    // came back empty, retry as a name search before giving up.
    if (candidates.length === 0 && looksLikeUuidPrefix) {
      const fb = new URLSearchParams({ q: idArg, limit: '20' });
      const { data: d2 } = await api.get(`/dark-factory/projects?${fb.toString()}`);
      candidates = Array.isArray(d2) ? d2 : (d2.projects || d2.data || []);
    }

    if (candidates.length === 0) {
      logError(`Nenhum projeto bateu com "${idArg}".`);
      return null;
    }
    if (candidates.length === 1) return candidates[0];
  } else {
    // Fully interactive: show the 20 most recent projects, not the whole
    // tenant. If you have more than 20 and the one you want isn't here,
    // pass a search term: `attach-boilerplate <prefix-or-name>`.
    const { data } = await api.get('/dark-factory/projects?limit=20');
    candidates = Array.isArray(data) ? data : (data.projects || data.data || []);
    if (candidates.length === 0) {
      logWarning('Nenhum projeto. Crie com: makestudio new');
      return null;
    }
  }

  console.log(dim('  Projetos:'));
  candidates.forEach((p: any, i: number) => {
    const tag = p.boilerplateId ? dim(` · boil=${p.boilerplateId}`) : dim(' · sem boilerplate');
    console.log(`    ${chalk.bold(`${i + 1})`)} ${chalk.white(p.name)} ${dim(p.id.slice(0, 8))} ${dim(`(${p.status})`)}${tag}`);
  });
  const ans = (await ask(`  Escolha ${dim(`[1-${candidates.length}]`)}: `)).trim();
  const idx = parseInt(ans, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > candidates.length) {
    logInfo('Cancelado.');
    return null;
  }
  return candidates[idx - 1];
}

async function pickBoilerplate(api: any, slugArg: string | undefined): Promise<any | null> {
  const { data } = await api.get('/dark-factory/boilerplates');
  const all = Array.isArray(data) ? data : (data.boilerplates || data.data || []);
  if (all.length === 0) {
    logError('Nenhum boilerplate registrado no backend.');
    return null;
  }

  if (slugArg) {
    const exact = all.find((b: any) => b.id === slugArg);
    if (exact) return exact;
    const matches = all.filter((b: any) => b.id.startsWith(slugArg));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      logError(`Nenhum boilerplate bateu com "${slugArg}".`);
      logInfo('Disponíveis: ' + all.map((b: any) => b.id).join(', '));
      return null;
    }
    // ambíguo — cai pro menu
  }

  const candidates = slugArg ? all.filter((b: any) => b.id.startsWith(slugArg)) : all;
  console.log(dim('  Boilerplates:'));
  candidates.forEach((b: any, i: number) => {
    console.log(`    ${chalk.bold(`${i + 1})`)} ${cyan(b.id)} ${dim(`level ${b.level}`)} ${dim('-')} ${b.name}`);
  });
  const ans = (await ask(`  Escolha ${dim(`[1-${candidates.length}]`)}: `)).trim();
  const idx = parseInt(ans, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > candidates.length) {
    logInfo('Cancelado.');
    return null;
  }
  return candidates[idx - 1];
}
