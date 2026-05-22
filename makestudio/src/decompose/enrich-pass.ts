import { swallow } from '../utils/log';
/**
 * enrich-pass.ts (Phase 3 — Pass 2)
 *
 * Second half of two-pass decomposition. For ONE DUM structure produced
 * by `structure-pass.ts`, generates the full DUM JSON with description,
 * tasks, acceptance criteria, mermaid diagram.
 *
 * Why this is separate from Pass 1:
 *   - The CLI here gets a focused prompt: "fill in the body of THIS DUM."
 *     Rules (the 8 self-audit checks) are inlined at the BOTTOM of the
 *     prompt — closest to the Write call — so attention stays on them
 *     instead of decaying behind 30K tokens of briefing.
 *   - One DUM per CLI invocation = parallelizable. The loop can fire
 *     2-3 enrich-pass calls concurrently while a single structure-pass
 *     is computing for the next requirement.
 *   - Failure isolation: a bad enrich for DUM-005 doesn't poison
 *     DUM-002 already saved.
 *
 * Output: writes the DUM JSON directly to `.makestudio/dums/<tempId>.json`.
 * The agent picks it up via the existing post-spawn diff.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { DumStructure } from './structure-pass';
import { JsonlStreamReader, dimC } from './jsonl-stream-formatter';
import { startSilenceHeartbeat } from './silence-heartbeat';

export interface EnrichPassOptions {
  cwd: string;
  cliCommand: string;
  cliArgs: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Project briefing snippet — included in the prompt context. Limited
   * to ~3KB so the rules section at the bottom still fits in the
   * model's recent attention.
   */
  briefing?: string;
  /**
   * Output language (pt-BR/en/es). Drives the language of generated
   * description + ACs. Without this the CLI sometimes flips languages
   * mid-batch.
   */
  outputLanguage?: string;
  /**
   * Existing DUMs (titles only) for context — used so the CLI knows what
   * NOT to re-implement. We don't pass full descriptions here; just
   * enough to spot duplicates by title.
   */
  existingDums?: Array<{ tempId: string; title: string; type: string }>;
  /**
   * Backend API client. Used to fetch the per-type required-section map
   * from `/dark-factory/projects/quality-contract/sections` so the prompt
   * can list the EXACT section names the gate expects for this DUM's
   * type — no client-side hardcoding of the map.
   */
  api?: {
    get: (url: string, config?: any) => Promise<{ data: any }>;
  };
}

/**
 * Cached snapshot of the backend's `REQUIRED_SECTIONS_BY_TYPE` +
 * `TYPE_ALIASES`. Fetched lazily on the first enrich call of a process
 * and reused for every subsequent enrich. The contents change only when
 * the backend changes `required-sections.ts`, which does not happen
 * mid-run.
 */
interface SectionMap {
  sectionsByType: Record<string, string[]>;
  typeAliases: Record<string, string>;
}
let _cachedSectionMap: SectionMap | null = null;
let _cachedSectionMapPromise: Promise<SectionMap | null> | null = null;

async function fetchSectionMap(api: NonNullable<EnrichPassOptions['api']>): Promise<SectionMap | null> {
  if (_cachedSectionMap) return _cachedSectionMap;
  if (_cachedSectionMapPromise) return _cachedSectionMapPromise;
  _cachedSectionMapPromise = api
    .get('/dark-factory/projects/quality-contract/sections', { timeout: 10_000 })
    .then((res: any) => {
      const sectionsByType = res?.data?.sectionsByType;
      const typeAliases = res?.data?.typeAliases;
      if (!sectionsByType || typeof sectionsByType !== 'object') return null;
      _cachedSectionMap = { sectionsByType, typeAliases: typeAliases || {} };
      return _cachedSectionMap;
    })
    .catch(() => null)
    .finally(() => { _cachedSectionMapPromise = null; });
  return _cachedSectionMapPromise;
}

/** Test seam: drop the cached map so a fresh fetch happens next call. */
export function _resetEnrichSectionCache(): void {
  _cachedSectionMap = null;
  _cachedSectionMapPromise = null;
}

/**
 * Resolve the required-section list for one DUM type. Honors the
 * backend's TYPE_ALIASES (frontend → design, backend → architecture,
 * etc.). Returns an empty array when the map is unavailable; the prompt
 * falls back to the generic instruction in that case.
 */
