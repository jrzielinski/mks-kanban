import { swallow } from '../../../utils/log';
/**
 * LSP tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolFindDefinition(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.symbol) return JSON.stringify({ error: 'symbol is required' });
  const sym = input.symbol.replace(/[^a-zA-Z0-9_$]/g, '');
  if (!sym) return JSON.stringify({ error: 'invalid symbol' });
  // Try real LSP first
  try {
    const { lspDefinition } = require('../../lsp');
    const result = await lspDefinition(input.projectPath, sym);
    if (!result.error) return JSON.stringify({ symbol: sym, ...result }, null, 2);
  } catch (err) { swallow(err); }
  // Fallback: grep-based
  return await fallbackGrepDefinition(input.projectPath, sym);
}

export async function toolFindReferences(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.symbol) return JSON.stringify({ error: 'symbol is required' });
  const sym = input.symbol.replace(/[^a-zA-Z0-9_$]/g, '');
  if (!sym) return JSON.stringify({ error: 'invalid symbol' });
  try {
    const { lspReferences } = require('../../lsp');
    const result = await lspReferences(input.projectPath, sym);
    if (!result.error) return truncate(JSON.stringify({ symbol: sym, ...result }, null, 2));
  } catch (err) { swallow(err); }
  return await fallbackGrepReferences(input.projectPath, sym);
}

export async function toolGetSymbols(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.filePath) return JSON.stringify({ error: 'filePath is required' });
  const abs = safePath(input.projectPath, input.filePath);
  if (!fs.existsSync(abs)) return JSON.stringify({ error: `File not found: ${input.filePath}` });
  // Try real LSP first
  try {
    const { lspDocumentSymbols } = require('../../lsp');
    const result = await lspDocumentSymbols(input.projectPath, input.filePath);
    if (!result.error) return JSON.stringify({ file: input.filePath, ...result }, null, 2);
  } catch (err) { swallow(err); }
  // Fallback
  return await fallbackGrepSymbols(abs, input.filePath);
}

export async function toolHover(input: any, _ctx: ReplContext): Promise<string> {
  if (!input.filePath || input.line === undefined || input.character === undefined) {
    return JSON.stringify({ error: 'filePath, line, character required' });
  }
  try {
    const { lspHover } = require('../../lsp');
    const result = await lspHover(input.projectPath, input.filePath, input.line, input.character);
    return JSON.stringify(result, null, 2);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}


export const LSP_TOOL_HANDLERS = [
  { name: 'find_definition', handler: toolFindDefinition },
  { name: 'find_references', handler: toolFindReferences },
  { name: 'get_symbols', handler: toolGetSymbols },
  { name: 'hover', handler: toolHover },
];
