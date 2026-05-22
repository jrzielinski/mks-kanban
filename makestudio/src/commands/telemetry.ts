/**
 * `makestudio telemetry` — render a summary of decomposition telemetry
 * collected by per-requirement-loop.
 *
 * Reads the local JSONL files in `.makestudio/telemetry/` and prints
 * aggregate stats: tempo médio por requirement, retry rate, top causas
 * de retry, breakdown por CLI. Use this to validate that a refactor
 * (Fase 1+) actually moved the needle.
 *
 * Subcommands:
 *   makestudio telemetry          → summary of the most recent JSONL file
 *   makestudio telemetry --all    → aggregate across ALL files in the dir
 *   makestudio telemetry --json   → emit raw aggregated JSON
 *   makestudio telemetry --file <path>  → summary of a specific file
 *
 * Project-aware: defaults to the current working dir's `.makestudio/`.
 */

import * as path from 'path';
import { listTelemetryFiles, summarizeJsonl, TelemetrySummary } from '../decompose/telemetry';
import chalk from 'chalk';

interface TelemetryOptions {
  all?: boolean;
  json?: boolean;
  file?: string;
}

const c = {
  dim: chalk.hex('#64748B'),
  cyan: chalk.hex('#22D3EE'),
  green: chalk.hex('#22C55E'),
  yellow: chalk.hex('#FBBF24'),
  red: chalk.hex('#EF4444'),
  bold: chalk.bold,
};

export async function telemetryCommand(opts: TelemetryOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const files = listTelemetryFiles(cwd);

  if (opts.file) {
    return renderSingle(path.resolve(opts.file), opts);
  }

  if (files.length === 0) {
    console.log();
    console.log(c.yellow('  ⚠  Nenhum arquivo de telemetria encontrado.'));
    console.log(c.dim(`     Esperado em: ${path.join(cwd, '.makestudio', 'telemetry')}`));
    console.log(c.dim('     Rode uma decomposição (makestudio start --auto / refine) para gerar dados.'));
    console.log();
    return;
  }

  if (opts.all) {
    return renderAggregated(files, opts);
  }

  // Default: most recent file
  return renderSingle(files[0], opts);
}

function renderSingle(filePath: string, opts: TelemetryOptions): void {
  const summary = summarizeJsonl(filePath);
  if (opts.json) {
    console.log(JSON.stringify(serializeSummary(summary), null, 2));
    return;
  }
  console.log();
  console.log(c.cyan('  ◆ Telemetria de Decomposição'));
  console.log(c.dim(`  Arquivo: ${filePath}`));
  printSummary(summary);
}

function renderAggregated(files: string[], opts: TelemetryOptions): void {
  // Aggregate by re-reading all files and merging counts. Easier than
  // keeping two code paths — performance is fine (these files are KB,
  // not MB, even for huge projects).
  const merged = files.reduce<TelemetrySummary>((acc, file) => mergeSummaries(acc, summarizeJsonl(file)), emptySummary());
  if (opts.json) {
    console.log(JSON.stringify(serializeSummary(merged), null, 2));
    return;
  }
  console.log();
  console.log(c.cyan(`  ◆ Telemetria de Decomposição — agregado (${files.length} arquivos)`));
  printSummary(merged);
}

function emptySummary(): TelemetrySummary {
  return {
    totalRuns: 0,
    totalRequirements: 0,
    successfulRequirements: 0,
    failedRequirements: 0,
    retryRate: 0,
    avgTimeToFirstWriteMs: 0,
    avgTimeToValidateMs: 0,
    avgTimeToSaveMs: 0,
    avgTotalDurationMs: 0,
    topCausesOfRetry: [],
    byCli: new Map(),
  };
}

/**
 * Merge two summaries by re-weighting averages by sample size.
 * Approximate (loses precision for very imbalanced files) but good
 * enough for human-facing aggregation.
 */
