/**
 * Barrel for all tool handlers.
 */

import { CRON_TOOL_HANDLERS } from './cron';
import { DISPATCH_TOOL_HANDLERS } from './dispatch';
import { DUM_TOOL_HANDLERS } from './dum';
import { FS_TOOL_HANDLERS } from './fs';
import { GIT_TOOL_HANDLERS } from './git';
import { LSP_TOOL_HANDLERS } from './lsp';
import { MCP_TOOL_HANDLERS } from './mcp';
import { MEMORY_TOOL_HANDLERS } from './memory';
import { SESSION_CONSTRAINT_TOOL_HANDLERS } from './session-constraint';
import { SHELL_TOOL_HANDLERS } from './shell';
import { WEB_TOOL_HANDLERS } from './web';

import type { ReplContext } from '../../context';

export interface ToolHandler {
  name: string;
  handler: (input: any, ctx: ReplContext) => Promise<string>;
}

export const ALL_TOOL_HANDLERS: ToolHandler[] = [
  ...CRON_TOOL_HANDLERS,
  ...DISPATCH_TOOL_HANDLERS,
  ...DUM_TOOL_HANDLERS,
  ...FS_TOOL_HANDLERS,
  ...GIT_TOOL_HANDLERS,
  ...LSP_TOOL_HANDLERS,
  ...MCP_TOOL_HANDLERS,
  ...MEMORY_TOOL_HANDLERS,
  ...SESSION_CONSTRAINT_TOOL_HANDLERS,
  ...SHELL_TOOL_HANDLERS,
  ...WEB_TOOL_HANDLERS,
];

const handlerMap = new Map(ALL_TOOL_HANDLERS.map(h => [h.name, h.handler]));

export function findToolHandler(name: string): ((input: any, ctx: ReplContext) => Promise<string>) | undefined {
  return handlerMap.get(name);
}
