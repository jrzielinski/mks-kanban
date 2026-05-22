import { loadConfig } from '../config/config';
import { getApiClient } from '../network/api-client';
import { detectInstalledCLIs } from '../core/cli-detector';
import { logError } from '../ui/terminal';
import { isJsonMode, emitSuccess } from '../utils/output-format';
import chalk from 'chalk';

import { swallow } from '../utils/log';
export interface StatusBlockData {
  serverUrl: string;
  tenantId: string;
  clis: Array<{ name: string; version: string }>;
  license: {
    plan?: string;
    seats?: { used: number; total: number };
    tasks?: { used: number; total: number };
  } | null;
  agents: Array<{ hostname: string; availableCLIs: string[]; status: string }> | null;
}

/**
 * Pure: render the /status block as a single multi-line string. No
 * timestamps, no blank rows, label-aligned columns. Mirrors the
 * formatVersionBlock style. Exposed for unit testing.
 */
export function formatStatusBlock(data: StatusBlockData): string {
  const cyan = chalk.cyan;
  const dim = chalk.dim;
  const bold = chalk.bold;
  const LABEL_W = 9;
  const pad = (s: string) => s.padEnd(LABEL_W);
  const lines: string[] = [
    `  ${cyan('┌─')} ${cyan('✦')} ${bold('makestudio')} ${dim('· status')}`,
  ];
  const row = (label: string, value: string) => {
    lines.push(`  ${cyan('│')}  ${dim(pad(label))} ${value}`);
  };

  row('servidor', data.serverUrl);
  row('tenant', data.tenantId);

  if (data.clis.length > 0) {
    const clisStr = data.clis.map((c) => `${c.name} (${c.version})`).join(dim(' · '));
    row('CLIs', clisStr);
  } else {
    row('CLIs', dim('nenhum CLI de IA detectado (claude, codex, gemini)'));
  }

  if (data.license) {
    const planStr = data.license.plan ? bold(data.license.plan.toUpperCase()) : dim('—');
    const metaParts: string[] = [];
    if (data.license.seats) metaParts.push(`${data.license.seats.used}/${data.license.seats.total} seats`);
    if (data.license.tasks) metaParts.push(`${data.license.tasks.used}/${data.license.tasks.total} tasks`);
    const meta = metaParts.length > 0 ? dim(`  (${metaParts.join(' · ')})`) : '';
    row('plano', `${planStr}${meta}`);
  }

  if (data.agents !== null) {
    if (data.agents.length === 0) {
      row('agents', dim('nenhum conectado'));
    } else {
      // First agent inline; remaining ones one per row, indented to the
      // value column. Keeps the block contiguous (no blank rows) when
      // there are several agents connected.
      const formatAgent = (a: { hostname: string; availableCLIs: string[]; status: string }) =>
        `${chalk.green('●')} ${a.hostname} ${dim(`— ${a.availableCLIs.join(', ')} (${a.status})`)}`;
      const [first, ...rest] = data.agents;
      row('agents', formatAgent(first));
      for (const a of rest) {
        lines.push(`  ${cyan('│')}  ${pad('')} ${formatAgent(a)}`);
      }
    }
  }

  lines.push(`  ${cyan('└──')}`);
  return lines.join('\n');
}

export async function statusCommand(options: { json?: boolean } = {}): Promise<void> {
  const config = loadConfig();

  if (!config?.token) {
    if (isJsonMode(options)) {
      const { emitError } = require('../utils/output-format');
      emitError('Not authenticated. Run: makestudio login');
      return;
    }
    logError('Não autenticado. Execute: makestudio login');
    process.exit(1);
  }

  const clis = detectInstalledCLIs();
  let licenseData: any = null;
  let agentsData: any = null;

  try {
    const api = getApiClient();
    const { data } = await api.get('/dark-factory/agents/license');
    licenseData = data;
  } catch (err) { swallow(err); }

  try {
    const api = getApiClient();
    const { data } = await api.get('/dark-factory/agents/connected');
    agentsData = data;
  } catch (err) { swallow(err); }

  if (isJsonMode(options)) {
    emitSuccess({
      serverUrl: config.serverUrl,
      tenantId: config.tenantId || null,
      authenticated: true,
      clis: clis.map((c) => ({ name: c.name, version: c.version })),
      license: licenseData,
      agents: agentsData,
    });
    return;
  }

  console.log(
    formatStatusBlock({
      serverUrl: config.serverUrl,
      tenantId: config.tenantId || 'desconhecido',
      clis: clis.map((c) => ({ name: c.name, version: c.version })),
      license: licenseData,
      agents: agentsData,
    }),
  );
}
