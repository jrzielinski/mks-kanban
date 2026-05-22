import { swallow } from '../utils/log';
/**
 * `analyze` command — requirements module. Extracted from analyze.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import chalk from 'chalk';
import { getApiClient } from '../network/api-client';

const dim    = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green  = chalk.hex('#22C55E');
const cyan   = chalk.hex('#22D3EE');
const red    = chalk.hex('#EF4444');
const blue   = chalk.hex('#60A5FA');
import { saveProjectLink } from '../core/project-prep';

import { detectInstalledCLIs } from '../core/cli-detector';
import { runSinglePass } from './analyze-cli';
import { ensureAuthenticated } from '../network/auth';
import { findBestBoilerplate, copyBoilerplate } from '../core/boilerplate-registry';
import { saveResultLocally, isNetworkError } from './analyze-import';
import { saveCache } from './analyze-cache';

import { logInfo, logSuccess, logError, logWarning, logTool } from '../ui/terminal';
import type { CodebaseAnalysis } from './analyze';


export function buildRequirementsPrompt(project: any): string {
  const stack = Array.isArray(project.stack) ? project.stack.join(', ') : (project.stack || 'não especificado');
  const briefing = project.briefing || project.description || project.name;

  return `IDIOMA OBRIGATÓRIO: Responda TUDO em Português Brasileiro (PT-BR). Nenhuma palavra em inglês nas saídas JSON.

You are a senior software analyst. Analyze the project below and generate a comprehensive list of software requirements.

PROJECT NAME: ${project.name}
TECH STACK: ${stack}
BRIEFING:
${briefing}

Generate a JSON array of requirements. Cover ALL functional areas of the system.
Be specific, detailed and complete. Include at minimum 20-40 requirements.

CRITICAL: Do NOT use any tools. Do NOT write any files. Output ONLY the JSON array — nothing else before or after it.

JSON format:
[
  {
    "title": "Título do requisito em PT-BR",
    "description": "Descrição detalhada em PT-BR explicando o que deve ser implementado",
    "type": "functional",
    "priority": "high",
    "tag": "backend",
    "acceptanceCriteria": [
      "DADO que... QUANDO... ENTÃO...",
      "DADO que... QUANDO... ENTÃO..."
    ]
  }
]

Values for "type": functional | non-functional | security | performance | ux
Values for "priority": critical | high | medium | low
Values for "tag": backend | frontend | mobile | mixed | database | security | integration

Output the JSON array only. No markdown, no explanation, no code blocks.`;
}

export function extractRequirementsFromOutput(rawOutput: string, _runStart: number): any[] {
  if (!rawOutput) return [];

  // Try to find JSON array in output
  const attempts = [
    // Direct parse
    () => {
      const trimmed = rawOutput.trim();
      if (trimmed.startsWith('[')) return JSON.parse(trimmed);
      return null;
    },
    // Extract from code block
    () => {
      const match = rawOutput.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
      if (match) return JSON.parse(match[1]);
      return null;
    },
    // Find first [ to last ]
    () => {
      const start = rawOutput.indexOf('[');
      const end = rawOutput.lastIndexOf(']');
      if (start >= 0 && end > start) return JSON.parse(rawOutput.slice(start, end + 1));
      return null;
    },
  ];

  for (const attempt of attempts) {
    try {
      const result = attempt();
      if (Array.isArray(result) && result.length > 0) return result;
    } catch (err) { swallow(err); }
  }

  return [];
}

export async function generateRequirementsWithCLI(
  project: any,
  targetPath: string,
  projectId: string,
): Promise<number> {
  const clis = await detectInstalledCLIs();
  const cliInfo = clis.find(c => c.name === 'claude') || clis.find(c => c.name === 'codex') || clis[0];

  if (!cliInfo) {
    logWarning('Nenhuma CLI de IA encontrada para gerar requisitos. Instale claude, codex ou gemini.');
    return 0;
  }

  logInfo(`\nGerando requisitos com ${chalk.bold(cliInfo.name)}...`);
  logInfo(`Projeto: ${chalk.bold(project.name)}\n`);

  const prompt = buildRequirementsPrompt(project);
  const runStart = Date.now();

  let rawOutput = '';
  try {
    const result = await runSinglePass(targetPath, prompt, '60', cliInfo, {});
    rawOutput = result.output;
  } catch (err: any) {
    logWarning(`Falha na geração de requisitos via CLI: ${err.message}`);
    return 0;
  }

  const requirements = extractRequirementsFromOutput(rawOutput, runStart);

  if (requirements.length === 0) {
    logWarning('Nenhum requisito extraído da saída da CLI.');
    return 0;
  }

  logInfo(`${requirements.length} requisito(s) gerado(s). Salvando no servidor...`);

  const api = getApiClient();
  let saved = 0;

  for (const req of requirements) {
    if (!req.title?.trim()) continue;
    try {
      await api.post(`/dark-factory/analyst/requirements/${projectId}`, {
        title: req.title.trim(),
        description: req.description || '',
        type: req.type || 'functional',
        priority: req.priority || 'medium',
        tag: req.tag || 'mixed',
        acceptanceCriteria: req.acceptanceCriteria || [],
      });
      saved++;
    } catch (err: any) {
      logWarning(`Falha ao salvar "${req.title}": ${err.message}`);
    }
  }

  if (saved > 0) {
    logSuccess(`${saved} requisito(s) salvos no projeto.`);
  }
  return saved;
}

export async function analyzeNewProject(targetPath: string, projectId: string): Promise<void> {
  logInfo(`Novo projeto detectado — buscando especificação no servidor...`);

  await ensureAuthenticated();
  const api = getApiClient();

  let project: any;
  try {
    const res = await api.get(`/dark-factory/projects/${projectId}`, { timeout: 15_000 });
    project = res.data;
  } catch (err: any) {
    logError(`Falha ao buscar projeto ${projectId.slice(0, 8)}: ${err.message}`);
    process.exit(1);
  }

  const projectName: string = project.name || 'New Project';
  const stack = project.stack || {};
  const briefing: string = project.briefing || project.description || '';

  logInfo(`Projeto: ${chalk.bold(projectName)}`);
  logInfo(`Stack: ${[
    ...(stack.backend || []),
    ...(stack.frontend || []),
    ...(stack.mobile || []),
    ...(stack.database || []),
  ].join(', ') || 'não especificada'}`);

  // ── Scaffold git repo at targetPath (from boilerplate if available) ──
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }

  const { execSync } = require('child_process') as typeof import('child_process');
  const isGit = fs.existsSync(path.join(targetPath, '.git'));

  if (!isGit) {
    // Try to find a matching boilerplate
    const stackStr = [
      ...(stack.backend || []),
      ...(stack.frontend || []),
      ...(stack.mobile || []),
      ...(stack.database || []),
    ].join(', ');

    const boilerplate = stackStr ? findBestBoilerplate(stackStr, project.difficultyLevel) : null;

    if (boilerplate) {
      logInfo(`Boilerplate encontrado: ${chalk.bold(boilerplate.name)} (${boilerplate.slug})`);
      logInfo(`Copiando de ${boilerplate.localPath}...`);
      try {
        copyBoilerplate(boilerplate, targetPath);
        logSuccess(`Boilerplate copiado: ${boilerplate.slug}`);
      } catch (err: any) {
        logWarning(`Falha ao copiar boilerplate: ${err.message}. Usando scaffold vazio.`);
      }
    } else {
      if (stackStr) {
        logInfo(`Nenhum boilerplate para "${stackStr}" — execute: makestudio boilerplate --setup`);
      }
      // Minimal scaffold: just a README
      fs.writeFileSync(
        path.join(targetPath, 'README.md'),
        `# ${projectName}\n\nProject scaffolded by MakeStudio.\n`,
      );
    }

    // Git init
    const darkfactoryDir = path.join(targetPath, '.darkfactory');
    if (!fs.existsSync(darkfactoryDir)) fs.mkdirSync(darkfactoryDir);

    try {
      execSync('git init -b main', { cwd: targetPath, stdio: 'pipe' });
    } catch {
      try {
        execSync('git init', { cwd: targetPath, stdio: 'pipe' });
        execSync('git checkout -b main', { cwd: targetPath, stdio: 'pipe' });
      } catch (err) { swallow(err); }
    }
    try {
      execSync('git config user.email "agent@makestudio.local"', { cwd: targetPath, stdio: 'pipe' });
      execSync('git config user.name "MakeStudio Agent"', { cwd: targetPath, stdio: 'pipe' });
      execSync('git add .', { cwd: targetPath, stdio: 'pipe' });
      const commitMsg = boilerplate
        ? `init: scaffold from boilerplate ${boilerplate.slug}`
        : 'init: MakeStudio project scaffold';
      execSync(`git commit -m "${commitMsg}"`, { cwd: targetPath, stdio: 'pipe' });
    } catch (err) { swallow(err); }

    logSuccess(`Repositório inicializado em ${targetPath}${boilerplate ? ` (${boilerplate.slug})` : ''}`);
  }

  // ── Build synthetic CodebaseAnalysis from briefing + stack ──
  const syntheticAnalysis: CodebaseAnalysis = {
    name: projectName,
    stack,
    dependencies: [],
    entities: [],
    endpoints: [],
    components: [],
    patterns: ['new-project'],
    description: briefing
      ? briefing.substring(0, 500)
      : `Novo projeto: ${projectName}. Estrutura inicial sendo criada.`,
    summary: briefing
      ? `Novo projeto "${projectName}" com especificação completa. Stack: ${
          [...(stack.backend || []), ...(stack.frontend || []), ...(stack.mobile || [])].join(', ') || 'a definir'
        }. Pronto para geração de DUMs.`
      : `Novo projeto "${projectName}" sem código ainda. Aguardando geração de DUMs.`,
  };

  // Save to cache so subsequent calls skip the AI CLI
  saveCache(targetPath, syntheticAnalysis);
  logSuccess(`Análise sintética gerada para "${projectName}"`);

  // ── Save localPath to backend so future dispatches use correct directory ──
  try {
    await api.put(`/dark-factory/projects/${projectId}`, {
      metadata: { localPath: targetPath, codebaseAnalysis: syntheticAnalysis },
    });
    logSuccess(`localPath salvo no servidor: ${targetPath}`);
    saveProjectLink(targetPath, { projectId, projectName, linkedAt: new Date().toISOString() });
  } catch (err: any) {
    logWarning(`Falha ao salvar localPath: ${err.message}`);
  }

  // ── Generate requirements using local AI CLI (Claude/Codex/Gemini) ──
  // analystStrategy='makestudio' means the local agent handles everything — no backend LLM API
  const reqCount = await generateRequirementsWithCLI(project, targetPath, projectId);

  // Notify backend: analysis complete → advances pipeline (decomposition starts)
  try {
    await api.post(`/dark-factory/projects/${projectId}/notify-analysis-complete`, {
      requirementsCreated: reqCount,
    });
    if (reqCount > 0) {
      logSuccess(`Pipeline avançado — ${reqCount} requisito(s) gerado(s). Execute DUMs com: makestudio start`);
    } else {
      logWarning(`0 requisitos gerados. Verifique o briefing do projeto e tente novamente.`);
    }
  } catch (err: any) {
    logWarning(`Falha ao notificar backend: ${err.message}`);
  }
}
