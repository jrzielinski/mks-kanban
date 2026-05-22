import { swallow } from '../utils/log';
/**
 * Refine pipeline — decompose topic. Extracted from refine.ts.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import chalk from 'chalk';
import { getApiClient } from '../network/api-client';

const dim = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green = chalk.hex('#22C55E');
const cyan = chalk.hex('#22D3EE');
const red = chalk.hex('#EF4444');
const blue = chalk.hex('#60A5FA');
import type { WorkspaceResolution } from '../core/workspace-resolver';
import { writeContextFiles, ensureGitignore } from '../core/context-writer';
import { getCLICommand } from '../core/cli-detector';

export async function runDecompose(
  api: any,
  projectId: string,
  requirementIds: string[],
  label: string,
  cli?: string,
  workspace?: WorkspaceResolution,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  // Honor cancellation from the WebSocket dispatcher (decomposition:cancel
  // event). Without this opt-in signal the agent would burn the full
  // budget after the operator clicked cancel in the frontend.
  const checkAborted = () => {
    if (opts?.signal?.aborted) {
      const err = new Error('Decomposition cancelled by user');
      (err as any).aborted = true;
      throw err;
    }
  };
  checkAborted();
  const dim    = chalk.hex('#64748B');
  const green  = chalk.hex('#22C55E');
  const red    = chalk.hex('#EF4444');
  const yellow = chalk.hex('#FBBF24');
  const cyan   = chalk.hex('#22D3EE');

  // 1. Fetch FULL decomposition context from backend (same 14 sections as LLM API)
  let fullContext: any = {};
  try {
    const ctxRes = await api.get(`/dark-factory/projects/${projectId}/decomposition-context`, { timeout: 20_000 });
    fullContext = ctxRes.data || {};
  } catch (err: any) {
    // Fallback: fetch prompts + project separately
    console.log(`${dim('│')}  ${yellow('⚠')} ${dim(`Contexto completo indisponível (${err.message}), usando fallback`)}`);
    try {
      const [promptRes, projRes] = await Promise.all([
        api.get(`/dark-factory/projects/${projectId}/decomposition-prompt`, { timeout: 10_000 }),
        api.get(`/dark-factory/projects/${projectId}`, { timeout: 8_000 }),
      ]);
      const proj = projRes.data || {};
      // Detect language from project briefing + name (same logic as backend)
      const langSample = [proj.briefing || '', proj.description || '', proj.name || ''].join(' ').substring(0, 500).toLowerCase();
      const looksPortuguese = /\b(para|com|uma|que|sistema|produto|usuário|projeto|módulo|cliente|cadastro|gestão|serviço|funcionalidade|requisito)\b/.test(langSample);
      const looksSpanish = /\b(para|con|una|que|sistema|producto|usuario|proyecto|módulo|cliente|gestión|servicio)\b/.test(langSample) && !looksPortuguese;
      const fallbackLang = looksPortuguese ? 'Brazilian Portuguese (pt-BR)' : looksSpanish ? 'Spanish (es)' : 'English (en)';
      // Inject explicit language into systemPrompt
      let sysPrompt = promptRes.data?.systemPrompt || '';
      if (sysPrompt) {
        sysPrompt = sysPrompt.replace(
          /ALWAYS write in the SAME LANGUAGE[^.]*\./i,
          `ALL output MUST be written in ${fallbackLang}. This includes: DUM titles, descriptions, task titles, task descriptions, acceptance criteria, and mermaid diagram labels. NEVER write in any other language.`,
        );
      }
      fullContext = {
        project: proj,
        outputLanguage: fallbackLang,
        systemPrompt: sysPrompt,
        instructionPrompt: promptRes.data?.instructionPrompt || '',
      };
    } catch (err) { swallow(err); }
  }

  const project = fullContext.project || {};
  const decompositionRules = (fullContext.systemPrompt && fullContext.instructionPrompt)
    ? `${fullContext.systemPrompt}\n\n${fullContext.instructionPrompt}`
    : '';

  // 2. Get requirements (from context or fetch separately)
  let reqsData: any[] = fullContext.requirements || [];
  if (reqsData.length === 0) {
    try {
      const r = await api.get(`/dark-factory/analyst/requirements/${projectId}`, { timeout: 8_000 });
      const raw = r.data;
      reqsData = Array.isArray(raw) ? raw : Array.isArray(raw?.requirements) ? raw.requirements : [];
    } catch (err) { swallow(err); }
  }
  // Save ALL requirements before filtering (used for DUM-001 master + infra DUM context)
  const allReqsData = [...reqsData];
  // Filter to requested requirement IDs
  if (requirementIds.length > 0 && reqsData.length > 0) {
    reqsData = reqsData.filter((req: any) => requirementIds.includes(req.id));
  }

  if (reqsData.length === 0) {
    console.log(`${dim('│')}  ${red('✗')} ${dim(`${label}: nenhum requisito encontrado`)}`);
    return;
  }

  // 3. Existing DUMs (from context or fetch separately)
  let existingDumsRaw: any[] = fullContext.existingDums || [];
  if (existingDumsRaw.length === 0) {
    try {
      const r = await api.get(`/dark-factory/dums/project/${projectId}`, { timeout: 8_000 });
      existingDumsRaw = r.data?.dums || r.data || [];
    } catch (err) { swallow(err); }
  }

  // 4. Determine working directory
  const hasRepo = workspace?.hasCodebase && workspace.repoPath !== os.tmpdir();
  const cwd = hasRepo ? workspace!.repoPath : os.tmpdir();

  // 4.5 Ensure QUALITY_CONTRACT.md is present in the project. The contract
  //     is the persistent ISO/IEC/IEEE 29148 manual the CLI sees on every
  //     operation in this project — same role CLAUDE.md plays for Claude
  //     Code. Best-effort: failure to fetch does not block decomposition,
  //     since the prompt-embedded contract still applies.
  try {
    const { ensureQualityContract } = require('../decompose/quality-contract');
    const result = await ensureQualityContract(api, projectId, cwd);
    if (result.written) {
      console.log(`${dim('│')}  ${green('✓')} ${dim(`QUALITY_CONTRACT.md ${result.reason}`)}`);
    } else if (result.reason !== 'cached' && !result.reason.startsWith('cached')) {
      console.log(`${dim('│')}  ${yellow('⚠')} ${dim(`QUALITY_CONTRACT.md skipped: ${result.reason}`)}`);
    }
  } catch (err: any) {
    console.log(`${dim('│')}  ${yellow('⚠')} ${dim(`QUALITY_CONTRACT.md hook failed: ${err.message}`)}`);
  }

  // 4.6 Per-requirement agentic decomposition (default — only path).
  //     Each requirement gets its own focused CLI session with bounded
  //     context, runs the two-pass (structure → enrich) flow, validates
  //     the output against the gate, and re-prompts on failure (max 2
  //     retries per requirement). The CLI sees QUALITY_CONTRACT.md +
  //     the list of existing DUMs and avoids duplication.
  //
  //     Works for every supported CLI (claude, codex, gemini, makestudio).
  //     The legacy single-call path was removed because it produced shallow
  //     stubs on smaller-context providers and couldn't recover from quality
  //     gate failures.
  {
    const { runPerRequirementLoop } = require('../decompose/per-requirement-loop');
    console.log(`${dim('│')}  ${cyan('◆')} ${dim('Per-requirement decomposition (two-pass)')}`);

    // Refresh context files (briefing/stack/boilerplate.md+sigs/etc) so the
    // CLI sees the up-to-date markdown summaries before each per-req call.
    // Without this, leftover stale files from a previous run slip through.
    try {
      const baseBoilerplate = fullContext.boilerplateContext || null;
      let enrichedBoilerplate: string | null = baseBoilerplate;
      try {
        const { extractBoilerplateSignatures } = require('../decompose/boilerplate-signatures');
        const sigs = extractBoilerplateSignatures(cwd);
        if (sigs) enrichedBoilerplate = baseBoilerplate ? `${baseBoilerplate}\n\n${sigs}` : sigs;
      } catch (err) { swallow(err); }

      const ctxData = {
        projectName: project.name || 'Unknown',
        briefing: project.briefing || project.description || '',
        specDocument: project.specDocument || undefined,
        requirements: reqsData.map((r: any) => ({
          id: r.id,
          title: r.title || r.name || '',
          description: r.description || '',
          type: r.type || r.category || 'functional',
          priority: r.priority || 'medium',
          tag: r.tag,
          source: r.source,
          acceptanceCriteria: r.acceptanceCriteria,
        })),
        stack: project.stack || fullContext.stack || undefined,
        existingDums: existingDumsRaw.map((d: any) => ({
          id: d.id,
          title: d.title || '',
          dumNumber: d.dumNumber,
          description: d.description?.substring(0, 500),
          tasks: (d.tasks || []).map((t: any) => typeof t === 'string' ? t : t.title || t.name || ''),
        })),
        existingDumsRaw,
        codebaseAnalysis: project.metadata?.codebaseAnalysis || undefined,
        decompositionRules: decompositionRules || undefined,
        boilerplateContext: enrichedBoilerplate,
        decisions: fullContext.decisions || [],
        designSystem: fullContext.designSystem || null,
        clarifications: fullContext.clarifications || [],
        textResults: fullContext.textResults || [],
        imageResults: fullContext.imageResults || [],
        flowBuilderContext: fullContext.flowBuilderContext || null,
      };
      const ctxResult = await writeContextFiles(cwd, ctxData);
      if (hasRepo) ensureGitignore(cwd);
      console.log(`${dim('│')}  ${dim(`Contexto: ${ctxResult.files.length} arquivos (${ctxResult.totalSizeKB}KB)`)}`);
    } catch (err: any) {
      console.log(`${dim('│')}  ${yellow('⚠')} ${dim(`Falha ao gravar contexto: ${err.message}`)}`);
    }

    const cliCmdName = getCLICommand(cli || 'claude');
    const cliArgsForLoop: string[] = [];
    const cliName = cli || 'claude';
    if (cliName === 'claude') {
      // Simple invocation — manual `claude -p ... < prompt` runs in ~10s.
      // Adding --output-format stream-json + --verbose + --max-turns + --model
      // empirically slows it to 5-10 minutes per call. We don't need them:
      // - We read DUM files from disk, not parse stream-json output.
      // - claude's default tool budget is sufficient for read-4-files + write-1-DUM.
      // - Default model is whatever the user's OAuth picks; that's fine.
      cliArgsForLoop.push('-p', '--dangerously-skip-permissions');
    } else if (cliName === 'codex') {
      cliArgsForLoop.push('exec', '--dangerously-bypass-approvals-and-sandbox');
    } else if (cliName === 'gemini') {
      cliArgsForLoop.push('-y');
    } else if (cliName === 'makestudio' || cliName === 'self' || cliName === 'ms') {
      // makestudio CLI in headless mode: -p triggers runHeadless, --yes
      // bypasses per-tool prompts (DarkFactory already validated), --json
      // emits one JSON object per line during the tool loop so structure-
      // pass / enrich-pass can stream tool calls live to the user instead
      // of appearing hung. Prompt is appended as positional arg by
      // spawnCliAndCapture (makestudio -p reads from argv, not stdin).
      cliArgsForLoop.push('-p', '--yes', '--json');
    }

    // Phase C tunables via env. Defaults are safe: concurrency 1, resume ON.
    const concurrency = Math.max(1, Math.min(parseInt(process.env.MAKESTUDIO_PER_REQ_CONCURRENCY || '1', 10) || 1, 8));
    const resumeMode = process.env.MAKESTUDIO_PER_REQ_NO_RESUME !== '1';

    const result = await runPerRequirementLoop(reqsData as any[], {
      api,
      projectId,
      cli: cliName,
      cwd,
      cliArgs: cliArgsForLoop,
      cliCommand: cliCmdName,
      signal: opts?.signal,
      maxRetriesPerReq: 2,
      concurrency,
      resumeMode,
      onProgress: (ev: any) => {
        if (ev.type === 'req-start') {
          console.log(`${dim('│')}  ${cyan('▸')} ${dim(`[${ev.reqIndex + 1}/${ev.reqTotal}]`)} ${(ev.reqTitle || '').substring(0, 70)}`);
        } else if (ev.type === 'req-attempt') {
          console.log(`${dim('│')}    ${dim(`attempt ${ev.attempt} · ${(ev.cliDurationMs / 1000).toFixed(1)}s`)}`);
        } else if (ev.type === 'req-validation') {
          const tag = ev.passed ? green('✓ passed') : yellow(`✗ ${ev.issues} issue(s)`);
          console.log(`${dim('│')}    ${tag} ${dim(`(${ev.tempId})`)}`);
        } else if (ev.type === 'req-saved') {
          console.log(`${dim('│')}    ${green('✓ saved')} ${dim(`(${ev.tempId})`)}`);
        } else if (ev.type === 'req-failed') {
          console.log(`${dim('│')}    ${red('✗ failed:')} ${dim(ev.reason)}`);
        } else if (ev.type === 'loop-complete') {
          console.log(`${dim('│')}`);
          console.log(`${dim('│')}  ${green('✓')} Loop concluído: ${ev.saved}/${ev.total} requisitos OK · ${ev.failed} falharam`);
        }
      },
    });

    console.log();
    console.log(`  ${cyan('●')} Decomposição per-requisito: ${result.saved}/${result.total} requisitos resolvidos, ${result.failed} pendentes`);
    if (result.failedRequirements.length > 0) {
      console.log(`  ${dim('Requisitos pendentes:')}`);
      for (const f of result.failedRequirements.slice(0, 10)) {
        console.log(`    ${red('✗')} ${dim(`${f.title.substring(0, 60)} — ${f.reason}`)}`);
      }
    }
    return;
  }
}
