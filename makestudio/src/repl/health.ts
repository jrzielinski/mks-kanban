/**
 * health.ts — fast aggregate of system-state checks for the Doctor page.
 *
 * Distinct from `core/doctor.ts` (heavy stack-runner that runs npm install
 * / docker compose / build) and from `commands/health.ts` (CLI-only ping).
 * This module returns a structured snapshot in <5s with no side effects so
 * the Phase 10 DoctorPage "Health" tab can mount sozinha.
 *
 * Each check returns a HealthCheckDTO `{ name, status, message?, fix? }`:
 *   - pass: green
 *   - warn: yellow (degraded but functional)
 *   - fail: red (something broken — fix surfaced)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HealthCheckDTO } from './ipc/types';

export interface HealthReport {
  checks: HealthCheckDTO[];
  ranAt: string;
  durationMs: number;
}

export type HealthCheckSkip = 'cli' | 'auth' | 'mcp' | 'permissions' | 'storage' | 'network';

export interface HealthRunOptions {
  cwd?: string;
  skip?: HealthCheckSkip[];
}

// ── individual checks ─────────────────────────────────────────────────────────

function checkCli(): HealthCheckDTO {
  try {
    // Lazy require — `core/cli-detector` isn't always present in the
    // electron bundle. Fall back to a manual detection if missing.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { detectInstalledCLIs } = require('../core/cli-detector');
    const detected = detectInstalledCLIs() as Array<{ name: string; version: string }>;
    if (detected.length === 0) {
      return {
        name: 'CLI',
        status: 'fail',
        message: 'Nenhum CLI de IA detectado (claude, codex, gemini)',
        fix: 'Instale uma das CLIs suportadas e adicione ao PATH',
      };
    }
    return {
      name: 'CLI',
      status: 'pass',
      message: detected.map((c) => `${c.name} ${c.version}`).join(', '),
    };
  } catch (e: any) {
    return {
      name: 'CLI',
      status: 'warn',
      message: `Detector indisponível: ${e?.message ?? e}`,
    };
  }
}

function checkAuth(): HealthCheckDTO {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadConfig } = require('../config/config');
    const cfg = loadConfig() as { token?: string; serverUrl?: string; expiresAt?: string };
    if (!cfg?.token) {
      return {
        name: 'Auth',
        status: 'fail',
        message: 'Sem token salvo',
        fix: 'Rode `makestudio login` ou use Account → Login no app',
      };
    }
    if (cfg.expiresAt) {
      const expMs = Date.parse(cfg.expiresAt);
      const now = Date.now();
      if (Number.isFinite(expMs)) {
        if (expMs < now) {
          return {
            name: 'Auth',
            status: 'fail',
            message: 'Token expirado',
            fix: 'Account → Refresh ou `makestudio login`',
          };
        }
        const daysLeft = Math.round((expMs - now) / (1000 * 60 * 60 * 24));
        if (daysLeft < 7) {
          return {
            name: 'Auth',
            status: 'warn',
            message: `Token expira em ${daysLeft}d (${cfg.serverUrl ?? 'servidor não configurado'})`,
            fix: 'Account → Refresh',
          };
        }
      }
    }
    return {
      name: 'Auth',
      status: 'pass',
      message: cfg.serverUrl ? `Logado em ${cfg.serverUrl}` : 'Token presente',
    };
  } catch (e: any) {
    return { name: 'Auth', status: 'warn', message: `Não foi possível verificar: ${e?.message ?? e}` };
  }
}

function checkMcp(): HealthCheckDTO {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./mcp');
    // Tenta `mcpStatusAll` (preferido) — fallback `getMcpStatus` ou similar.
    const fn = mod.mcpStatusAll || mod.getMcpStatus || mod.statusAll;
    if (!fn) {
      return { name: 'MCP', status: 'warn', message: 'Status snapshot não exposto pelo módulo mcp' };
    }
    const status = fn() as Array<{ name: string; connected: boolean; error?: string }> | Record<string, any>;
    const list = Array.isArray(status) ? status : Object.values(status);
    if (list.length === 0) {
      return { name: 'MCP', status: 'pass', message: 'Nenhum MCP server configurado' };
    }
    const connected = list.filter((s) => s?.connected).length;
    if (connected === list.length) {
      return { name: 'MCP', status: 'pass', message: `${connected}/${list.length} servers conectados` };
    }
    if (connected === 0) {
      return {
        name: 'MCP',
        status: 'fail',
        message: `Nenhum dos ${list.length} servers conectados`,
        fix: 'Verifique configuração em ~/.makestudio/mcp.json e logs em DebugLogs',
      };
    }
    return {
      name: 'MCP',
      status: 'warn',
      message: `${connected}/${list.length} servers conectados`,
    };
  } catch (e: any) {
    return { name: 'MCP', status: 'warn', message: `Indisponível: ${e?.message ?? e}` };
  }
}

function checkPermissions(): HealthCheckDTO {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadPolicy, detectShadowedRules } = require('./permissions');
    const policy = loadPolicy();
    const shadows = detectShadowedRules(policy) as Array<unknown>;
    if (shadows.length > 0) {
      return {
        name: 'Permissions',
        status: 'warn',
        message: `${shadows.length} regra(s) sombreada(s) — algumas nunca disparam`,
        fix: 'Settings → Permissions → revisar avisos de regras sombreadas',
      };
    }
    return {
      name: 'Permissions',
      status: 'pass',
      message: `${policy.rules?.length ?? 0} regras carregadas, default=${policy.policy ?? 'ask'}`,
    };
  } catch (e: any) {
    return {
      name: 'Permissions',
      status: 'fail',
      message: `Falha ao carregar policy: ${e?.message ?? e}`,
      fix: 'Verifique sintaxe de ~/.makestudio/permissions.json',
    };
  }
}

function checkStorage(): HealthCheckDTO {
  const dir = path.join(os.homedir(), '.makestudio');
  // `fs.statfs` is the only portable way to read disk free in node — but
  // it's only available on linux/macos node ≥18.15. Wrap in feature
  // detection so windows / older nodes degrade to a soft `note` state.
  const statfs = (fs as any).statfsSync as ((p: string) => { bavail: number; bsize: number }) | undefined;
  if (typeof statfs !== 'function') {
    return {
      name: 'Storage',
      status: 'warn',
      message: 'Disk-free check sem suporte nesta plataforma/versão de Node',
    };
  }
  try {
    const stat = statfs(dir);
    const freeBytes = stat.bavail * stat.bsize;
    const freeMb = Math.round(freeBytes / (1024 * 1024));
    if (freeMb < 10) {
      return {
        name: 'Storage',
        status: 'fail',
        message: `Apenas ${freeMb}MB livres em ${dir}`,
        fix: 'Limpe sessões antigas e logs em ~/.makestudio/',
      };
    }
    if (freeMb < 100) {
      return {
        name: 'Storage',
        status: 'warn',
        message: `${freeMb}MB livres — considere limpar sessões antigas`,
      };
    }
    return {
      name: 'Storage',
      status: 'pass',
      message: `${(freeMb / 1024).toFixed(1)}GB livres em ~/.makestudio`,
    };
  } catch (e: any) {
    return { name: 'Storage', status: 'warn', message: `Indisponível: ${e?.message ?? e}` };
  }
}

async function checkNetwork(): Promise<HealthCheckDTO> {
  // We probe the same backend the heartbeat uses, with a hard 3s ceiling so
  // a flaky DNS doesn't block the whole report.
  const url = process.env.MAKESTUDIO_HEALTH_URL ?? 'https://api.zielinski.dev.br/health';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    timer.unref?.();
    try {
      const res = await (globalThis as any).fetch(url, { signal: ctrl.signal });
      if (res.ok) return { name: 'Network', status: 'pass', message: `${url} → ${res.status}` };
      if (res.status >= 500) {
        return {
          name: 'Network',
          status: 'warn',
          message: `${url} → ${res.status} (servidor indisponível)`,
        };
      }
      return { name: 'Network', status: 'warn', message: `${url} → ${res.status}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    return {
      name: 'Network',
      status: 'fail',
      message: `Falha ao alcançar ${url}: ${e?.message ?? e}`,
      fix: 'Verifique conectividade ou ajuste MAKESTUDIO_HEALTH_URL',
    };
  }
}

// ── orchestrator ──────────────────────────────────────────────────────────────

export async function runHealthChecks(opts: HealthRunOptions = {}): Promise<HealthReport> {
  const skip = new Set(opts.skip ?? []);
  const startedAt = Date.now();

  // Synchronous checks run first — fast path. Network is the only async one.
  const checks: HealthCheckDTO[] = [];
  if (!skip.has('cli')) checks.push(checkCli());
  if (!skip.has('auth')) checks.push(checkAuth());
  if (!skip.has('mcp')) checks.push(checkMcp());
  if (!skip.has('permissions')) checks.push(checkPermissions());
  if (!skip.has('storage')) checks.push(checkStorage());
  if (!skip.has('network')) checks.push(await checkNetwork());

  return {
    checks,
    ranAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}
