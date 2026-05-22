/**
 * GIT tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolGitStatus(input: any, _ctx: ReplContext): Promise<string> {
  const out = execSync('git status --short', {
    cwd: input.projectPath,
    timeout: 10_000,
  }).toString();
  return out || '(clean working tree)';
}

export async function toolGitLog(input: any, _ctx: ReplContext): Promise<string> {
  const count = input.count || 10;
  const out = execSync(`git log --oneline -${count}`, {
    cwd: input.projectPath,
    timeout: 10_000,
  }).toString();
  return out;
}


export const GIT_TOOL_HANDLERS = [
  { name: 'git_status', handler: toolGitStatus },
  { name: 'git_log', handler: toolGitLog },
];
