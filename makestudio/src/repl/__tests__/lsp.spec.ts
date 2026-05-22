/**
 * Tests for the core LSP client (src/repl/lsp.ts).
 *
 * Only tests exported API — internal functions are tested indirectly
 * through the public interface. child_process.spawn is mocked to avoid
 * starting real LSP servers; fs operations remain real where possible.
 */

import * as lsp from '../lsp';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

// ── Mock child_process ──────────────────────────────────────────────
// We inline jest.fn() here — DO NOT refactor to a variable binding.
// `jest.mock` is hoisted above imports, so any outer reference would be
// TDZ. Access the mock function via `mockSpawn()` below.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, spawn: jest.fn() };
});
function getMockSpawn(): jest.Mock {
  return (jest.requireMock('child_process') as any).spawn;
}

// ── Helpers ─────────────────────────────────────────────────────────
function makeMockProc(): any {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = jest.fn();
  proc.stderr = new EventEmitter();
  proc.stderr.setEncoding = jest.fn();
  proc.stdin = { write: jest.fn() };
  proc.kill = jest.fn();
  proc.pid = 12345;
  return proc;
}

function lspFrame(msg: any): Buffer {
  const body = JSON.stringify(msg);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

// ────────────────────────────────────────────────────────────────────
describe('BUILTIN_SERVERS', () => {
  const keys = Object.keys(lsp.BUILTIN_SERVERS || {});

  it('has at least 20 language servers', () => {
    expect(keys.length).toBeGreaterThanOrEqual(20);
  });

  it.each(keys)('%s has command and extensions', (k) => {
    const s = lsp.BUILTIN_SERVERS![k];
    expect(Array.isArray(s.command)).toBe(true);
    expect(s.command.length).toBeGreaterThan(0);
    expect(Array.isArray(s.extensions)).toBe(true);
    expect(s.extensions.length).toBeGreaterThan(0);
  });

  it('typescript has fallback + installHint', () => {
    expect(lsp.BUILTIN_SERVERS!.typescript.fallback).toBeDefined();
    expect(lsp.BUILTIN_SERVERS!.typescript.installHint).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('reloadLspRegistry', () => {
  it('clears cached registries without throwing', () => {
    expect(() => lsp.reloadLspRegistry()).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('getDiagnostics', () => {
  it('returns null for unsupported file extension', () => {
    expect(lsp.getDiagnostics('/tmp', '/tmp/foo.xyz')).toBeNull();
  });

  it('returns null when no server running', () => {
    expect(lsp.getDiagnostics('/tmp', '/tmp/test.ts')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('shutdownLsp', () => {
  it('clears all servers without throwing (multiple calls safe)', () => {
    expect(() => lsp.shutdownLsp()).not.toThrow();
    expect(() => lsp.shutdownLsp()).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('getLastLspStartupError', () => {
  it('returns null when no error recorded', () => {
    expect(lsp.getLastLspStartupError('typescript', '/tmp')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('lspDefinition', () => {
  let mockProc: any;

  beforeEach(() => {
    mockProc = makeMockProc();
    getMockSpawn().mockReturnValue(mockProc);
    lsp.shutdownLsp();
  });

  afterEach(() => {
    lsp.shutdownLsp();
  });

  it('returns error for unsupported language', async () => {
    // Use a temp dir without any project markers
    const tmp = path.join(os.tmpdir(), 'lsp-empty-' + Date.now());
    require('fs').mkdirSync(tmp, { recursive: true });
    const result = await lsp.lspDefinition(tmp, 'SomeSymbol');
    expect(result.error).toBeDefined();
    require('fs').rmSync(tmp, { recursive: true, force: true });
  });
});

// ────────────────────────────────────────────────────────────────────
describe('lspHover', () => {
  let mockProc: any;

  beforeEach(() => {
    mockProc = makeMockProc();
    getMockSpawn().mockReturnValue(mockProc);
    lsp.shutdownLsp();
  });

  afterEach(() => {
    lsp.shutdownLsp();
  });

  it('returns error for unsupported file type', async () => {
    const result = await lsp.lspHover('/tmp', '/tmp/foo.xyz', 0, 0);
    expect(result.error).toBe('Unsupported file type');
  });

  it('returns hover result for a known file', async () => {
    const tmp = path.join(os.tmpdir(), 'lsp-hover-' + Date.now());
    const fs = require('fs');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'test.ts'), 'const x = 1;\n');

    const promise = lsp.lspHover(tmp, path.join(tmp, 'test.ts'), 0, 5);

    // Simulate initialization response
    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
    }, 10);

    // Simulate hover response
    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({
        jsonrpc: '2.0', id: 2,
        result: { contents: [{ kind: 'markdown', value: '```typescript\nconst x: number\n```' }] },
      }));
    }, 30);

    const result = await promise;
    expect(result.hover).toBeDefined();
    expect(result.hover).toContain('const x: number');

    fs.rmSync(tmp, { recursive: true, force: true });
  }, 10_000);

  it('handles string-only hover contents', async () => {
    const tmp = path.join(os.tmpdir(), 'lsp-hover2-' + Date.now());
    const fs = require('fs');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'test.ts'), 'const x = 1;\n');

    const promise = lsp.lspHover(tmp, path.join(tmp, 'test.ts'), 0, 5);

    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
    }, 10);
    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({
        jsonrpc: '2.0', id: 2,
        result: { contents: 'const x: number' },
      }));
    }, 30);

    const result = await promise;
    expect(result.hover).toBe('const x: number');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 10_000);

  it('returns hover null when no contents', async () => {
    const tmp = path.join(os.tmpdir(), 'lsp-hover3-' + Date.now());
    const fs = require('fs');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'test.ts'), 'const x = 1;\n');

    const promise = lsp.lspHover(tmp, path.join(tmp, 'test.ts'), 0, 5);

    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
    }, 10);
    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({
        jsonrpc: '2.0', id: 2,
        result: { contents: null },
      }));
    }, 30);

    const result = await promise;
    expect(result.hover).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 10_000);
});

// ────────────────────────────────────────────────────────────────────
describe('lspDocumentSymbols', () => {
  let mockProc: any;

  beforeEach(() => {
    mockProc = makeMockProc();
    getMockSpawn().mockReturnValue(mockProc);
    lsp.shutdownLsp();
  });

  afterEach(() => {
    lsp.shutdownLsp();
  });

  it('returns error for unsupported file type', async () => {
    const result = await lsp.lspDocumentSymbols('/tmp', 'foo.xyz');
    expect(result.error).toBe('Unsupported file type');
  });

  it('returns flattened symbols', async () => {
    const tmp = path.join(os.tmpdir(), 'lsp-sym-' + Date.now());
    const fs = require('fs');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'test.ts'), 'class A { method() {} }');

    const promise = lsp.lspDocumentSymbols(tmp, path.join(tmp, 'test.ts'));

    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
    }, 10);
    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({
        jsonrpc: '2.0', id: 2,
        result: [
          { name: 'A', kind: 5, selectionRange: { start: { line: 0 } }, children: [
            { name: 'method', kind: 6, selectionRange: { start: { line: 0 } } },
          ]},
        ],
      }));
    }, 30);

    const result = await promise;
    expect(result.symbols).toHaveLength(2);
    expect(result.symbols[1].name).toBe('A.method');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 10_000);
});

