/**
 * `execute` command — helpers module. Extracted from execute.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import chalk from 'chalk';

const dim = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green = chalk.hex('#22C55E');
const cyan = chalk.hex('#22D3EE');
const red = chalk.hex('#EF4444');
const blue = chalk.hex('#60A5FA');
import * as readline from 'readline';

const BLOCKING_VALIDATOR_CODES = new Set([
  'UNIVERSAL_MONOLITH_NAMING',
  'UNIVERSAL_MULTI_CLASS_TS',
  'UNIVERSAL_CONSOLIDATION',
  'DART_MEGA_FILE',
  'DART_CLASS_COLLISION',
]);

const API_ERROR_PATTERNS = [
  /API Error:\s*[45]\d\d/i,
  /Internal server error/i,
  /check status\.claude\.com/i,
  /request[_\s-]?id/i,
];

const TYPE_PRIORITY: Record<string, number> = {
  contracts: 0,
  database: 1,
  backend: 2,
  integration: 3,
  flow: 3,
  mixed: 4,
  infra: 5,
  visual: 6,
  frontend: 6,
};

export const TASK_TYPE_PRIORITY: Record<string, number> = {
  planning: 0,
  database: 1,
  architecture: 2,
  design: 3,
  feature: 4,
  flow: 5,
  test: 6,
  infra: 7,
  bug_fix: 8,
};


export function hasApiErrorText(text: string): boolean {
  return API_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function isBlockingValidationIssue(warning: { code?: string; severity?: string }): boolean {
  if (warning.severity === 'critical') return true;
  if (!warning.code) return false;
  return BLOCKING_VALIDATOR_CODES.has(warning.code);
}

export function remediationHintForCode(code?: string): string | null {
  if (!code) return null;
  if (code === 'DART_MULTI_CLASS_FILE' || code === 'UNIVERSAL_MULTI_CLASS_TS') {
    return 'Split obrigatório: 1 classe/interface/enum/DTO por arquivo. Ex.: UserDto -> user.dto.ts, AppointmentDto -> appointment_dto.dart.';
  }
  if (code === 'DART_MEGA_FILE' || code === 'UNIVERSAL_CONSOLIDATION') {
    return 'Arquivo monolítico detectado: quebrar em arquivos menores por conceito e remover o arquivo agregador.';
  }
  if (code === 'UNIVERSAL_MISSING_FILE') {
    return 'Crie exatamente o arquivo declarado no techContext (mesmo caminho e nome).';
  }
  if (code === 'UNIVERSAL_PATH_DEVIATION') {
    return 'Corrija o path para o caminho literal do techContext; não mova para core/shared/common sem estar declarado.';
  }
  if (code === 'DART_DEAD_ON_ARRIVAL') {
    return 'Conecte o arquivo novo via import real no app ou remova-o se não for necessário.';
  }
  return null;
}

export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

export function typeRank(type?: string): number {
  return TYPE_PRIORITY[type || 'mixed'] ?? 4;
}

export function extractNumericPart(dumNumber?: string): number {
  if (!dumNumber) return 9999;
  const m = dumNumber.match(/\d+/);
  return m ? parseInt(m[0], 10) : 9999;
}
