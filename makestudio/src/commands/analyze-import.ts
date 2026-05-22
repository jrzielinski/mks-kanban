import { swallow } from '../utils/log';
/**
 * `analyze` command — import module. Extracted from analyze.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import chalk from 'chalk';
import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';

const dim    = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green  = chalk.hex('#22C55E');
const cyan   = chalk.hex('#22D3EE');
const red    = chalk.hex('#EF4444');
const blue   = chalk.hex('#60A5FA');
import { enqueue } from '../core/offline-queue';
import { saveProjectLink } from '../core/project-prep';

import { logInfo, logSuccess, logError, logWarning, logTool } from '../ui/terminal';
import type { CodebaseAnalysis } from './analyze';


export async function sendAuditToProject(audit: any, projectId: string): Promise<void> {
  logInfo(`Enviando auditoria para projeto ${projectId.slice(0, 8)}...`);

  try {
    await ensureAuthenticated();
    const api = getApiClient();

    await api.post(`/dark-factory/projects/${projectId}/audit`, { audit });

    logSuccess(`Auditoria enviada para projeto ${chalk.bold(projectId.slice(0, 8))}`);
    logInfo('Findings importados como requisitos. Acesse o frontend para revisar.');
    console.log();
  } catch (err: any) {
    if (isNetworkError(err)) {
      enqueue({
        type: 'audit',
        method: 'POST',
        url: `/dark-factory/projects/${projectId}/audit`,
        body: { audit },
        description: `Auditoria → projeto ${projectId.slice(0, 8)}`,
      });
      // Save locally too
      saveResultLocally('audit', audit, projectId);
    } else {
      const msg = err.response?.data?.message || err.message;
      logError(`Falha ao enviar auditoria: ${msg}`);
    }
  }
}

export async function importAudit(audit: any, projectPath: string): Promise<void> {
  logInfo('Buscando projeto existente para este diretório...');

  try {
    await ensureAuthenticated();
    const api = getApiClient();

    // Try to find existing project by localPath
    const res = await api.get('/dark-factory/projects');
    const projects = Array.isArray(res.data) ? res.data : res.data?.data || [];
    const existing = projects.find(
      (p: any) => p.metadata?.localPath === projectPath,
    );

    if (existing) {
      // Send audit to existing project
      logInfo(`Projeto encontrado: ${chalk.bold(existing.name)} (${existing.id.slice(0, 8)})`);
      await sendAuditToProject(audit, existing.id);
      return;
    }

    // No existing project — create via import
    logInfo('Nenhum projeto encontrado para este diretório. Criando novo...');
    const response = await api.post('/dark-factory/projects/import', {
      analysis: {
        name: audit.projectName || path.basename(projectPath),
        stack: {},
        dependencies: [],
        entities: [],
        endpoints: [],
        components: [],
        patterns: [],
        description: `Projeto importado via auditoria. Score geral: ${audit.score?.overall || 'N/A'}/10`,
        summary: '',
      },
      localPath: projectPath,
    });

    const project = response.data;

    // Now send audit to the newly created project
    await sendAuditToProject(audit, project.id);

    logSuccess(`Projeto criado: ${chalk.bold(project.name)} (ID: ${project.id})`);
    logInfo(`Abrir no browser: ${chalk.underline(`https://www.zielinski.dev.br/dark-factory/${project.id}`)}`);
    console.log();
  } catch (err: any) {
    const msg = err.response?.data?.message || err.message;
    logError(`Falha ao importar auditoria: ${msg}`);
    process.exit(1);
  }
}

export async function importProjectUpdateOnly(analysis: CodebaseAnalysis, projectPath: string): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();
    const res = await api.get('/dark-factory/projects/by-path', {
      params: { path: projectPath },
      timeout: 10_000,
    });
    const existing = res.data || null;
    if (existing?.id) {
      logInfo(`Atualizando projeto existente: ${chalk.bold(existing.name)} (${existing.id.slice(0, 8)})...`);
      await sendToProject(analysis, existing.id);
    } else {
      logWarning('Projeto não encontrado no servidor — cache salvo localmente.');
      logWarning('Use --force para reanalisar e criar um novo projeto, ou --project-id <id> para vincular a um existente.');
    }
  } catch (err: any) {
    if (isNetworkError(err)) {
      logWarning('Sem conexão com o servidor — análise salva no cache local.');
    } else {
      logWarning(`Não foi possível sincronizar com o servidor: ${err.response?.data?.message || err.message}`);
    }
  }
}

export async function importProject(analysis: CodebaseAnalysis, projectPath: string): Promise<void> {
  logInfo('Verificando se projeto já existe para este diretório...');

  try {
    await ensureAuthenticated();
    const api = getApiClient();

    // Lightweight check by path (no metadata loaded)
    let existing: { id: string; name: string } | null = null;
    try {
      const res = await api.get('/dark-factory/projects/by-path', {
        params: { path: projectPath },
        timeout: 10_000,
      });
      existing = res.data || null;
    } catch (err) { swallow(err); }

    if (existing?.id) {
      logInfo(`Projeto existente encontrado: ${chalk.bold(existing.name)} (${existing.id.slice(0, 8)}). Atualizando...`);
      await sendToProject(analysis, existing.id);
      saveProjectLink(projectPath, { projectId: existing.id, projectName: existing.name, linkedAt: new Date().toISOString() });
      return;
    }

    // Create new project
    logInfo('Enviando análise para o MakeStudio...');
    const response = await api.post('/dark-factory/projects/import', {
      analysis,
      localPath: projectPath,
    }, { timeout: 60_000 });

    const project = response.data;
    logSuccess(`Projeto criado: ${chalk.bold(project.name)} (ID: ${project.id})`);
    logInfo(`Abrir no browser: ${chalk.underline(`https://www.zielinski.dev.br/dark-factory/${project.id}`)}`);
    // Save project link locally so `makestudio start` can find this project automatically
    saveProjectLink(projectPath, { projectId: project.id, projectName: project.name, linkedAt: new Date().toISOString() });
    logInfo(`Link salvo em ${projectPath}/.makestudio/project.json`);
    console.log();
  } catch (err: any) {
    if (isNetworkError(err)) {
      enqueue({
        type: 'import',
        method: 'POST',
        url: '/dark-factory/projects/import',
        body: { analysis, localPath: projectPath },
        description: `Importar projeto ${analysis.name}`,
      });
      saveResultLocally('analysis', analysis);
    } else {
      const msg = err.response?.data?.message || err.message;
      logError(`Falha ao importar projeto: ${msg}`);
    }
  }
}

export async function sendToProject(analysis: CodebaseAnalysis, projectId: string): Promise<void> {
  logInfo(`Atualizando projeto ${projectId.slice(0, 8)} com análise...`);

  try {
    await ensureAuthenticated();
    const api = getApiClient();

    await api.put(`/dark-factory/projects/${projectId}`, {
      metadata: { codebaseAnalysis: analysis },
    });

    logSuccess(`Projeto ${chalk.bold(projectId.slice(0, 8))} atualizado com análise`);
    console.log();
  } catch (err: any) {
    if (isNetworkError(err)) {
      enqueue({
        type: 'analysis-update',
        method: 'PUT',
        url: `/dark-factory/projects/${projectId}`,
        body: { metadata: { codebaseAnalysis: analysis } },
        description: `Análise → projeto ${projectId.slice(0, 8)}`,
      });
      saveResultLocally('analysis', analysis, projectId);
    } else {
      const msg = err.response?.data?.message || err.message;
      logError(`Falha ao atualizar projeto: ${msg}`);
    }
  }
}

export function isNetworkError(err: any): boolean {
  if (!err) return false;
  const code = err.code || '';
  const msg = (err.message || '').toLowerCase();
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ERR_NETWORK' ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    (!err.response && err.request) // axios: request made but no response
  );
}

export function saveResultLocally(type: string, data: any, projectId?: string): void {
  try {
    const dir = path.join(path.join(os.homedir(), '.makestudio'), 'results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `${type}-${projectId?.slice(0, 8) || 'new'}-${Date.now()}.json`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    logInfo(`Resultado salvo localmente: ${chalk.hex('#60A5FA')(filepath)}`);
  } catch (err) { swallow(err); }
}