function resolveSectionsForType(map: SectionMap | null, type: string | undefined): string[] {
  if (!map) return [];
  const t = (type || 'feature').toLowerCase();
  const resolved = map.typeAliases[t] || t;
  return map.sectionsByType[resolved] || map.sectionsByType[t] || [];
}

export interface EnrichPassResult {
  /** True when the DUM JSON was written successfully. */
  written: boolean;
  /** Path to the produced DUM file (or null on failure). */
  dumPath: string | null;
  cliDurationMs: number;
}

/**
 * Run Pass 2 for one DUM structure. Best-effort: returns {written:false}
 * if the CLI fails or times out. Caller (per-requirement-loop) decides
 * whether to retry.
 */
export async function runEnrichPass(
  structure: DumStructure,
  options: EnrichPassOptions,
): Promise<EnrichPassResult> {
  const dumsDir = path.join(options.cwd, '.makestudio', 'dums');
  fs.mkdirSync(dumsDir, { recursive: true });
  const dumPath = path.join(dumsDir, `${structure.tempId}.json`);

  // Pull the full per-type section map once per process. We need the
  // map for THIS DUM's type (used in the description) AND for every
  // type the per-task `conforming` check might evaluate — tasks default
  // to type='feature' which has a DIFFERENT section list than the DUM
  // itself. Without listing both, the LLM copied the DUM's sections to
  // every task and the gate auto-rejected with "missing required
  // sections" on the wrong template.
  const sectionMap = options.api ? await fetchSectionMap(options.api) : null;
  const expectedSections = resolveSectionsForType(sectionMap, structure.type);

  const prompt = buildEnrichPrompt(structure, options, expectedSections, sectionMap);
  const debugLogPath = path.join(options.cwd, '.makestudio', 'tmp', `enrich-${structure.tempId}.log`);
  // Pass the decomposition context to the inner subprocess via env vars.
  // Used by:
  //   - context.ts:buildSystemReminders → re-injects the rules every turn
  //     (combat attention decay across long tool loops)
  //   - file-tools.ts:writeImpl → validates dum_*.json before disk
  //     (catches structural problems INSIDE the same tool loop, no
  //     server-side fix-pass round-trip needed)
  //   - headless.ts → skips attachment-extraction for the prompt so the
  //     model doesn't waste a round-trip on read_attachment first.
  const decompEnv: Record<string, string> = {
    MAKESTUDIO_DECOMPOSITION_TEMPID: structure.tempId,
    MAKESTUDIO_DECOMPOSITION_TYPE: structure.type,
    MAKESTUDIO_DECOMPOSITION_SECTIONS: expectedSections.join(','),
    MAKESTUDIO_DECOMPOSITION_TITLE: structure.title.slice(0, 200),
  };

  const startedAt = Date.now();
  await spawnCli(options, prompt, debugLogPath, decompEnv);
  let cliDurationMs = Date.now() - startedAt;

  // Verify the file appeared and parses; if not, attempt ONE re-engagement
  // pass with a focused prompt before giving up. Smaller models (deepseek-v4-flash
  // observed in production) sometimes finish the tool loop after only Read
  // calls — they emit a closing assistant text without ever calling Write.
  // The per-requirement-loop's retry then re-runs the FULL enrich-pass with
  // the same big prompt and the model often does the same thing again. A
  // tighter "you forgot to Write" prompt salvages the run cheaply.
  //
  // Skipped when the user already cancelled — spawning a doomed subprocess
  // just to have it SIGKILL'd burns credentials/cost for no benefit.
  if (!fs.existsSync(dumPath) && !options.signal?.aborted) {
    // Surface the recovery attempt so the user sees what's happening
    // instead of an unexplained pause between the first close and the
    // second spawn. The path stays relative so the reminder matches the
    // prompt's relative path everywhere else.
    const relPath = `.makestudio/dums/${structure.tempId}.json`;
    process.stdout.write(
      `  ${dimC('│')}    ${dimC('·')} ${dimC(`subprocess saiu sem gravar ${relPath} — re-engajando`)}\n`,
    );
    const reengagePrompt =
      `You did not call Write in the previous turn — \`${relPath}\` does NOT exist on disk yet. ` +
      `Your ONLY remaining task is to call \`Write\` exactly once with the full DUM JSON. ` +
      `Do NOT explore the codebase, do NOT read more files, do NOT plan further. ` +
      `Re-emit the DUM JSON for tempId="${structure.tempId}" type="${structure.type}" using the section template ` +
      `(${expectedSections.map((s) => `\`## ${s}\``).join(', ')}) and call \`Write { file_path: "${relPath}", content: <full JSON> }\` now.`;
    const reengageStart = Date.now();
    try {
      await spawnCli(
        options,
        reengagePrompt,
        path.join(options.cwd, '.makestudio', 'tmp', `enrich-${structure.tempId}.reengage.log`),
        decompEnv,
      );
    } catch (err: any) {
      // Re-engagement spawn failure is NOT fatal — fall through to the
      // existsSync check below, which returns {written: false} cleanly.
      // Without this catch, runEnrichPass would reject and the per-req
      // loop's Promise.allSettled wave would log the raw error instead
      // of the cleaner "no file written" result.
      void err;
    }
    cliDurationMs += Date.now() - reengageStart;
  }

  if (!fs.existsSync(dumPath)) {
    return { written: false, dumPath: null, cliDurationMs };
  }
  try {
    const raw = fs.readFileSync(dumPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.tempId || !parsed.title || !Array.isArray(parsed.tasks)) {
      return { written: false, dumPath, cliDurationMs };
    }
  } catch {
    return { written: false, dumPath, cliDurationMs };
  }
  return { written: true, dumPath, cliDurationMs };
}

