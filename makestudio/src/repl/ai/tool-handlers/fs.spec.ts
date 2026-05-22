import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('FS_TOOL_HANDLERS', () => {
  it('exports the handlers array', () => {
    const mod = require('./fs');
    const key = Object.keys(mod).find(k => k.endsWith('_TOOL_HANDLERS'));
    expect(key).toBeDefined();
    // @ts-ignore
    expect(Array.isArray(mod[key])).toBe(true);
  });

  it('each handler entry has name and function', () => {
    const mod = require('./fs');
    const key = Object.keys(mod).find(k => k.endsWith('_TOOL_HANDLERS'));
    // @ts-ignore
    for (const entry of mod[key]) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.handler).toBe('function');
    }
  });
});

describe('toolReadFile', () => {
  const { toolReadFile } = require('./fs');

  it('returns a JSON error (not a Node TypeError) when fields are missing', async () => {
    const out = await toolReadFile({}, {} as any);
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/projectPath/);
    expect(parsed.error).toMatch(/filePath/);
    expect(parsed.got).toEqual({ projectPath: 'undefined', filePath: 'undefined' });
  });

  it('redirects "pasted_content_<N>.txt" placeholder paths to read_attachment', async () => {
    const out = await toolReadFile(
      { projectPath: '/home/x/project', filePath: 'pasted_content_53.txt' },
      {} as any,
    );
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/paste/i);
    expect(parsed.hint).toMatch(/read_attachment\(id=53\)/);
  });

  it('redirects "[Pasted #N]" style references too', async () => {
    const out = await toolReadFile(
      { projectPath: '/home/x/project', filePath: '[Pasted #7]' },
      {} as any,
    );
    const parsed = JSON.parse(out);
    expect(parsed.hint).toMatch(/read_attachment\(id=7\)/);
  });

  it('redirects on-disk attachment paths (~/.makestudio/attachments/paste-*.txt) to the right id', async () => {
    const out = await toolReadFile(
      {
        projectPath: '/home/x/project',
        filePath: '/home/x/.makestudio/attachments/paste-1778006920490-54.txt',
      },
      {} as any,
    );
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/on-disk attachment file/);
    // id=54, NOT id=1778006920490 (the timestamp prefix). The regex must
    // capture only the trailing numeric id segment after the second dash.
    expect(parsed.hint).toMatch(/read_attachment\(id=54\)/);
  });

  it('blocks reading the attachments manifest.json directly', async () => {
    const out = await toolReadFile(
      {
        projectPath: '/home/x/project',
        filePath: '/home/x/.makestudio/attachments/manifest.json',
      },
      {} as any,
    );
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/manifest is internal/);
    expect(parsed.hint).toMatch(/read_attachment\(id=N\)/);
  });

  it('returns a JSON-shaped error with hint when safePath rejects an absolute filePath outside projectPath', async () => {
    // Repro of the "Path traversal blocked" raw throw the operator hit on
    // 2026-05-05 — model passed an absolute filePath that resolves above
    // projectPath. We now wrap with a friendly JSON error so the model
    // can see what went wrong instead of receiving a raw Error message.
    const out = await toolReadFile(
      {
        projectPath: '/home/zielinski/develop/gptapi/agent',
        filePath: '/home/zielinski/develop/gptapi',
      },
      {} as any,
    );
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/rejected the path/);
    expect(parsed.hint).toMatch(/RELATIVE to projectPath/);
    expect(parsed.got).toEqual({
      projectPath: '/home/zielinski/develop/gptapi/agent',
      filePath: '/home/zielinski/develop/gptapi',
    });
  });

  it('reads a real file normally', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-spec-'));
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'world\n');
    const out = await toolReadFile(
      { projectPath: tmpDir, filePath: 'hello.txt' },
      {} as any,
    );
    expect(out).toBe('world\n');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
