import { swallow } from '../utils/log';
/**
 * Full MCP (Model Context Protocol) client — stdio JSON-RPC with framing.
 *
 * Implements:
 *   - initialize / initialized
 *   - tools/list, tools/call
 *   - resources/list, resources/read, resources/subscribe, resources/unsubscribe
 *   - prompts/list, prompts/get
 *   - notifications: tools/list_changed, resources/list_changed, prompts/list_changed,
 *     resources/updated, progress, cancelled
 *
 * Protocol version: 2024-11-05.
 * Framing: LSP-style "Content-Length: N\r\n\r\n<body>" for stdio.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { subprocessEnv } from './subprocess-env';
import { IdeClient } from './ide';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpTool {
  serverName: string;
  name: string;
  description: string;
  inputSchema: any;
}

export interface McpResource {
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  serverName: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: any) => void;
  timeout: NodeJS.Timeout;
  method: string;
}

export type McpServerStatus = 'starting' | 'ready' | 'error' | 'exited';

interface McpClient {
  name: string;
  process: ChildProcess;
  nextId: number;
  pending: Map<number | string, PendingRequest>;
  buffer: Buffer;
  contentLength: number | null;
  useLineFraming: boolean;  // fallback for servers that use newline-delimited JSON
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  subscribedUris: Set<string>;
  capabilities: any;
  events: EventEmitter;
  // Phase 13 — runtime state surfaced to the UI.
  status: McpServerStatus;
  startedAt: number;
  lastError?: string;
  restarts: number;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Ring buffer of recent stderr lines. Cap 200 to keep memory bounded
   *  even if a chatty MCP server runs for hours without restart. */
  stderrRing: string[];
}

const STDERR_RING_CAP = 200;

const clients = new Map<string, McpClient>();
const ideClients = new Map<string, IdeClient>();
export const mcpEvents = new EventEmitter();  // global event bus for notifications

/**
 * Raises stderr cap se um servidor lança muito (debugging temporário). Usar
 * com cuidado — sem default seguro pra evitar leak silencioso.
 */
export function setStderrRingCap(cap: number): void {
  if (cap > 0 && cap < 100_000) {
    (globalThis as any).__MCP_STDERR_CAP = cap;
  }
}
function effectiveStderrCap(): number {
  const v = (globalThis as any).__MCP_STDERR_CAP;
  return typeof v === 'number' && v > 0 ? v : STDERR_RING_CAP;
}

/**
 * Locks anti-TOCTOU pra `initMcpServers`. Gap entre `clients.has(name)` e
 * `clients.set(name, client)` (que é async via startServer) deixava duas
 * chamadas paralelas spawnarem dois processos do mesmo server.
 */
const inFlightInits = new Map<string, Promise<McpClient | null>>();

function loadConfig(cwd: string): Record<string, McpServerConfig> {
  const sources = [
    path.join(os.homedir(), '.makestudio', 'mcp.json'),
    path.join(cwd, '.makestudio', 'mcp.json'),
  ];
  const merged: Record<string, McpServerConfig> = {};
  for (const src of sources) {
    try {
      if (fs.existsSync(src)) {
        const data = JSON.parse(fs.readFileSync(src, 'utf8'));
        Object.assign(merged, data.servers || data.mcpServers || {});
      }
    } catch (err) { swallow(err); }
  }
  return merged;
}

