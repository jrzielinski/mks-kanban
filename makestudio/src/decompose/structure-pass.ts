import { swallow } from '../utils/log';
/**
 * structure-pass.ts (Phase 3 — Pass 1)
 *
 * First half of the two-pass decomposition rewrite. Asks the local CLI
 * (claude/codex/gemini/makestudio) to decompose a SINGLE requirement
 * into a flat list of DUM "structures" — just tempId, title, type,
 * summary, and dependsOn. NO description, NO tasks, NO mermaid yet.
 *
 * Why split: the old per-requirement-loop puts ~30KB of rules + briefing
 * + existing-DUMs context at the top of the prompt, then asks the CLI
 * to do everything in one go. By the time the CLI gets to the "write
 * the JSON" step, the rules are 30K tokens behind in attention — the
 * model writes invented section names, drops file paths, etc.
 *
 * Pass 1 keeps the prompt tiny (~1.5KB). The CLI doesn't need the full
 * QUALITY_CONTRACT here; it only needs to decide HOW MANY DUMs and
 * WHICH SHAPE. Quality enforcement happens in Pass 2 (`enrich-pass.ts`)
 * where each DUM is written individually with the rules right next to
 * the write call.
 *
 * Output: a JSON file at `.makestudio/decompose-task/STRUCTURE.json`
 * containing { dums: [{ tempId, title, type, summary, dependsOn }] }.
 * The agent reads this file directly — no LLM streaming parser needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { JsonlStreamReader, dimC } from './jsonl-stream-formatter';
import { startSilenceHeartbeat } from './silence-heartbeat';

export interface StructurePassRequirement {
  id: string;
  title: string;
  description?: string;
  type?: string;
  priority?: string;
  acceptanceCriteria?: string[] | string;
}

export interface StructurePassExistingDum {
  tempId: string | null;
  dumNumber?: string;
  title: string;
  type: string;
}

export interface DumStructure {
  tempId: string;
  title: string;
  type: string;
  summary: string;
  dependsOn: string[];
  /** Pass 2 reads this back to know which req this DUM came from. */
  requirementIds: string[];
}

export interface StructurePassOptions {
  cwd: string;
  cliCommand: string;
  cliArgs: string[];
  signal?: AbortSignal;
  /** ms before SIGKILL. Defaults to 3 minutes — Pass 1 is supposed to be fast. */
  timeoutMs?: number;
}

export interface StructurePassResult {
  dums: DumStructure[];
  cliDurationMs: number;
  /** Path the CLI wrote — useful for telemetry / debugging. */
  outputFilePath: string;
}

/**
 * Run Pass 1 for a single requirement. Throws if the CLI fails to
 * produce a parseable JSON; the caller (per-requirement-loop) handles
 * retry/cleanup.
 *
 * The reservedTempIds are passed in by the loop so collisions with
 * concurrent workers / existing files are avoided at the source.
 */
