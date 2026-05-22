import { swallow } from '../../utils/log';
/**
 * Camada B — type-check em background do projeto inteiro (cross-file).
 *
 * Spawna `tsc --watch --noEmit --incremental` como child process no boot do
 * REPL. tsc fica ouvindo mudanças no filesystem e emite erros continuamente.
 * No fim do turno, captureTurnErrors() coleta erros novos desde o último call
 * e retorna como lista — o callsite mostra como info-message ao operador.
 *
 * Camada A (post-edit-hooks.ts:programTypeCheck) roda ts.createProgram per-file
 * após cada Edit/Write/MultiEdit, filtrando diagnostics ao arquivo tocado.
 * Erros cross-file (ex: renomeou export e quebrou callers em outros arquivos)
 * NÃO aparecem até o próximo edit nesses outros arquivos — Camada B fecha esse
 * gap.
 */

import * as child_process from 'child_process';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ReplContext } from '../context';

interface ErrorEntry {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

let watcherProcess: child_process.ChildProcess | null = null;

/**
 * Buffer de erros — substituído a cada rodada completa do watch.
 * tsc --watch emite o SET COMPLETO de erros a cada ciclo, então não acumulamos
 * entre rodadas. Só armazenamos o último set completo.
 */
let lastErrorSet: Map<string, ErrorEntry[]> = new Map();

/** Erros capturados no último captureTurnErrors (para diff). */
let previousErrorSet: Map<string, ErrorEntry[]> = new Map();

/** Callback registrado por captureTurnErrors. */
let onNewErrors: ((errors: Map<string, ErrorEntry[]>) => void) | null = null;

// tsc emits two error-line formats depending on the --pretty flag:
//   non-pretty (piped/no-TTY default): `path(line,col): error TSxxxx: msg`
//   pretty (TTY default):              `path:line:col - error TSxxxx: msg`
// Since we spawn with stdio: 'pipe' (no TTY), we get non-pretty by default,
// but support both for robustness against future flag changes.
const TSC_OUTPUT_RE_PARENS = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
const TSC_OUTPUT_RE_PRETTY = /^(.+?):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s+(.+)$/gm;

/**
 * Append a chunk to a string buffer, keeping the total size below a cap.
 * When appending would exceed the cap, drop the head and keep the tail
 * (most recent content) plus the new chunk. Used to cap stdout/stderr
 * buffers from the tsc --watch process so long REPL sessions don't OOM.
 *
 * Exported for unit testing — the production typecheck-watcher uses it
 * inline in the spawn handlers.
 */
export function appendBounded(buf: string, chunk: string, maxBytes: number): string {
  if (maxBytes <= 0) return chunk;
  if (buf.length + chunk.length <= maxBytes) return buf + chunk;
  // slice(-N) where N>0 keeps the last N chars; slice(-0) keeps the whole
  // string (JS quirk), so we floor + max-with-1 to avoid the degenerate.
  const keep = Math.max(1, Math.floor(maxBytes / 2));
  return buf.slice(-keep) + chunk;
}

/**
 * Retorna o hash do caminho do tsconfig para usar como chave de cache.
 */
function tsconfigHash(tsconfigPath: string): string {
  return crypto.createHash('md5').update(tsconfigPath).digest('hex').slice(0, 12);
}

/**
 * Sobe a partir de ctx.cwd procurando tsconfig.json.
 */
function findTsconfig(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // chegou na raiz
    dir = parent;
  }
  return null;
}

/**
 * Cache path para tsbuildinfo (incremental info).
 */
function getCachePath(tsconfigPath: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const cacheDir = path.join(homeDir, '.makestudio', '.ts-cache');
  const hash = tsconfigHash(tsconfigPath);
  return path.join(cacheDir, `${hash}.tsbuildinfo`);
}

/**
 * Inicia o watcher. Não bloqueia — spawna o processo e retorna.
 * Se já estiver rodando, é no-op (não spawna outro).
 */