function sendMessage(client: McpClient, msg: any): void {
  const body = JSON.stringify(msg);
  // Default to LSP-style framing; some MCP servers use newline-delimited JSON
  const payload = client.useLineFraming
    ? body + '\n'
    : `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  try {
    client.process.stdin?.write(payload);
  } catch (err) { swallow(err); }
}

function sendNotification(client: McpClient, method: string, params: any): void {
  sendMessage(client, { jsonrpc: '2.0', method, params });
}

async function sendRequest(client: McpClient, method: string, params: any, timeoutMs: number = 30_000): Promise<any> {
  const id = client.nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (client.pending.has(id)) {
        client.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }
    }, timeoutMs);
    client.pending.set(id, { resolve, reject, timeout, method });
    sendMessage(client, { jsonrpc: '2.0', id, method, params });
  });
}

function processBuffer(client: McpClient): void {
  while (true) {
    // First try LSP-style framing
    if (!client.useLineFraming) {
      if (client.contentLength === null) {
        const headerEnd = client.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          // Might be newline-delimited JSON — check first char
          const firstChar = client.buffer.toString('utf8', 0, 1);
          if (firstChar === '{' || firstChar === '[') {
            client.useLineFraming = true;
            continue;
          }
          return;
        }
        const header = client.buffer.slice(0, headerEnd).toString('utf8');
        const m = header.match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          client.buffer = client.buffer.slice(headerEnd + 4);
          continue;
        }
        client.contentLength = parseInt(m[1], 10);
        client.buffer = client.buffer.slice(headerEnd + 4);
      }
      if (client.buffer.length < client.contentLength!) return;
      const body = client.buffer.slice(0, client.contentLength!).toString('utf8');
      client.buffer = client.buffer.slice(client.contentLength!);
      client.contentLength = null;
      handleBody(client, body);
    } else {
      // Line-delimited framing
      const nl = client.buffer.indexOf('\n');
      if (nl === -1) return;
      const line = client.buffer.slice(0, nl).toString('utf8').trim();
      client.buffer = client.buffer.slice(nl + 1);
      if (line) handleBody(client, line);
    }
  }
}

function handleBody(client: McpClient, body: string): void {
  let msg: any;
  try { msg = JSON.parse(body); } catch { return; }

  // Response to our request?
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = client.pending.get(msg.id);
    if (!pending) return;
    client.pending.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.error) pending.reject(new Error(msg.error.message || 'MCP error'));
    else pending.resolve(msg.result);
    return;
  }

  // Notification from server
  if (msg.method) {
    handleNotification(client, msg.method, msg.params);
  }
}

function handleNotification(client: McpClient, method: string, params: any): void {
  switch (method) {
    case 'notifications/tools/list_changed':
      refreshTools(client).catch(() => {});
      mcpEvents.emit('tools_list_changed', { server: client.name });
      break;
    case 'notifications/resources/list_changed':
      refreshResources(client).catch(() => {});
      mcpEvents.emit('resources_list_changed', { server: client.name });
      break;
    case 'notifications/prompts/list_changed':
      refreshPrompts(client).catch(() => {});
      mcpEvents.emit('prompts_list_changed', { server: client.name });
      break;
    case 'notifications/resources/updated':
      mcpEvents.emit('resource_updated', { server: client.name, uri: params?.uri });
      break;
    case 'notifications/progress':
      mcpEvents.emit('progress', { server: client.name, ...params });
      break;
    case 'notifications/cancelled':
      mcpEvents.emit('cancelled', { server: client.name, ...params });
      break;
    case 'notifications/message':
      mcpEvents.emit('log', { server: client.name, ...params });
      break;
  }
}

async function refreshTools(client: McpClient): Promise<void> {
  try {
    const resp = await sendRequest(client, 'tools/list', {});
    client.tools = (resp?.tools || []).map((t: any) => ({
      serverName: client.name,
      name: `${client.name}.${t.name}`,
      description: `[${client.name}] ${t.description || t.name}`,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
  } catch (err) { swallow(err); }
}

async function refreshResources(client: McpClient): Promise<void> {
  try {
    const resp = await sendRequest(client, 'resources/list', {});
    client.resources = (resp?.resources || []).map((r: any) => ({
      serverName: client.name,
      uri: r.uri,
      name: r.name || r.uri,
      description: r.description,
      mimeType: r.mimeType,
    }));
  } catch (err) { swallow(err); }
}

async function refreshPrompts(client: McpClient): Promise<void> {
  try {
    const resp = await sendRequest(client, 'prompts/list', {});
    client.prompts = (resp?.prompts || []).map((p: any) => ({
      serverName: client.name,
      name: `${client.name}.${p.name}`,
      description: p.description,
      arguments: p.arguments,
    }));
  } catch (err) { swallow(err); }
}

async function startServer(name: string, config: McpServerConfig): Promise<McpClient | null> {
  const proc = spawn(config.command, config.args || [], {
    env: { ...subprocessEnv(), ...config.env },
    cwd: config.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const client: McpClient = {
    name,
    process: proc,
    nextId: 1,
    pending: new Map(),
    buffer: Buffer.alloc(0),
    contentLength: null,
    useLineFraming: false,
    tools: [],
    resources: [],
    prompts: [],
    subscribedUris: new Set(),
    capabilities: {},
    events: new EventEmitter(),
    status: 'starting',
    startedAt: Date.now(),
    restarts: 0,
    command: config.command,
    args: config.args ?? [],
    env: config.env,
    stderrRing: [],
  };

  const onStdout = (chunk: Buffer): void => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    processBuffer(client);
  };
  const onStderr = (chunk: Buffer): void => {
    const lines = chunk.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const cap = effectiveStderrCap();
    for (const line of lines) {
      client.stderrRing.push(`${new Date().toISOString()} ${line}`);
    }
    while (client.stderrRing.length > cap) client.stderrRing.shift();
    mcpEvents.emit('log', { name, stream: 'stderr', lines });
  };
  const onError = (err: Error): void => {
    client.status = 'error';
    client.lastError = err.message;
    clients.delete(name);
    mcpEvents.emit('server_status_changed', { name, status: 'error', error: err.message });
  };
  const onExit = (code: number | null): void => {
    for (const p of client.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(new Error('MCP server exited'));
    }
    client.pending.clear();
    client.status = 'exited';
    if (code != null && code !== 0) client.lastError = `exited with code ${code}`;
    // Cleanup listeners pra não vazar handles em init failure path.
    proc.stdout?.off('data', onStdout);
    proc.stderr?.off('data', onStderr);
    proc.off('error', onError);
    clients.delete(name);
    mcpEvents.emit('server_exited', { name, code });
    mcpEvents.emit('server_status_changed', { name, status: 'exited' });
  };

  proc.stdout?.on('data', onStdout);
  proc.stderr?.on('data', onStderr);
  proc.on('error', onError);
  proc.on('exit', onExit);

  try {
    const initResp = await sendRequest(client, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
      clientInfo: { name: 'makestudio', version: '1.0' },
    }, 20_000);
    client.capabilities = initResp?.capabilities || {};
    sendNotification(client, 'notifications/initialized', {});
  } catch (err: any) {
    client.status = 'error';
    client.lastError = err?.message ?? 'initialize failed';
    try { proc.kill(); } catch (err) { swallow(err); }
    // Listeners removidos no exit handler — proc.kill dispara exit normalmente.
    return null;
  }

  // Refresh em paralelo: sequential antes podia tomar até 90s (3 × 30s timeout).
  await Promise.allSettled([
    client.capabilities.tools ? refreshTools(client) : Promise.resolve(),
    client.capabilities.resources ? refreshResources(client) : Promise.resolve(),
    client.capabilities.prompts ? refreshPrompts(client) : Promise.resolve(),
  ]);

  client.status = 'ready';
  mcpEvents.emit('server_status_changed', { name, status: 'ready' });
  return client;
}

// ── Public API ────────────────────────────────────────────────────

/** Plugins can inject MCP server configs at boot via plugin-repl-bridge.
 *  Merged with disk-loaded configs; plugin names win on collision. */
const pluginMcpConfigs: Record<string, any> = {};
export function registerPluginMcpServer(s: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'http';
}): void {
  if (!s?.name || !s?.command) throw new Error('mcp server needs name + command');
  pluginMcpConfigs[s.name] = {
    command: s.command,
    args: s.args || [],
    env: s.env || {},
    transport: s.transport || 'stdio',
  };
}
export function __clearPluginMcpForTests(): void {
  for (const k of Object.keys(pluginMcpConfigs)) delete pluginMcpConfigs[k];
}

/** Return the NAMES of every MCP server the REPL considers configured.
 *  Includes disk + plugin-registered. Consumed by the custom-agent
 *  requiredMcpServers guard in tools.ts:dispatch_agent. */
export function getConfiguredMcpServers(cwd?: string): string[] {
  try {
    const disk = cwd ? loadConfig(cwd) : {};
    return [...new Set([...Object.keys(disk), ...Object.keys(pluginMcpConfigs)])];
  } catch { return Object.keys(pluginMcpConfigs); }
}

export async function initMcpServers(cwd: string): Promise<{ tools: McpTool[]; resources: McpResource[]; prompts: McpPrompt[] }> {
  const diskConfigs = loadConfig(cwd);
  // Merge plugin configs on top — plugins win on name collision so a
  // plugin author can shadow a broken user MCP entry.
  const configs = { ...diskConfigs, ...pluginMcpConfigs };
  const allTools: McpTool[] = [];
  const allResources: McpResource[] = [];
  const allPrompts: McpPrompt[] = [];

  for (const [name, config] of Object.entries(configs)) {
    // Lock anti-TOCTOU: dois chamadores concorrentes viam `clients.has(name)`
    // false antes do primeiro `clients.set` e spawnavam dois processos.
    // Compartilhar a mesma promise garante single spawn por server.
    if (!clients.has(name)) {
      let pending = inFlightInits.get(name);
      if (!pending) {
        pending = startServer(name, config).then((client) => {
          if (client) clients.set(name, client);
          return client;
        }).finally(() => {
          inFlightInits.delete(name);
        });
        inFlightInits.set(name, pending);
      }
      await pending;
    }
    const client = clients.get(name);
    if (!client) continue;
    allTools.push(...client.tools);
    allResources.push(...client.resources);
    allPrompts.push(...client.prompts);
  }

  // Connect to VS Code extension if available
  const ideClient = await IdeClient.connect();
  if (ideClient) {
    ideClients.set(ideClient.name, ideClient);
    for (const tool of ideClient.tools) {
      allTools.push(tool);
    }
  }

  return { tools: allTools, resources: allResources, prompts: allPrompts };
}

export async function callMcpTool(toolName: string, args: any): Promise<string> {
  const [serverName, method] = toolName.split('.', 2);

  // Check IDE clients first
  const ideClient = ideClients.get(serverName);
  if (ideClient) {
    return ideClient.callTool(method, args);
  }

  const client = clients.get(serverName);
  if (!client) return JSON.stringify({ error: `MCP server ${serverName} not running` });

  try {
    const result = await sendRequest(client, 'tools/call', {
      name: method,
      arguments: args,
    });
    const content = result?.content;
    if (Array.isArray(content)) {
      return content.map((c: any) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'resource') return JSON.stringify({ resource: c.resource });
        return JSON.stringify(c);
      }).join('\n');
    }
    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

export async function readMcpResource(uri: string): Promise<string> {
  // Find server that has this URI
  for (const client of clients.values()) {
    if (client.resources.some((r) => r.uri === uri)) {
      try {
        const result = await sendRequest(client, 'resources/read', { uri });
        const contents = result?.contents;
        if (Array.isArray(contents)) {
          return contents.map((c: any) => c.text || c.blob || '').join('\n');
        }
        return JSON.stringify(result);
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    }
  }
  return JSON.stringify({ error: `Resource ${uri} not found in any MCP server` });
}

export async function getMcpPrompt(promptName: string, args: Record<string, any>): Promise<string> {
  const [serverName, method] = promptName.split('.', 2);
  const client = clients.get(serverName);
  if (!client) return JSON.stringify({ error: `MCP server ${serverName} not running` });

  try {
    const result = await sendRequest(client, 'prompts/get', {
      name: method,
      arguments: args,
    });
    const messages = result?.messages;
    if (Array.isArray(messages)) {
      return messages.map((m: any) => {
        const content = Array.isArray(m.content)
          ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
          : (m.content?.text || JSON.stringify(m.content));
        return `[${m.role}]\n${content}`;
      }).join('\n\n');
    }
    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

export async function subscribeToResource(uri: string): Promise<boolean> {
  for (const client of clients.values()) {
    if (client.resources.some((r) => r.uri === uri)) {
      try {
        await sendRequest(client, 'resources/subscribe', { uri });
        client.subscribedUris.add(uri);
        return true;
      } catch { return false; }
    }
  }
  return false;
}

export async function unsubscribeFromResource(uri: string): Promise<boolean> {
  for (const client of clients.values()) {
    if (client.subscribedUris.has(uri)) {
      try {
        await sendRequest(client, 'resources/unsubscribe', { uri });
        client.subscribedUris.delete(uri);
        return true;
      } catch { return false; }
    }
  }
  return false;
}

export function listMcpServers(): Array<{
  name: string; status: McpServerStatus; tools: number; resources: number; prompts: number;
  capabilities: any; lastError?: string; startedAt: number; restarts: number;
  command?: string; args?: string[]; env?: Record<string, string>;
}> {
  // Inclui também servers configurados mas não-running (status 'exited' ou nunca iniciados)
  // pra UI poder mostrar todos no list, não só os ativos.
  const out: ReturnType<typeof listMcpServers> = Array.from(clients.values()).map((c) => ({
    name: c.name,
    status: c.status,
    tools: c.tools.length,
    resources: c.resources.length,
    prompts: c.prompts.length,
    capabilities: c.capabilities,
    lastError: c.lastError,
    startedAt: c.startedAt,
    restarts: c.restarts,
    command: c.command,
    args: c.args,
    env: c.env,
  }));
  return out;
}

/**
 * Detalhamento completo de um server pra UI: tools+resources+prompts com
 * inputSchema/uri/arguments + tail de stderr ring buffer.
 */
export function getMcpServerDetail(name: string, logsLimit = 200): {
  name: string;
  status: McpServerStatus;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  logs: string[];
  lastError?: string;
  startedAt: number;
  command?: string;
  args?: string[];
} | null {
  const c = clients.get(name);
  if (!c) return null;
  const logs = logsLimit >= c.stderrRing.length ? [...c.stderrRing] : c.stderrRing.slice(-logsLimit);
  return {
    name: c.name,
    status: c.status,
    tools: [...c.tools],
    resources: [...c.resources],
    prompts: [...c.prompts],
    logs,
    lastError: c.lastError,
    startedAt: c.startedAt,
    command: c.command,
    args: c.args,
  };
}

export function getMcpStderr(name: string, limit = 200): string[] {
  const c = clients.get(name);
  if (!c) return [];
  return limit >= c.stderrRing.length ? [...c.stderrRing] : c.stderrRing.slice(-limit);
}

// ── Phase 13: write API ───────────────────────────────────────────────

function mcpConfigPath(scope: 'user' | 'project', cwd?: string): string {
  if (scope === 'project') {
    return path.join(cwd || process.cwd(), '.makestudio', 'mcp.json');
  }
  return path.join(os.homedir(), '.makestudio', 'mcp.json');
}

function readMcpConfigFile(file: string): Record<string, McpServerConfig> {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return (data.servers || data.mcpServers || {}) as Record<string, McpServerConfig>;
  } catch {
    return {};
  }
}

function writeMcpConfigFile(file: string, servers: Record<string, McpServerConfig>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Preserva a chave `mcpServers` se o usuário já tinha esse formato; senão usa `servers`.
  let existing: any = {};
  try { existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
  catch (err) { swallow(err); }
  const out = existing.mcpServers !== undefined
    ? { ...existing, mcpServers: servers }
    : { ...existing, servers };
  // tmp + rename pra atomic write — evita race com leituras concorrentes.
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export async function addMcpServer(
  name: string,
  config: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string },
  scope: 'user' | 'project' = 'user',
  projectCwd?: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = String(name).trim();
  if (!trimmed || /[^a-zA-Z0-9._-]/.test(trimmed)) {
    return { ok: false, error: 'Invalid server name (a-z, 0-9, dot, dash, underscore)' };
  }
  if (typeof config.command !== 'string' || !config.command.trim()) {
    return { ok: false, error: 'command is required' };
  }
  const file = mcpConfigPath(scope, projectCwd);
  const current = readMcpConfigFile(file);
  current[trimmed] = {
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
  };
  writeMcpConfigFile(file, current);
  // Spawn imediato — se já tinha um client com esse nome (ex: re-add), kill primeiro.
  if (clients.has(trimmed)) {
    try { clients.get(trimmed)!.process.kill(); } catch (err) { swallow(err); }
    clients.delete(trimmed);
  }
  const client = await startServer(trimmed, current[trimmed]);
  if (client) clients.set(trimmed, client);
  return { ok: true };
}

export function removeMcpServer(
  name: string,
  scope: 'user' | 'project' = 'user',
  projectCwd?: string,
): { ok: boolean; error?: string } {
  const file = mcpConfigPath(scope, projectCwd);
  const current = readMcpConfigFile(file);
  if (!(name in current)) return { ok: false, error: `server "${name}" not found in ${scope} config` };
  delete current[name];
  writeMcpConfigFile(file, current);
  const client = clients.get(name);
  if (client) {
    try { client.process.kill(); } catch (err) { swallow(err); }
    clients.delete(name);
  }
  return { ok: true };
}

// Guard against concurrent restartMcpServer calls for the same server.
const inFlightRestarts = new Map<string, Promise<{ ok: boolean; error?: string }>>();

export async function restartMcpServer(name: string, cwd?: string): Promise<{ ok: boolean; error?: string }> {
  const inflight = inFlightRestarts.get(name);
  if (inflight) return inflight;
  const p = _doRestart(name, cwd).finally(() => inFlightRestarts.delete(name));
  inFlightRestarts.set(name, p);
  return p;
}

async function _doRestart(name: string, cwd?: string): Promise<{ ok: boolean; error?: string }> {
  const existing = clients.get(name);
  const prevRestarts = existing?.restarts ?? 0;
  let config: McpServerConfig | undefined;
  if (existing) {
    config = { command: existing.command, args: existing.args, env: existing.env };
    try { existing.process.kill(); } catch (err) { swallow(err); }
    clients.delete(name);
  } else {
    // Não está running — busca config no disco/plugin.
    const disk = loadConfig(cwd ?? process.cwd());
    config = disk[name] ?? pluginMcpConfigs[name];
  }
  if (!config) return { ok: false, error: `no config for "${name}"` };
  const client = await startServer(name, config);
  if (!client) return { ok: false, error: 'startServer returned null — verify command + args' };
  client.restarts = prevRestarts + 1;
  clients.set(name, client);
  return { ok: true };
}

export function shutdownMcp(): void {
  for (const ideClient of ideClients.values()) {
    ideClient.dispose();
  }
  ideClients.clear();
  for (const client of clients.values()) {
    try { client.process.kill(); } catch (err) { swallow(err); }
  }
  clients.clear();
}