// ────────────────────────────────────────────────────────────────────
describe('lspWorkspaceSymbols', () => {
  let mockProc: any;

  beforeEach(() => {
    mockProc = makeMockProc();
    getMockSpawn().mockReturnValue(mockProc);
    lsp.shutdownLsp();
  });

  afterEach(() => {
    lsp.shutdownLsp();
  });

  it('returns error for unsupported project root', async () => {
    const tmp = path.join(os.tmpdir(), 'lsp-ws-empty-' + Date.now());
    require('fs').mkdirSync(tmp, { recursive: true });
    const result = await lsp.lspWorkspaceSymbols(tmp, 'Foo');
    expect(result.error).toBeDefined();
    require('fs').rmSync(tmp, { recursive: true, force: true });
  });
});

// ────────────────────────────────────────────────────────────────────
describe('lspDefinitionAt / lspReferencesAt', () => {
  let mockProc: any;

  beforeEach(() => {
    mockProc = makeMockProc();
    getMockSpawn().mockReturnValue(mockProc);
    lsp.shutdownLsp();
  });

  afterEach(() => {
    lsp.shutdownLsp();
  });

  it('lspDefinitionAt returns error for unsupported file type', async () => {
    const result = await lsp.lspDefinitionAt('/tmp', '/tmp/foo.xyz', 0, 0);
    expect(result.error).toBe('Unsupported file type');
  });

  it('lspReferencesAt returns error for unsupported file type', async () => {
    const result = await lsp.lspReferencesAt('/tmp', '/tmp/foo.xyz', 0, 0);
    expect(result.error).toBe('Unsupported file type');
  });

  it('lspDefinitionAt returns formatted locations', async () => {
    const tmp = path.join(os.tmpdir(), 'lsp-defat-' + Date.now());
    const fs = require('fs');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'test.ts'), 'const x = 1;');

    const promise = lsp.lspDefinitionAt(tmp, path.join(tmp, 'test.ts'), 0, 6);

    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
    }, 10);
    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({
        jsonrpc: '2.0', id: 2,
        result: [{ uri: `file://${tmp}/test.ts`, range: { start: { line: 0, character: 6 } } }],
      }));
    }, 30);

    const result = await promise;
    expect(result.found).toBe(true);
    expect(result.locations[0].file).toBe('test.ts');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 10_000);

  it('lspReferencesAt returns formatted locations', async () => {
    const tmp = path.join(os.tmpdir(), 'lsp-refat-' + Date.now());
    const fs = require('fs');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'test.ts'), 'const x = 1;');

    const promise = lsp.lspReferencesAt(tmp, path.join(tmp, 'test.ts'), 0, 6);

    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
    }, 10);
    setTimeout(() => {
      mockProc.stdout.emit('data', lspFrame({
        jsonrpc: '2.0', id: 2,
        result: [{ uri: `file://${tmp}/test.ts`, range: { start: { line: 0, character: 0 } } }],
      }));
    }, 30);

    const result = await promise;
    expect(result.found).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 10_000);
});

