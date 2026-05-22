import { swallow } from '../utils/log';
/**
 * Refine pipeline — sync topic. Extracted from refine.ts.
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
import { runLocalCLI, spinner } from './refine-prompts';

export async function syncDiskDumsToBackend(opts: {
  api: any;
  projectId: string;
  workspace: any;
  reqs: any[];
  cli: string;
}): Promise<{ synced: number; reconciled: number }> {
  const { api, projectId, workspace, reqs, cli } = opts;
  let synced = 0;
  let reconciled = 0;

  if (!workspace?.repoPath) return { synced: 0, reconciled: 0 };

  const dumsDir = path.join(workspace.repoPath, '.makestudio', 'dums');
  if (!fs.existsSync(dumsDir)) return { synced: 0, reconciled: 0 };

  const diskFiles = fs.readdirSync(dumsDir).filter(f => /^dum_\d+\.json$/.test(f)).sort();
  if (diskFiles.length === 0) return { synced: 0, reconciled: 0 };

  // Fetch ALL DUMs from backend (including level=1 master) — don't rely on caller's filtered list
  // which usually excludes master DUMs and would cause false "missing" detection
  const backendByNumber = new Map<string, any>();
  try {
    const res = await api.get(`/dark-factory/dums/project/${projectId}`, { timeout: 10_000 });
    const allBackendDums = res.data?.dums || res.data || [];
    for (const d of allBackendDums) {
      if (d.dumNumber) backendByNumber.set(d.dumNumber.toUpperCase(), d);
    }
  } catch (err) { swallow(err); }

  // ── Step 1: Identify DUMs on disk that need syncing ──
  // Also normalize legacy Codex format (id → tempId) — write back to disk
  let normalizedCount = 0;
  const diskDumsFull: Array<{ file: string; dum: any; dumNumber: string }> = [];
  for (const file of diskFiles) {
    try {
      const filePath = path.join(dumsDir, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!content.title || content.title === 'FILL_IN') continue;
      const numMatch = file.match(/^dum_(\d+)\.json$/);
      if (!numMatch) continue;

      // Normalize: ensure tempId exists (migrate from id or derive from filename)
      let needsRewrite = false;
      if (!content.tempId) {
        if (content.id) {
          content.tempId = content.id;
          delete content.id;
        } else {
          content.tempId = `dum_${numMatch[1].padStart(3, '0')}`;
        }
        needsRewrite = true;
      }
      if (needsRewrite) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
          normalizedCount++;
        } catch (err) { swallow(err); }
      }

      const dumNumber = `DUM-${numMatch[1].padStart(3, '0')}`;
      diskDumsFull.push({ file, dum: content, dumNumber });
    } catch (err) { swallow(err); }
  }
  if (normalizedCount > 0) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${dim(`${normalizedCount} DUMs normalizados no disco (id → tempId — formato legado Codex)`)}`);
  }

  const missingFromBackend = diskDumsFull.filter(d => !backendByNumber.has(d.dumNumber.toUpperCase()));

  if (missingFromBackend.length > 0) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${yellow('⚠')} ${yellow(`${missingFromBackend.length} DUMs no disco não estão no backend — sincronizando...`)}`);

    for (const { dum, dumNumber } of missingFromBackend) {
      try {
        await api.post(
          `/dark-factory/projects/${projectId}/save-decomposition`,
          { dums: [dum], requirementIds: dum.requirementIds || [] },
          { timeout: 30_000 },
        );
        synced++;
        const taskCount = dum.tasks?.length || 0;
        console.log(`${dim('│')}    ${green('✓')} ${dim(`${dumNumber}: ${(dum.title || '').substring(0, 50)} (${taskCount} tasks)`)}`);
      } catch (err: any) {
        console.log(`${dim('│')}    ${red('✗')} ${dim(`${dumNumber}: ${err.response?.data?.message || err.message}`)}`);
      }
    }
    console.log(`${dim('│')}  ${green('✓')} ${dim(`${synced}/${missingFromBackend.length} DUMs sincronizados`)}`);
  }

  // ── Step 2: Reconcile DUMs with empty requirementIds ──
  // Skip DUMs that are known non-functional (master, contracts, infra) AND DUMs
  // already marked as _reconciledEmpty from a previous run — avoids burning LLM calls
  // asking the same question every run.
  const NON_FUNCTIONAL_TITLE_PATTERN = /contratos|config|docker|ci\/?cd|setup|deploy|migrat|observab|postgres|extens|bootstrap|ambiente/i;
  const isNonFunctional = (dum: any): boolean => (
    dum._reconciledEmpty === true ||
    (dum.level || 2) === 1 ||
    dum.type === 'contracts' ||
    dum.type === 'infra' ||
    NON_FUNCTIONAL_TITLE_PATTERN.test(dum.title || '')
  );

  // Auto-mark non-functional DUMs that have empty requirementIds (persistent flag for future runs)
  let autoMarked = 0;
  for (const entry of diskDumsFull) {
    const empty = !Array.isArray(entry.dum.requirementIds) || entry.dum.requirementIds.length === 0;
    if (empty && isNonFunctional(entry.dum) && entry.dum._reconciledEmpty !== true) {
      entry.dum._reconciledEmpty = true;
      try {
        fs.writeFileSync(path.join(dumsDir, entry.file), JSON.stringify(entry.dum, null, 2), 'utf8');
        autoMarked++;
      } catch (err) { swallow(err); }
    }
  }
  if (autoMarked > 0) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${dim(`${autoMarked} DUMs marcados como non-functional (master/contracts/infra) — não serão mais reconciliados`)}`);
  }

  const needsReconcile = diskDumsFull.filter(d =>
    (!Array.isArray(d.dum.requirementIds) || d.dum.requirementIds.length === 0) &&
    !isNonFunctional(d.dum),
  );

  if (needsReconcile.length > 0 && reqs.length > 0) {
    console.log(dim('│'));
    console.log(`${dim('│')}  ${yellow('⚠')} ${yellow(`${needsReconcile.length} DUMs sem requirementIds — reconciliando via ${cli.toUpperCase()}...`)}`);

    // Build ONE batch prompt for all DUMs needing reconciliation
    const reqsCompact = reqs.map((r: any) => ({
      id: r.id,
      title: (r.title || r.name || '').substring(0, 100),
      category: r.category || r.type || 'functional',
    }));

    const dumsCompact = needsReconcile.map(({ dumNumber, dum }) => ({
      dumNumber,
      title: dum.title,
      description: (dum.description || '').substring(0, 1200),
      taskTitles: (dum.tasks || []).map((t: any) => t.title).slice(0, 8),
    }));

    const reconcilePrompt = `You are mapping DUMs (units of work) to project requirements they implement.

Below are PROJECT REQUIREMENTS (with IDs) and DUMs that have NO requirement mapping yet.

For each DUM, identify which requirement IDs it implements. A DUM implements a requirement
if its title/description/tasks directly deliver functionality described in the requirement.
A DUM may implement MULTIPLE requirements. Be precise — only include requirements that
are clearly implemented by the DUM's scope, not tangentially related.

REQUIREMENTS:
${JSON.stringify(reqsCompact, null, 2)}

DUMS_TO_MAP:
${JSON.stringify(dumsCompact, null, 2)}

OUTPUT FORMAT (STRICT JSON — no markdown, no commentary):
{
  "mappings": [
    { "dumNumber": "DUM-060", "requirementIds": ["uuid-1", "uuid-2"] },
    { "dumNumber": "DUM-100", "requirementIds": ["uuid-3"] }
  ]
}

Return ONLY the JSON. No preamble, no markdown fences, no explanation.`;

    const stopSpin = spinner(`Reconciliando ${needsReconcile.length} DUMs via ${cli.toUpperCase()}`);
    const llmOut = await runLocalCLI(cli, reconcilePrompt, workspace.repoPath, 5 * 60 * 1000);
    stopSpin();

    if (llmOut) {
      try {
        const jsonMatch = llmOut.match(/\{[\s\S]*"mappings"[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON with "mappings" in LLM output');
        const parsed = JSON.parse(jsonMatch[0]);
        const mappings: Array<{ dumNumber: string; requirementIds: string[] }> = parsed.mappings || [];

        // Valid requirement IDs (to filter LLM hallucinations)
        const validReqIds = new Set(reqs.map((r: any) => r.id));
        let mapped = 0;
        let legitEmpty = 0;
        let unmapped = 0;

        for (const m of mappings) {
          const entry = needsReconcile.find(e => e.dumNumber.toUpperCase() === m.dumNumber.toUpperCase());
          if (!entry) continue;
          const cleanIds = (m.requirementIds || []).filter(id => validReqIds.has(id));

          // Empty mapping is LEGITIMATE for infra/contracts/overview DUMs.
          // Persist the flag so next run skips this DUM entirely (no more wasted LLM calls).
          if (cleanIds.length === 0) {
            legitEmpty++;
            entry.dum._reconciledEmpty = true;
            try {
              fs.writeFileSync(
                path.join(dumsDir, entry.file),
                JSON.stringify(entry.dum, null, 2),
                'utf8',
              );
            } catch (err) { swallow(err); }
            console.log(`${dim('│')}    ${dim(`○ ${m.dumNumber}: sem requisito funcional direto — marcado, não será mais reconciliado`)}`);
            continue;
          }

          // Update disk file
          try {
            entry.dum.requirementIds = cleanIds;
            fs.writeFileSync(
              path.join(dumsDir, entry.file),
              JSON.stringify(entry.dum, null, 2),
              'utf8',
            );
          } catch (err) { swallow(err); }

          // Update backend (find the real id by dumNumber)
          try {
            const backendDum = backendByNumber.get(m.dumNumber.toUpperCase());
            if (backendDum?.id) {
              await api.put(
                `/dark-factory/dums/${backendDum.id}`,
                { requirementIds: cleanIds },
                { timeout: 10_000 },
              );
            }
            mapped++;
            reconciled++;
            console.log(`${dim('│')}    ${green('✓')} ${dim(`${m.dumNumber}: mapeado para ${cleanIds.length} requisito(s)`)}`);
          } catch (err: any) {
            console.log(`${dim('│')}    ${yellow('⚠')} ${dim(`${m.dumNumber}: disco OK, backend falhou (${err.message})`)}`);
          }
        }
        unmapped = needsReconcile.length - mapped - legitEmpty;
        const summary = [
          mapped > 0 ? `${green(String(mapped))} mapeados` : '',
          legitEmpty > 0 ? `${dim(`${legitEmpty} infra/contracts (sem requisito funcional)`)}` : '',
          unmapped > 0 ? `${yellow(`${unmapped} não respondidos pelo LLM`)}` : '',
        ].filter(Boolean).join(' · ');
        console.log(`${dim('│')}  ${green('✓')} ${dim('Reconciliação:')} ${summary}`);
      } catch (err: any) {
        console.log(`${dim('│')}  ${red('✗')} ${dim(`Reconciliação falhou: ${err.message}`)}`);
      }
    } else {
      console.log(`${dim('│')}  ${red('✗')} ${dim('LLM não retornou output para reconciliação')}`);
    }
  }

  return { synced, reconciled };
}

export function snapshotBoilerplate(repoPath: string): string {
  const lines: string[] = [];
  try {
    const topLevel = fs.readdirSync(repoPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort();
    for (const entry of topLevel) {
      if (entry.isDirectory()) {
        lines.push(`${entry.name}/`);
        try {
          const children = fs.readdirSync(path.join(repoPath, entry.name), { withFileTypes: true })
            .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
            .slice(0, 25);
          for (const c of children) {
            lines.push(`  ${c.name}${c.isDirectory() ? '/' : ''}`);
          }
        } catch (err) { swallow(err); }
      } else {
        lines.push(entry.name);
      }
    }
  } catch (err) { swallow(err); }
  return lines.join('\n');
}
