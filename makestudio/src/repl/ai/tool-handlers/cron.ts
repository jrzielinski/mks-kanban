/**
 * CRON tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolCronCreate(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.name || !input.cron || !input.command) {
    return JSON.stringify({ error: 'name, cron, and command are required' });
  }
  try {
    const { loadSchedules, addSchedule } = require('../../schedule');
    const existing = loadSchedules().find((s: any) => s.name === input.name);
    if (existing) {
      return JSON.stringify({ error: `schedule "${input.name}" already exists (id ${existing.id}). Delete it first or choose a different name.` });
    }
    const created = addSchedule(input.name, input.cron, input.command);
    return JSON.stringify({ ok: true, schedule: created });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}

export async function toolCronList(_input: any, _ctx: ReplContext): Promise<string> {
  try {
    const { loadSchedules } = require('../../schedule');
    const schedules = loadSchedules();
    return JSON.stringify({ count: schedules.length, schedules });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}

export async function toolCronDelete(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.id_or_name) return JSON.stringify({ error: 'id_or_name is required' });
  try {
    const { removeSchedule } = require('../../schedule');
    const removed = removeSchedule(input.id_or_name);
    return JSON.stringify({ ok: removed, id_or_name: input.id_or_name });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}


export const CRON_TOOL_HANDLERS = [
  { name: 'cron_create', handler: toolCronCreate },
  { name: 'cron_list', handler: toolCronList },
  { name: 'cron_delete', handler: toolCronDelete },
];
