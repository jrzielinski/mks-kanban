/**
 * MEMORY tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolMemorySave(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.name || !input.body) return JSON.stringify({ error: 'name and body required' });
  const { saveTopic } = require('../../memory');
  saveTopic({ name: input.name, body: input.body, tags: input.tags || [] });
  return JSON.stringify({ ok: true, name: input.name });
}

export async function toolMemorySearch(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.query) return JSON.stringify({ error: 'query required' });
  const { findRelevant, touchTopic } = require('../../memory');
  const results = findRelevant(input.query, 5);
  for (const r of results) touchTopic(r.name);
  return JSON.stringify({
    query: input.query,
    count: results.length,
    topics: results.map((r: any) => ({
      name: r.name,
      tags: r.tags,
      body: r.body.substring(0, 1500),
    })),
  }, null, 2);
}


export const MEMORY_TOOL_HANDLERS = [
  { name: 'memory_save', handler: toolMemorySave },
  { name: 'memory_search', handler: toolMemorySearch },
];