export async function runStructurePass(
  req: StructurePassRequirement,
  existingDums: StructurePassExistingDum[],
  reservedTempIds: string[],
  options: StructurePassOptions,
): Promise<StructurePassResult> {
  const taskDir = path.join(options.cwd, '.makestudio', 'decompose-task');
  fs.mkdirSync(taskDir, { recursive: true });

  // Write structured input as a small JSON file the CLI reads. We deliberately
  // avoid putting this in the prompt — keeps prompt-bytes tiny so attention
  // spans the rules, not the data.
  const inputPath = path.join(taskDir, 'STRUCTURE_INPUT.json');
  const outputPath = path.join(taskDir, 'STRUCTURE.json');
  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        requirement: {
          id: req.id,
          title: req.title,
          description: (req.description || '').slice(0, 4000),
          type: req.type || 'functional',
          priority: req.priority || 'medium',
          acceptanceCriteria: Array.isArray(req.acceptanceCriteria)
            ? req.acceptanceCriteria.slice(0, 10)
            : typeof req.acceptanceCriteria === 'string'
            ? [req.acceptanceCriteria]
            : [],
        },
        existingDums: existingDums.slice(0, 80).map((d) => ({
          tempId: d.tempId || d.dumNumber,
          title: d.title,
          type: d.type,
        })),
        reservedTempIds,
      },
      null,
      2,
    ),
    'utf8',
  );
  // Stale outputs from a previous run would cause the agent to read the
  // wrong DUMs — delete before invoking.
  try { fs.unlinkSync(outputPath); } catch (err) { swallow(err); }

  const prompt = buildStructurePrompt(inputPath, outputPath, reservedTempIds);
  const startedAt = Date.now();
  const debugLogPath = path.join(options.cwd, '.makestudio', 'tmp', `structure-${req.id.slice(0, 8)}.log`);
  await spawnCli(options, prompt, debugLogPath);
  const cliDurationMs = Date.now() - startedAt;

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Structure pass: CLI did not produce ${path.basename(outputPath)}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(outputPath, 'utf8');
  } catch (err: any) {
    throw new Error(`Structure pass: cannot read ${outputPath}: ${err.message}`);
  }
  let parsed: { dums?: any[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    // CLIs sometimes prepend "Here is the JSON:\n" — try to extract.
    const m = raw.match(/\{[\s\S]*"dums"[\s\S]*\}/);
    if (!m) throw new Error(`Structure pass: invalid JSON in ${path.basename(outputPath)}: ${err.message}`);
    parsed = JSON.parse(m[0]);
  }

  const dums = sanitizeStructures(parsed.dums || [], reservedTempIds, req.id);
  return { dums, cliDurationMs, outputFilePath: outputPath };
}

/**
 * Coerce the CLI's output into the strict DumStructure shape. Any
 * structure that's missing a required field is dropped (the loop will
 * retry if the count is zero). tempId is REWRITTEN to a reserved one
 * if the CLI invented something else — this is the cheapest way to
 * keep tempIds consistent without another round-trip.
 */
function sanitizeStructures(
  raw: any[],
  reservedTempIds: string[],
  reqId: string,
): DumStructure[] {
  const out: DumStructure[] = [];
  for (let i = 0; i < raw.length && i < reservedTempIds.length; i++) {
    const d = raw[i] || {};
    const title = String(d.title || '').trim();
    const type = String(d.type || 'feature').trim();
    if (!title) continue;
    out.push({
      tempId: reservedTempIds[i],
      title,
      type,
      summary: String(d.summary || '').trim().slice(0, 600),
      // Keep CLI-declared dependsOn but drop self-references and invent-
      // ones that don't match a reserved id or the master.
      dependsOn: Array.isArray(d.dependsOn)
        ? d.dependsOn
            .map((x: unknown) => String(x))
            .filter((x: string) => x && x !== reservedTempIds[i])
        : [],
      requirementIds: Array.isArray(d.requirementIds) && d.requirementIds.length > 0
        ? d.requirementIds.map((x: unknown) => String(x))
        : [reqId],
    });
  }
  return out;
}