// ────────────────────────────────────────────────────────────────────
describe('lspImplementation / lspIncomingCalls / lspOutgoingCalls', () => {
  let mockProc: any;

  beforeEach(() => {
    mockProc = makeMockProc();
    getMockSpawn().mockReturnValue(mockProc);
    lsp.shutdownLsp();
  });

  afterEach(() => {
    lsp.shutdownLsp();
  });

  it('lspImplementation returns error for unsupported file', async () => {
    const result = await lsp.lspImplementation('/tmp', '/tmp/foo.xyz', 1, 1);
    expect(result.error).toBe('Unsupported file type');
  });

  it('lspIncomingCalls returns error for unsupported file', async () => {
    const result = await lsp.lspIncomingCalls('/tmp', '/tmp/foo.xyz', 1, 1);
    expect(result.error).toBe('Unsupported file type');
  });

  it('lspOutgoingCalls returns error for unsupported file', async () => {
    const result = await lsp.lspOutgoingCalls('/tmp', '/tmp/foo.xyz', 1, 1);
    expect(result.error).toBe('Unsupported file type');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('Server lifecycle — error paths', () => {
  beforeEach(() => {
    lsp.shutdownLsp();
  });

  afterEach(() => {
    lsp.shutdownLsp();
  });

  it('handles spawn failure and records startup error', async () => {
    getMockSpawn().mockImplementation(() => { throw new Error('ENOENT'); });

    // lspDefinition logs the error via lastStartupError
    const tmp = path.join(os.tmpdir(), 'lsp-spawnfail-' + Date.now());
    const fs = require('fs');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}');

    const result = await lsp.lspDefinition(tmp, 'Foo');
    expect(result.error).toBeDefined();
    // lspDefinition wraps the error in its own message
    expect(result.error).toContain('Failed to start');

    const err = lsp.getLastLspStartupError('typescript', tmp);
    expect(err).not.toBeNull();
    expect(err!.error).toBe(true);
    expect(err!.lang).toBe('typescript');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
