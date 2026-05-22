/**
 * MCP tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolMcpListServers(_input: any, _ctx: ReplContext): Promise<string> {
  try {
    const { listMcpServers } = require('../../mcp');
    const servers = listMcpServers();
    return JSON.stringify({ count: servers.length, servers });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}

export async function toolMcpReadResource(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.uri) return JSON.stringify({ error: 'uri is required' });
  try {
    const { readMcpResource } = require('../../mcp');
    const content = await readMcpResource(input.uri);
    return JSON.stringify({ ok: true, uri: input.uri, content });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}

export async function toolMcpGetPrompt(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.name) return JSON.stringify({ error: 'name is required' });
  try {
    const { getMcpPrompt } = require('../../mcp');
    const rendered = await getMcpPrompt(input.name, input.args || {});
    return JSON.stringify({ ok: true, name: input.name, rendered });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}


export const MCP_TOOL_HANDLERS = [
  { name: 'mcp_list_servers', handler: toolMcpListServers },
  { name: 'mcp_read_resource', handler: toolMcpReadResource },
  { name: 'mcp_get_prompt', handler: toolMcpGetPrompt },
];