function buildStructurePrompt(
  inputPath: string,
  outputPath: string,
  reservedTempIds: string[],
): string {
  // Prompt is intentionally short. The CLI reads INPUT, decides the
  // shape, writes OUTPUT, exits. No quality enforcement here — Pass 2
  // will validate and reject if the structure points at a bad shape.
  return `You are decomposing ONE project requirement into atomic DUM structures.

Read the input from \`${inputPath}\` (JSON). It contains:
- \`requirement\`: the single requirement to decompose
- \`existingDums\`: list of DUMs already in the project (avoid duplicating)
- \`reservedTempIds\`: tempIds you MUST use for new DUMs, in order

Write a JSON file at \`${outputPath}\` with this exact shape:

\`\`\`json
{
  "dums": [
    {
      "tempId": "${reservedTempIds[0]}",
      "title": "Short specific name",
      "type": "feature|database|backend|frontend|visual|infra|integration|flow|mixed",
      "summary": "One sentence on the atomic scope (max 600 chars)",
      "dependsOn": []
    }
  ]
}
\`\`\`

Rules (BINDING):
- Use 1, 2, or 3 entries — never more. Default 1. Split into 2-3 only when concerns are genuinely separable (DB vs service vs UI).
- The first tempId is FOUNDATION (DB / migration / entity). Use \`${reservedTempIds[0]}\`.
- The second (if present) is SERVICE / API / business logic. Use \`${reservedTempIds[1] || 'N/A'}\` and depend on \`${reservedTempIds[0]}\`.
- The third (if present) is UI / frontend / wizard. Use \`${reservedTempIds[2] || 'N/A'}\` and depend on \`${reservedTempIds[1] || reservedTempIds[0]}\`.
- DO NOT write description, tasks, or acceptance criteria yet — those come in a separate enrichment pass.
- DO NOT use any tempId not in the reserved list.

Write the file with the Write tool. After writing, print \`DONE: structure for <reqTitle>\` and exit.`;
}

/**
 * Internal helper to spawn the CLI with the configured prompt. Mirrors
 * `per-requirement-loop.spawnCliAndCapture` but doesn't snapshot files —
 * we don't care about diffing here, only about whether the output JSON
 * exists when the process exits.
 */
async function spawnCli(opts: StructurePassOptions, prompt: string, debugLogPath?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanEnv: NodeJS.ProcessEnv = {};
    const blocked = new Set([
      'CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_AGENT_SDK', 'CLAUDE_CODE_SUBAGENT',
    ]);
    for (const [k, v] of Object.entries(process.env)) {
      if (!blocked.has(k)) cleanEnv[k] = v;
    }

    const cmdBase = path.basename(opts.cliCommand);
    const isMakestudio = cmdBase === 'makestudio' || cmdBase === 'ms' || /makestudio/.test(opts.cliCommand);
    const finalArgs = isMakestudio ? [...opts.cliArgs, prompt] : opts.cliArgs;

    let debugStream: fs.WriteStream | null = null;
    if (debugLogPath) {
      try {
        fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
        debugStream = fs.createWriteStream(debugLogPath, { flags: 'w' });
        debugStream.write(`# Structure CLI invocation\nCommand: ${opts.cliCommand} ${opts.cliArgs.join(' ')}\nCWD: ${opts.cwd}\nPrompt length: ${prompt.length}\n# === Prompt ===\n${prompt}\n# === stdout/stderr below ===\n`);
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
    }, opts.timeoutMs ?? 3 * 60 * 1000);

    if (!isMakestudio) {
      proc.stdin?.write(prompt);
    }
    proc.stdin?.end();

    // Stream parser for the inner CLI's JSONL output. We forward each
    // formatted line to the parent's stdout so the user sees tool calls
    // and progress in real time (was the silent-subprocess problem).
    const useJsonl = isMakestudio && opts.cliArgs.includes('--json');
    const stdoutReader = useJsonl ? new JsonlStreamReader(`  ${dimC('│')}    `) : null;
    const stderrReader = useJsonl ? new JsonlStreamReader(`  ${dimC('│')}    `) : null;

    // Silence heartbeat — fires when the subprocess goes quiet for ≥8s.
    // See enrich-pass.ts for the rationale; same UX applied here so a
    // long structure-pass call doesn't look frozen.
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
      // Flush any partial trailing line through the formatter.
      if (stdoutReader) for (const f of stdoutReader.flush()) process.stdout.write(f.display + '\n');
      if (stderrReader) for (const f of stderrReader.flush()) process.stdout.write(f.display + '\n');
      try { debugStream?.end(`\n# === exit code ${code} ===\n`); } catch (err) { swallow(err); }
      // Non-zero exit doesn't fail us — we check for the output file
      // separately. Some CLIs exit non-zero when they self-limit turns
      // even after writing successfully.
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
