/**
 * DISPATCH tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolDispatchAgentsParallel(input: any, ctx: ReplContext): Promise<string> {
  const { executeDispatchAgentsParallel } = require('../subagent-dispatch');
  return await executeDispatchAgentsParallel(ctx, input);
}

export async function toolDispatchAgent(input: any, ctx: ReplContext): Promise<string> {
  const { executeDispatchAgent } = require('../subagent-dispatch');
  return await executeDispatchAgent(ctx, input);
}

export async function toolListSubagentSessions(input: any, _ctx: ReplContext): Promise<string> {
  try {
    const { listSessions } = require('../subagent-pool');
    let sessions = listSessions();
    if (input.subagent_type) {
      sessions = sessions.filter((s: any) => s.subagentType === input.subagent_type);
    }
    return JSON.stringify({
      count: sessions.length,
      sessions: sessions.map((s: any) => ({
        id: s.id,
        subagent_type: s.subagentType,
        created_at: new Date(s.createdAt).toISOString(),
        updated_at: new Date(s.updatedAt).toISOString(),
        age_hours: Math.round((Date.now() - s.updatedAt) / 3600000 * 10) / 10,
        messages: s.messageCount,
        tokens: s.totalTokens,
        description: s.description || null,
      })),
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}

export async function toolDropSubagentSession(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.subagent_type || !input.session_id) {
    return JSON.stringify({ error: 'subagent_type and session_id are required' });
  }
  try {
    const { dropSession } = require('../subagent-pool');
    const dropped = dropSession(input.subagent_type, input.session_id);
    return JSON.stringify({ ok: dropped, subagent_type: input.subagent_type, session_id: input.session_id });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}


export const DISPATCH_TOOL_HANDLERS = [
  { name: 'dispatch_agents_parallel', handler: toolDispatchAgentsParallel },
  { name: 'dispatch_agent', handler: toolDispatchAgent },
  { name: 'list_subagent_sessions', handler: toolListSubagentSessions },
  { name: 'drop_subagent_session', handler: toolDropSubagentSession },
];