export function startTypeCheckWatcher(ctx: ReplContext): void {
  if (watcherProcess) return; // já rodando

  const cwd = ctx.cwd || process.cwd();
  const tsconfigPath = findTsconfig(cwd);
  if (!tsconfigPath) {
    // Sem tsconfig no projeto — Camada B não é aplicável
    return;
  }

  const cachePath = getCachePath(tsconfigPath);
  const cacheDir = path.dirname(cachePath);

  // Garante que o diretório de cache existe
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (err) { swallow(err); }

  const projectDir = path.dirname(tsconfigPath);

  // Resolve the tsc binary directly instead of going through npx. npx
  // creates a process tree (npm exec → sh -c → node tsc) where SIGTERM
  // on the topmost only kills npm exec — the actual tsc node process
  // survives as a zombie. Spawning `node <tsc-binary>` directly gives
  // us a single child whose pid we can reliably kill.
  let tscBinPath: string | null = null;
  try {
    tscBinPath = require.resolve('typescript/bin/tsc', { paths: [projectDir] });
  } catch {
    // typescript not installed in the project — Camada B unavailable
    return;
  }

  const child = child_process.spawn(
    process.execPath, // current node binary
    [
      tscBinPath,
      '--watch',
      '--noEmit',
      '--incremental',
      '--tsBuildInfoFile', cachePath,
      '--pretty', 'false', // force non-pretty output (we parse by line)
    ],
    {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=8192',
      },
      detached: false,
    },
  );

  // Bounded buffers — long REPL sessions (2h+) used to OOM the agent
  // because stderrBuf grew without limit and stdoutBuf could grow if
  // tsc never emitted "Found N errors" between cycles. Cap each at 1MB
  // and keep the tail (most recent), the same shape executor.ts uses.
  let stdoutBuf = '';
  let stderrBuf = '';
  const MAX_BUF_BYTES = 1 * 1024 * 1024;

  child.stdout?.on('data', (data: Buffer) => {
    stdoutBuf = appendBounded(stdoutBuf, data.toString(), MAX_BUF_BYTES);
    processOutput(stdoutBuf, (remaining) => { stdoutBuf = remaining; });
  });

  child.stderr?.on('data', (data: Buffer) => {
    stderrBuf = appendBounded(stderrBuf, data.toString(), MAX_BUF_BYTES);
    try {
      const { dbgInfo } = require('../debug-log');
      dbgInfo('tsc_watcher_stderr', { text: stderrBuf.slice(-2000) });
    } catch (err) { swallow(err); }
  });

  child.on('error', (err) => {
    try {
      const { dbgWarn } = require('../debug-log');
      dbgWarn('tsc_watcher_error', { message: err.message });
    } catch (err) { swallow(err); }
    watcherProcess = null;
  });

  child.on('exit', (code) => {
    try {
      const { dbgInfo } = require('../debug-log');
      dbgInfo('tsc_watcher_exit', { code });
    } catch (err) { swallow(err); }
    watcherProcess = null;
  });

  watcherProcess = child;
}

/**
 * Processa o stdout do tsc --watch, extraindo erros.
 * A cada rodada completa (detectada por "Found N errors"), substitui o
 * lastErrorSet.
 */
function processOutput(buf: string, setRemaining: (r: string) => void): void {
  // Procura pelo marcador de fim de rodada: "Found N errors. Watching for file changes."
  const foundMatch = buf.match(/Found\s+\d+\s+errors?\.\s*Watching for file changes\./);
  if (!foundMatch) {
    // Ainda não completou uma rodada — acumula
    setRemaining(buf);
    return;
  }

  const endIdx = foundMatch.index! + foundMatch[0].length;
  const chunk = buf.slice(0, endIdx);

  // Extrai erros do chunk — try both formats, the one that matches wins
  // (parens format is the default for piped tsc, pretty is for TTY).
  const errors = new Map<string, ErrorEntry[]>();
  for (const re of [
    new RegExp(TSC_OUTPUT_RE_PARENS.source, 'gm'),
    new RegExp(TSC_OUTPUT_RE_PRETTY.source, 'gm'),
  ]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(chunk)) !== null) {
      const entry: ErrorEntry = {
        file: path.resolve(match[1]),
        line: parseInt(match[2], 10),
        col: parseInt(match[3], 10),
        code: match[4],
        message: match[5],
      };
      // Dedup against same-position entries already extracted by the
      // other regex (defensive — formats are mutually exclusive in
      // practice but a few weird tsc versions mix them).
      const key = `${entry.file}:${entry.line}:${entry.col}:${entry.code}`;
      let list = errors.get(entry.file);
      if (!list) {
        list = [];
        errors.set(entry.file, list);
      }
      if (!list.some((e) => `${e.file}:${e.line}:${e.col}:${e.code}` === key)) {
        list.push(entry);
      }
    }
  }

  // Substitui o estado interno (tsc emite set completo a cada rodada)
  lastErrorSet = errors;

  // Se tem callback de novos erros, notifica
  if (onNewErrors) {
    const newErrors = computeNewErrors(previousErrorSet, lastErrorSet);
    if (newErrors.size > 0) {
      onNewErrors(newErrors);
    }
  }

  // Descarta o chunk processado
  setRemaining(buf.slice(endIdx));
}

/**
 * Computa erros que existem em `current` mas não em `previous`.
 */
function computeNewErrors(
  previous: Map<string, ErrorEntry[]>,
  current: Map<string, ErrorEntry[]>,
): Map<string, ErrorEntry[]> {
  const result = new Map<string, ErrorEntry[]>();
  for (const [file, entries] of current) {
    const prevEntries = previous.get(file);
    if (!prevEntries) {
      // Arquivo novo com erros
      result.set(file, entries);
      continue;
    }
    // Filtra entradas que não estavam antes
    const prevSet = new Set(prevEntries.map((e) => `${e.line}:${e.col}:${e.code}`));
    const newOnes = entries.filter((e) => !prevSet.has(`${e.line}:${e.col}:${e.code}`));
    if (newOnes.length > 0) {
      result.set(file, newOnes);
    }
  }
  return result;
}

/**
 * Computa erros que desapareceram de `previousErrorSet` em relação a `lastErrorSet`.
 * Retorna array flat de ErrorEntry (operador só precisa saber o que foi resolvido,
 * não agrupado por arquivo).
 * Comparação por chave `${line}:${col}:${code}` — mesma identidade de computeNewErrors.
 */
