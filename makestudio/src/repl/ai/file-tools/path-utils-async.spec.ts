import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileWithMetadata, readFileWithMetadataAsync } from './path-utils';

describe('readFileWithMetadataAsync', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pathutils-async-'));
  });

  afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns same shape as the sync version', async () => {
    const f = path.join(tmp, 'plain.txt');
    fs.writeFileSync(f, 'hello\nworld\n', 'utf8');
    const sync = readFileWithMetadata(f);
    const asyncRes = await readFileWithMetadataAsync(f);
    expect(asyncRes).toEqual(sync);
  });

  it('detects LF line endings', async () => {
    const f = path.join(tmp, 'lf.txt');
    fs.writeFileSync(f, 'a\nb\nc\n');
    const r = await readFileWithMetadataAsync(f);
    expect(r.lineEnding).toBe('lf');
    expect(r.bom).toBe(false);
    expect(r.text).toBe('a\nb\nc\n');
  });

  it('detects CRLF line endings and normalises to LF in text', async () => {
    const f = path.join(tmp, 'crlf.txt');
    fs.writeFileSync(f, 'a\r\nb\r\nc\r\n');
    const r = await readFileWithMetadataAsync(f);
    expect(r.lineEnding).toBe('crlf');
    expect(r.text).toBe('a\nb\nc\n');
  });

  it('strips and reports UTF-8 BOM', async () => {
    const f = path.join(tmp, 'bom.txt');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]));
    const r = await readFileWithMetadataAsync(f);
    expect(r.bom).toBe(true);
    expect(r.text).toBe('hi');
  });

  it('handles empty files', async () => {
    const f = path.join(tmp, 'empty.txt');
    fs.writeFileSync(f, '');
    const r = await readFileWithMetadataAsync(f);
    expect(r.text).toBe('');
    expect(r.bom).toBe(false);
    expect(r.lineEnding).toBe('lf');
  });

  it('rejects with ENOENT for missing file', async () => {
    await expect(readFileWithMetadataAsync('/nonexistent/path/xyz.txt')).rejects.toThrow();
  });
});
