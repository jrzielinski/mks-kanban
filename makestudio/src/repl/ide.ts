import { swallow } from '../utils/log';
/**
 * IDE Integration — connects to VS Code extension via MCP-over-SSE.
 *
 * The VS Code extension runs an SSE server on localhost:<port> with a lockfile
 * at ~/.claude/ide/<port>.lock. We connect as an MCP client.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import { EventEmitter } from 'events';

interface LockfileContent {
  pid: number;
  workspaceFolders: string[];
  authToken: string;
  transport: 'sse';
  version: number;
}

export interface McpToolDef {
  serverName: string;
  name: string;
  description: string;
  inputSchema: any;
}

interface PendingRequest {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
}

export class IdeClient {
  public name: string;
  public tools: McpToolDef[] = [];
  public events = new EventEmitter();
  private authToken: string;
  private baseUrl: string;
  private reqId = 0;
  private pending = new Map<number, PendingRequest>();
  private disconnected = false;

  private constructor(opts: {
    name: string;
    baseUrl: string;
    authToken: string;
  }) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.authToken = opts.authToken;
  }

  /** Scan ~/.claude/ide/*.lock, connect to first eligible extension. */
  static async connect(): Promise<IdeClient | null> {
    const lockDir = path.join(os.homedir(), '.claude', 'ide');
    let lockFiles: string[];
    try {
      lockFiles = fs.readdirSync(lockDir);
    } catch {
      return null;
    }

    const ports = lockFiles
      .filter((f) => f.endsWith('.lock'))
      .map((f) => parseInt(f.replace('.lock', ''), 10))
      .filter((n) => !isNaN(n))
      .sort((a, b) => b - a); // newest port first

    for (const port of ports) {
      const lockPath = path.join(lockDir, `${port}.lock`);
      let lock: LockfileContent;
      try {
        lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        continue;
      }

      // Verify the process is alive
      try {
        process.kill(lock.pid, 0);
      } catch {
        // Dead process — remove stale lockfile
        try { fs.unlinkSync(lockPath); } catch (err) { swallow(err); }
        continue;
      }

      const baseUrl = `http://127.0.0.1:${port}`;

      // Quick health check: try a GET on the SSE endpoint
      try {
        await httpGet(baseUrl + '/sse');
      } catch {
        continue; // extension not responding
      }

      const client = new IdeClient({
        name: `vscode-${port}`,
        baseUrl,
        authToken: lock.authToken,
      });

      // Fetch tool list
      await client.initialize();
      return client;
    }

    return null;
  }

  private async initialize(): Promise<void> {
    // Step 1: initialize handshake
    const initResp = await this.sendRequest('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'makestudio', version: '1.0.0' },
      capabilities: {},
    });

    // Step 2: send initialized notification (fire-and-forget)
    this.sendNotification('notifications/initialized', {});

    // Step 3: list tools
    const toolResp = await this.sendRequest('tools/list', {});

    this.tools = (toolResp?.tools || []).map((t: any) => ({
      serverName: this.name,
      name: `${this.name}.${t.name}`,
      description: `[${this.name}] ${t.description || t.name}`,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  async callTool(toolName: string, args: any): Promise<string> {
    if (this.disconnected) {
      return JSON.stringify({ error: 'IDE disconnected' });
    }

    try {
      const result = await this.sendRequest('tools/call', {
        name: toolName,
        arguments: args,
      });

      const content = result?.content;
      if (Array.isArray(content)) {
        return content
          .map((c: any) => {
            if (c.type === 'text') return c.text;
            if (c.type === 'resource') return JSON.stringify({ resource: c.resource });
            return JSON.stringify(c);
          })
          .join('\n');
      }
      return JSON.stringify(result);
    } catch (err: any) {
      return JSON.stringify({ error: err.message });
    }
  }

  dispose(): void {
    this.disconnected = true;
    // Reject all pending requests
    for (const [id, p] of this.pending) {
      p.reject(new Error('IDE client disconnected'));
      this.pending.delete(id);
    }
  }

  // ── JSON-RPC helpers ──

  private async sendRequest(method: string, params: any): Promise<any> {
    const id = ++this.reqId;
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const response = await this.httpPost('/message', body);
    const parsed = JSON.parse(response);

    if (parsed.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }

    return parsed.result;
  }

  private sendNotification(method: string, params: any): void {
    // Fire-and-forget — no response expected
    const body = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.httpPost('/message', body).catch(() => {
      /* ignore */
    });
  }

  private async httpPost(pathname: string, body: any): Promise<string> {
    const url = `${this.baseUrl}${pathname}?authToken=${this.authToken}`;
    const u = new URL(url);

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: u.hostname,
          port: Number(u.port),
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
          res.on('end', () => resolve(raw));
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

/** Helper: simple HTTP GET (used for health check). */
function httpGet(url: string): Promise<string> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: u.hostname, port: Number(u.port), path: u.pathname },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}