/**
 * Build the enrichment prompt. Three sections, in order:
 *   1. WHAT to fill (the structure)
 *   2. CONTEXT (briefing + existing DUMs)
 *   3. RULES (the 8 self-audit checks) + WRITE INSTRUCTION
 *
 * Critical: rules are at the END so they sit in the recent-attention
 * window when the CLI starts to actually write. Pre-Phase-3 the rules
 * were near the top and decayed before the Write call landed.
 */
function buildEnrichPrompt(
  structure: DumStructure,
  opts: EnrichPassOptions,
  expectedSections: string[],
  sectionMap: SectionMap | null,
): string {
  const briefing = (opts.briefing || '').slice(0, 3000);
  const lang = opts.outputLanguage || 'the project default language';
  const existingBrief = (opts.existingDums || [])
    .slice(0, 30)
    .map((d) => `- \`${d.tempId}\` (${d.type}): ${d.title}`)
    .join('\n');

  // Per-task section table — the gate's `conforming` check runs PER
  // TASK against the section-map for THAT task's type. Tasks usually
  // default to type='feature' even when the DUM is type='database', so
  // we list every type's required sections here and instruct the LLM
  // to pick the right list per task. Without this, the LLM copied the
  // DUM's sections to every task and reprovou.
  const taskTypeRows = sectionMap
    ? Object.entries(sectionMap.sectionsByType)
        .map(([t, secs]) => `| \`${t}\` | ${secs.map((s) => `\`## ${s}\``).join(', ')} |`)
        .join('\n')
    : '';
  const aliasRows = sectionMap
    ? Object.entries(sectionMap.typeAliases)
        .map(([alias, real]) => `| \`${alias}\` → \`${real}\` |`)
        .join('\n')
    : '';

  // Section block — when the backend tells us the exact names the
  // `conforming` gate expects for this type, list them verbatim. When
  // the fetch failed, fall back to the contract-driven instruction so
  // the LLM still has guidance (just less specific).
  const sectionBlock = expectedSections.length > 0
    ? `## REQUIRED SECTIONS

### For the DUM's \`description\` (type=${structure.type})

The DUM-level \`description\` field MUST use exactly these section headers (\`## <name>\`), in this order:

${expectedSections.map((s) => `- \`## ${s}\``).join('\n')}

### For EACH task's \`description\` — picks BY THE TASK's \`type\`