function mergeSummaries(a: TelemetrySummary, b: TelemetrySummary): TelemetrySummary {
  const totalReqs = a.totalRequirements + b.totalRequirements;
  if (totalReqs === 0) return a;
  const weight = (avgA: number, nA: number, avgB: number, nB: number): number =>
    Math.round((avgA * nA + avgB * nB) / Math.max(1, nA + nB));

  const causes = new Map<string, number>();
  for (const c of [...a.topCausesOfRetry, ...b.topCausesOfRetry]) {
    causes.set(c.cause, (causes.get(c.cause) || 0) + c.count);
  }

  const byCli = new Map(a.byCli);
  for (const [cli, stat] of b.byCli) {
    const existing = byCli.get(cli);
    if (!existing) {
      byCli.set(cli, stat);
    } else {
      const totalCount = existing.count + stat.count;
      byCli.set(cli, {
        count: totalCount,
        avgMs: Math.round((existing.avgMs * existing.count + stat.avgMs * stat.count) / totalCount),
        retryRate:
          (existing.retryRate * existing.count + stat.retryRate * stat.count) / totalCount,
      });
    }
  }

  const aRetried = a.retryRate * a.totalRequirements;
  const bRetried = b.retryRate * b.totalRequirements;

  return {
    totalRuns: a.totalRuns + b.totalRuns,
    totalRequirements: totalReqs,
    successfulRequirements: a.successfulRequirements + b.successfulRequirements,
    failedRequirements: a.failedRequirements + b.failedRequirements,
    retryRate: (aRetried + bRetried) / totalReqs,
    avgTimeToFirstWriteMs: weight(a.avgTimeToFirstWriteMs, a.totalRequirements, b.avgTimeToFirstWriteMs, b.totalRequirements),
    avgTimeToValidateMs: weight(a.avgTimeToValidateMs, a.totalRequirements, b.avgTimeToValidateMs, b.totalRequirements),
    avgTimeToSaveMs: weight(a.avgTimeToSaveMs, a.totalRequirements, b.avgTimeToSaveMs, b.totalRequirements),
    avgTotalDurationMs: weight(a.avgTotalDurationMs, a.totalRequirements, b.avgTotalDurationMs, b.totalRequirements),
    topCausesOfRetry: [...causes.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 10)
      .map(([cause, count]) => ({ cause, count })),
    byCli,
  };
}

function printSummary(s: TelemetrySummary): void {
  if (s.totalRequirements === 0) {
    console.log();
    console.log(c.dim('  Nenhum requirement processado ainda.'));
    console.log();
    return;
  }
  const successRate = s.successfulRequirements / s.totalRequirements;
  const rateColor = successRate >= 0.9 ? c.green : successRate >= 0.7 ? c.yellow : c.red;
  const retryColor = s.retryRate <= 0.15 ? c.green : s.retryRate <= 0.3 ? c.yellow : c.red;

  console.log(c.dim('  ' + '─'.repeat(60)));
  console.log(`  Runs:                ${c.bold(String(s.totalRuns))}`);
  console.log(`  Requirements:        ${c.bold(String(s.totalRequirements))}`);
  console.log(`    ${c.green('✓ ok:')}            ${rateColor((successRate * 100).toFixed(1) + '%')}  (${s.successfulRequirements})`);
  console.log(`    ${c.red('✗ failed:')}        ${s.failedRequirements}`);
  console.log(`  Retry rate:          ${retryColor((s.retryRate * 100).toFixed(1) + '%')}`);
  console.log();
  console.log(c.dim('  Tempo médio por requirement:'));
  console.log(`    First write:       ${formatMs(s.avgTimeToFirstWriteMs)}`);
  console.log(`    Validate:          ${formatMs(s.avgTimeToValidateMs)}`);
  console.log(`    Save:              ${formatMs(s.avgTimeToSaveMs)}`);
  console.log(`    ${c.bold('TOTAL:')}             ${c.bold(formatMs(s.avgTotalDurationMs))}`);
  console.log();

  if (s.byCli.size > 0) {
    console.log(c.dim('  Por CLI:'));
    for (const [cli, stat] of s.byCli) {
      console.log(`    ${c.cyan(cli.padEnd(12))} ${stat.count.toString().padStart(4)} reqs  ·  avg ${formatMs(stat.avgMs)}  ·  retry ${(stat.retryRate * 100).toFixed(1)}%`);
    }
    console.log();
  }

  if (s.topCausesOfRetry.length > 0) {
    console.log(c.dim('  Top causas de retry:'));
    for (const row of s.topCausesOfRetry.slice(0, 8)) {
      console.log(`    ${c.yellow('●')} ${row.cause.padEnd(40)} ${String(row.count).padStart(4)}`);
    }
    console.log();
  }
}

function formatMs(ms: number): string {
  if (ms === 0) return c.dim('—');
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/**
 * Convert the summary's Map to a plain object so JSON.stringify works
 * cleanly. Used only when --json is requested.
 */
function serializeSummary(s: TelemetrySummary): Record<string, unknown> {
  return {
    ...s,
    byCli: Object.fromEntries(s.byCli),
  };
}
