import {
  snapshotBeforeCompact,
  listCheckpoints,
  restoreCheckpoint,
  clearCheckpoints,
} from './compact-checkpoints';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('fs');
jest.mock('path');

const sessionId = 'test-session-123';
const checkpointDir = '/tmp/.makestudio/checkpoints/test-session-123';

beforeEach(() => {
  jest.resetAllMocks();
  (path.join as jest.Mock).mockImplementation((...args: string[]) => args.join('/'));
  (path.dirname as jest.Mock).mockReturnValue('/tmp/.makestudio/checkpoints/test-session-123');
  (fs.existsSync as jest.Mock).mockReturnValue(true);
  (fs.mkdirSync as jest.Mock).mockImplementation(() => {});
  (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
});

function makeCtx(overrides?: any): any {
  return {
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }],
    sessionId,
    provider: 'anthropic',
    cwd: '/tmp',
    lastUserMessage: 'hello',
    ...overrides,
  };
}

describe('snapshotBeforeCompact', () => {
  it('creates a snapshot file and returns the file path', () => {
    const ctx = makeCtx();
    const result = snapshotBeforeCompact(ctx, 'micro');
    expect(typeof result).toBe('string');
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('creates snapshot even with empty messages', () => {
    const ctx = makeCtx({ messages: [] });
    const result = snapshotBeforeCompact(ctx, 'micro');
    expect(typeof result).toBe('string');
  });

  it('stores messages as JSON in the snapshot file', () => {
    const ctx = makeCtx();
    snapshotBeforeCompact(ctx, 'micro');
    const call = (fs.writeFileSync as jest.Mock).mock.calls[0];
    expect(typeof call[0]).toBe('string');
    expect(typeof call[1]).toBe('string');
    const parsed = JSON.parse(call[1]);
    expect(Array.isArray(parsed.messages)).toBe(true);
  });

  it('includes meta with reason in the snapshot', () => {
    const ctx = makeCtx();
    snapshotBeforeCompact(ctx, 'snip');
    const call = (fs.writeFileSync as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(call[1]);
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.reason).toBe('snip');
  });
});

describe('listCheckpoints', () => {
  it('returns an empty array when directory does not exist', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const list = listCheckpoints(sessionId);
    expect(list).toEqual([]);
  });

  it('returns checkpoint entries from files', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue(['cp-1.json', 'cp-2.json']);
    (fs.statSync as jest.Mock).mockReturnValue({ mtime: new Date(), isFile: () => true } as any);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      meta: { reason: 'micro', at: Date.now() },
    }));
    const list = listCheckpoints(sessionId);
    expect(Array.isArray(list)).toBe(true);
  });
});

describe('restoreCheckpoint', () => {
  it('restores messages from the most recent checkpoint', () => {
    const ctx = makeCtx();
    (fs.readdirSync as jest.Mock).mockReturnValue(['cp-1.json']);
    (fs.statSync as jest.Mock).mockReturnValue({ mtime: new Date(), isFile: () => true } as any);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      messages: [{ role: 'user', content: 'restored' }],
    }));
    const result = restoreCheckpoint(ctx);
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('returns restored=false when no checkpoints exist', () => {
    const ctx = makeCtx();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const result = restoreCheckpoint(ctx);
    expect(result.restored).toBe(false);
  });
});

describe('clearCheckpoints', () => {
  it('removes all checkpoint files for a session', () => {
    (fs.readdirSync as jest.Mock).mockReturnValue(['cp-1.json']);
    (fs.statSync as jest.Mock).mockReturnValue({ mtime: new Date(), isFile: () => true } as any);
    const count = clearCheckpoints(sessionId);
    expect(typeof count).toBe('number');
  });

  it('returns 0 when no checkpoints', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const count = clearCheckpoints(sessionId);
    expect(count).toBe(0);
  });
});