The \`conforming\` gate runs **per task** against the section list for that task's own \`type\` field — NOT the DUM's type. **A task with \`type: "feature"\` inside a DUM with \`type: "database"\` must use the FEATURE template, not the DATABASE template.**

| Task \`type\` | Required \`##\` sections (in order) |
|---|---|
${taskTypeRows}

Type aliases (the gate normalizes these on the fly):
${aliasRows}

When picking sections for each task:
1. Look at the task's own \`type\` field.
2. If it's an alias above, resolve to the canonical type.
3. Use exactly that row's section list. Do NOT use the DUM-level list for tasks unless the task's type matches.
4. Common case: most implementation tasks should be \`type: "feature"\` (\`Files to Create/Modify\`, \`Imports and Dependencies\`, \`Step-by-Step Logic\`, \`API Calls\`, \`Patterns to Follow\`, \`Mermaid\`).
5. Use \`type: "database"\` only for migration/seed tasks; \`type: "test"\` only for test scenarios; etc.

Do not invent or rename section headers. If a section doesn't apply to a task, write a 1-line justification under it (e.g. "_None — this task has no DB migrations._") rather than dropping the heading.`
    : `## REQUIRED SECTIONS

Use the EXACT section headers required by the contract for this DUM's type AND for each task's type (see \`.makestudio/QUALITY_CONTRACT.md\` table under §5.2.5 #5 Conforming). Inventing section names like "## Especificação" is auto-rejected.`;

  return `You are filling in the BODY of one DUM that was already structured for you. Do NOT decide the title or type — those are fixed below.

## DUM TO ENRICH

\`\`\`json
${JSON.stringify(
  {
    tempId: structure.tempId,
    title: structure.title,
    type: structure.type,
    summary: structure.summary,
    dependsOn: structure.dependsOn,
    requirementIds: structure.requirementIds,
  },
  null,
  2,
)}
\`\`\`

## PROJECT CONTEXT (read-only)

${briefing || '(no briefing available — decide based on the title and summary above)'}

${existingBrief ? `## EXISTING DUMs (do NOT duplicate these scopes)\n\n${existingBrief}\n` : ''}

${sectionBlock}

## OUTPUT

Write a JSON file at \`.makestudio/dums/${structure.tempId}.json\` (use the Write tool, ONCE) with this exact shape:

\`\`\`json
{
  "tempId": "${structure.tempId}",
  "title": "${structure.title.replace(/"/g, '\\"')}",
  "type": "${structure.type}",
  "level": 2,
  "requirementIds": ${JSON.stringify(structure.requirementIds)},
  "dependsOn": ${JSON.stringify(structure.dependsOn)},
  "description": "...markdown sections per the contract...",
  "mermaidDiagram": "flowchart TD\\nA --> B",
  "tasks": [
    {
      "title": "...",
      "description": "...markdown with REQUIRED section names; ≥1 file path; ≥1 signature; ≥8 lines...",
      "type": "feature|database|backend|frontend|test|infra",
      "complexity": "low|medium|high",
      "acceptanceCriteria": [
        "GIVEN ... WHEN ... THEN ... (or DADO/QUANDO/ENTÃO in pt-BR) — every AC contains a number, quoted string, path, or enum",
        "..."
      ],
      "techContext": "src/path/to/file.ts"
    }
  ]
}
\`\`\`

## SELF-AUDIT (BINDING — re-check each line BEFORE Write)

Read these 8 rules right now, KEEP THEM IN MIND while you write the JSON above, and verify each one before calling the Write tool:

1. **Section names**: \`description\` uses EXACTLY the contract's section names (\`## Scope\` / \`## Escopo\`, \`## Files\`, \`## Business Rules\`, etc.). NEVER invent \`## Especificação\`, \`## Contexto\`, \`## Test Coverage\`.
2. **No weak words**: scan description + ACs for "adequate", "robust", "as needed", "etc.", "and/or", "appropriately", "correctly", "without errors". Replace each with a concrete number, status code, path, or enum value.
3. **Concrete description**: ≥1 file path with extension; ≥1 method/DDL signature; ≥8 informational lines (paths, signatures, numbered steps, code fences, or ALL_CAPS identifiers).
4. **Verifiable ACs**: each AC contains at least one of: number, quoted string, path, status code, ALL_CAPS identifier, or comparison operator.
5. **Title coherence**: ≥3 distinct content nouns from the title appear in the description.
6. **Type-complete**: NO \`any\`, \`unknown\`, \`TODO\`, \`FILL_IN\`, \`<placeholder>\`, \`???\`, \`XXX\` in any signature.
7. **Output language**: ALL prose (description, task descriptions, ACs, mermaid labels) MUST be in ${lang}. Code identifiers stay in English.
8. **No duplicates**: this DUM's body MUST be semantically distinct from every existing DUM listed above.

If any check fails, REWRITE the offending field BEFORE calling Write. Do not submit broken DUMs.

After writing, print exactly: \`DONE: enriched ${structure.tempId}\` and exit. Do not write to any other file.`;
}

