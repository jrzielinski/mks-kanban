/**
 * SHELL tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolShellRun(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.command) return JSON.stringify({ error: 'command is required' });
  const { analyzeCommand, requestApproval } = require('../../security');
  const { execSandboxed, levelForRisk, detectSandboxBackend } = require('../../sandbox');
  const check = analyzeCommand(input.command);
  if (check.risk === 'dangerous') {
    const approved = await requestApproval(check);
    if (!approved) {
      return JSON.stringify({ error: 'Blocked by security policy', risk: 'dangerous', reasons: check.reasons });
    }
  } else if (check.risk === 'warn') {
    console.log(`\n  \x1B[33m⚠\x1B[0m ${check.reasons.join('; ')}: ${input.command}`);
  }

  const sandboxLevel = input.sandboxLevel || levelForRisk(check.risk);
  const backend = detectSandboxBackend();
  const result = execSandboxed(input.command, {
    level: sandboxLevel,
    cwd: input.projectPath,
    projectRoot: input.projectPath,
    allowNetwork: true,
    timeout: 60_000,
  });

  if (result.exitCode !== 0) {
    return JSON.stringify({
      error: `Command exited with code ${result.exitCode}`,
      stdout: result.stdout.substring(0, 2000),
      stderr: result.stderr.substring(0, 2000),
      exitCode: result.exitCode,
      sandbox: { level: sandboxLevel, backend, active: result.sandboxed },
    });
  }

  return truncate(result.stdout, 5000) + (result.sandboxed ? '' : `\n[no sandbox — ${backend}]`);
}


export const SHELL_TOOL_HANDLERS = [
  { name: 'shell_run', handler: toolShellRun },
];