function computeResolvedErrors(): ErrorEntry[] {
  const current = lastErrorSet;
  const previous = previousErrorSet;
  const resolved: ErrorEntry[] = [];

  for (const [file, entries] of previous) {
    const currentEntries = current.get(file);
    if (!currentEntries) {
      // Arquivo inteiro sumiu — todos os erros resolvidos
      resolved.push(...entries);
      continue;
    }
    // Filtra entradas que ainda estão presentes
    const currentSet = new Set(currentEntries.map((e) => `${e.line}:${e.col}:${e.code}`));
    for (const e of entries) {
      if (!currentSet.has(`${e.line}:${e.col}:${e.code}`)) {
        resolved.push(e);
      }
    }
  }

  return resolved;
}

/**
 * Coleta erros novos E resolvidos desde o último call, atualiza o snapshot.
 * Retorna { newErrors, resolvedErrors }.
 */
export function captureTurnErrors(ctx: ReplContext): { newErrors: Map<string, ErrorEntry[]>; resolvedErrors: ErrorEntry[] } {
  if (!watcherProcess) return { newErrors: new Map(), resolvedErrors: [] };

  // Erros novos = lastErrorSet (completo atual) - previousErrorSet (snapshot anterior)
  const newErrors = computeNewErrors(previousErrorSet, lastErrorSet);

  // Erros resolvidos = previousErrorSet - lastErrorSet
  const resolvedErrors = computeResolvedErrors();

  // Atualiza o snapshot para o próximo captureTurnErrors
  previousErrorSet = new Map(lastErrorSet);

  // Se há erros novos, loga no debug
  if (newErrors.size > 0) {
    try {
      const { dbgInfo } = require('../debug-log');
      let total = 0;
      for (const entries of newErrors.values()) total += entries.length;
      dbgInfo('tsc_watcher_new_errors', { files: newErrors.size, total });
    } catch (err) { swallow(err); }
  }

  return { newErrors, resolvedErrors };
}

/**
 * Para o watcher (SIGTERM, fallback SIGKILL após 3s).
 */
export function stopTypeCheckWatcher(): void {
  if (!watcherProcess) return;
  const child = watcherProcess;
  watcherProcess = null;

  child.kill('SIGTERM');
  setTimeout(() => {
    try {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    } catch (err) { swallow(err); }
  }, 3000);
}

/**
 * Retorna true se o watcher está rodando.
 */
export function isWatcherRunning(): boolean {
  return watcherProcess !== null && watcherProcess.exitCode === null;
}

/**
 * Format new + resolved errors as a compact info-message string.
 * Returns null when both are empty (callsite uses null to skip output).
 * Caps new errors display at 10 entries.
 */
export function formatTurnErrors(
  result: { newErrors: Map<string, ErrorEntry[]>; resolvedErrors: ErrorEntry[] },
  cwd?: string,
): string | null {
  const { newErrors, resolvedErrors } = result;
  const newTotal = (() => {
    let n = 0;
    for (const list of newErrors.values()) n += list.length;
    return n;
  })();
  const resolvedTotal = resolvedErrors.length;

  // Se ambos vazios → return null
  if (newTotal === 0 && resolvedTotal === 0) return null;

  // Só resolvedErrors → mensagem simples sem lista
  if (newTotal === 0) {
    return `[typecheck] ${resolvedTotal} erro(s) resolvido(s) ✓`;
  }

  // Só newErrors (sem resolved)
  if (resolvedTotal === 0) {
    const lines: string[] = [];
    let shown = 0;
    const cwdPrefix = cwd ? cwd.replace(/\/+$/, '') + '/' : '';
    outer: for (const [file, list] of newErrors) {
      for (const e of list) {
        if (shown >= 10) break outer;
        const rel = cwdPrefix && file.startsWith(cwdPrefix) ? file.slice(cwdPrefix.length) : file;
        lines.push(`  ${rel}:${e.line}:${e.col} ${e.code} ${e.message}`);
        shown++;
      }
    }
    const more = newTotal > 10 ? `\n  ...e mais ${newTotal - 10}` : '';
    return `[typecheck] ${newTotal} novo(s) erro(s) cross-file:\n${lines.join('\n')}${more}`;
  }

  // Ambos — prefixo misto
  const lines: string[] = [];
  let shown = 0;
  const cwdPrefix = cwd ? cwd.replace(/\/+$/, '') + '/' : '';
  outer: for (const [file, list] of newErrors) {
    for (const e of list) {
      if (shown >= 10) break outer;
      const rel = cwdPrefix && file.startsWith(cwdPrefix) ? file.slice(cwdPrefix.length) : file;
      lines.push(`  ${rel}:${e.line}:${e.col} ${e.code} ${e.message}`);
      shown++;
    }
  }
  const more = newTotal > 10 ? `\n  ...e mais ${newTotal - 10}` : '';
  return `[typecheck] ${newTotal} novo(s), ${resolvedTotal} resolvido(s):\n${lines.join('\n')}${more}`;
}