async function spawnCli(opts: EnrichPassOptions, prompt: string, debugLogPath?: string, extraEnv?: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanEnv: NodeJS.ProcessEnv = {};
    const blocked = new Set([
      'CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_AGENT_SDK', 'CLAUDE_CODE_SUBAGENT',
    ]);
    for (const [k, v] of Object.entries(process.env)) {
      if (!blocked.has(k)) cleanEnv[k] = v;
    }
    if (extraEnv) {
      for (const [k, v] of Object.entries(extraEnv)) cleanEnv[k] = v;
    }
    const cmdBase = path.basename(opts.cliCommand);
    const isMakestudio = cmdBase === 'makestudio' || cmdBase === 'ms' || /makestudio/.test(opts.cliCommand);
    const finalArgs = isMakestudio ? [...opts.cliArgs, prompt] : opts.cliArgs;

    // Open debug log: capture command, prompt, and stdout/stderr — without
    // this we can't diagnose why the inner CLI subprocess didn't write the
    // expected file. The earlier silent-discard approach hid every problem.
    let debugStream: fs.WriteStream | null = null;
    if (debugLogPath) {
      try {
        fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
        debugStream = fs.createWriteStream(debugLogPath, { flags: 'w' });
        debugStream.write(`# Enrich CLI invocation\nCommand: ${opts.cliCommand} ${opts.cliArgs.join(' ')}\nCWD: ${opts.cwd}\nPrompt length: ${prompt.length}\n# === Prompt ===\n${prompt}\n# === stdout/stderr below ===\n`);
      } catch (err) { swallow(err); }
    }

    const proc = spawn(opts.cliCommand, finalArgs, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch (err) { swallow(err); } };
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (err) { swallow(err); }
    }, opts.timeoutMs ?? 5 * 60 * 1000);

    if (!isMakestudio) {
      proc.stdin?.write(prompt);
    }
    proc.stdin?.end();

    // Stream parser for the inner CLI's JSONL output. Forwards every
    // formatted line to parent stdout so the user sees Read/Write tool
    // calls + the assistant's reasoning while the multi-minute tool loop
    // is running. Without this the subprocess looked hung.
    const useJsonl = isMakestudio && opts.cliArgs.includes('--json');
    const stdoutReader = useJsonl ? new JsonlStreamReader(`  ${dimC('│')}    `) : null;
    const stderrReader = useJsonl ? new JsonlStreamReader(`  ${dimC('│')}    `) : null;

    // Silence heartbeat — fires after 8s without subprocess output and
    // every 7s thereafter. Reassures the user that the LLM is mid-call,
    // not frozen. The user keeps cancelling around 5min thinking the
    // pipeline locked up; without periodic feedback there is no signal
    // distinguishing "deep thinking" from "actually stuck".
    const heartbeat = startSilenceHeartbeat({
      prefix: `  ${dimC('│')}    `,
      threshold: 8_000,
      interval: 7_000,
      hintAfterSeconds: 30,
    });

    proc.stderr?.on('data', (d: Buffer) => {
      heartbeat.markActivity();
      debugStream?.write(`[stderr] ${d.toString()}`);
      if (stderrReader) {
        for (const f of stderrReader.push(d)) process.stdout.write(f.display + '\n');
      }
    });
    proc.stdout?.on('data', (d: Buffer) => {
      heartbeat.markActivity();
      debugStream?.write(d);
      if (stdoutReader) {
        for (const f of stdoutReader.push(d)) process.stdout.write(f.display + '\n');
      }
    });

    proc.on('close', (code) => {
      heartbeat.stop();
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (stdoutReader) for (const f of stdoutReader.flush()) process.stdout.write(f.display + '\n');
      if (stderrReader) for (const f of stderrReader.flush()) process.stdout.write(f.display + '\n');
      try { debugStream?.end(`\n# === exit code ${code} ===\n`); } catch (err) { swallow(err); }
      resolve();
    });
    proc.on('error', (err) => {
      heartbeat.stop();
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      try { debugStream?.end(`\n# === spawn error: ${err.message} ===\n`); } catch (err) { swallow(err); }
      reject(err);
    });
  });
}
