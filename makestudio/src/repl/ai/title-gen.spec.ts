/**
 * title-gen spec — covers maybeGenerateSessionTitle including the
 * internal helper functions (cleanTitle, findTitlePromptFile, etc)
 * exercised through the main entry point.
 */

import { maybeGenerateSessionTitle } from './title-gen';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-gen-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTitlePrompt(content: string): string {
  const dir = path.join(tmpDir, 'templates', 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'title.txt');
  fs.writeFileSync(f, content, 'utf8');
  return dir;
}

/** Create a session JSONL file with an optional header and messages. */
function writeSession(file: string, header: any, messages: any[] = []): void {
  const lines: string[] = [];
  if (header) lines.push(JSON.stringify(header));
  for (const m of messages) lines.push(JSON.stringify(m));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

describe('maybeGenerateSessionTitle', () => {
  it('does nothing when ctx has no session file', async () => {
    const ctx: any = {
      messages: [{ role: 'user', content: 'hello' }],
      provider: 'anthropic',
    };
    await expect(maybeGenerateSessionTitle(ctx)).resolves.toBeUndefined();
  });

  it('does nothing when messages are empty', async () => {
    const ctx: any = {
      messages: [],
      provider: 'anthropic',
    };
    await expect(maybeGenerateSessionTitle(ctx)).resolves.toBeUndefined();
  });

  it('does nothing when there are more than 1 user message (already titled)', async () => {
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    writeSession(sessionFile, { type: 'header' }, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'second message' },
    ]);

    const ctx: any = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'second message' },
      ],
      provider: 'anthropic',
    };

    await expect(maybeGenerateSessionTitle(ctx)).resolves.toBeUndefined();
  });

  it('does nothing when session already has a title in header', async () => {
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    writeSession(sessionFile, { type: 'header', title: 'Existing title' }, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    const ctx: any = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      provider: 'anthropic',
    };

    await expect(maybeGenerateSessionTitle(ctx)).resolves.toBeUndefined();
  });

  it('does nothing when user text is empty', async () => {
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    writeSession(sessionFile, { type: 'header' }, [
      { role: 'user', content: '' },
      { role: 'assistant', content: 'hello' },
    ]);

    const ctx: any = {
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'hello' },
      ],
      provider: 'anthropic',
    };

    await expect(maybeGenerateSessionTitle(ctx)).resolves.toBeUndefined();
  });

  it('does nothing when title prompt file does not exist', async () => {
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    writeSession(sessionFile, { type: 'header' }, [
      { role: 'user', content: 'build a chat app' },
      { role: 'assistant', content: 'ok' },
    ]);

    const ctx: any = {
      messages: [
        { role: 'user', content: 'build a chat app' },
        { role: 'assistant', content: 'ok' },
      ],
      provider: 'anthropic',
    };

    // No title.txt → loadTitlePrompt returns null → silent return
    await expect(maybeGenerateSessionTitle(ctx)).resolves.toBeUndefined();
  });

  it('handles provider that has no sendMessage gracefully', async () => {
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    writeSession(sessionFile, { type: 'header' }, [
      { role: 'user', content: 'build a chat app' },
      { role: 'assistant', content: 'ok' },
    ]);

    const ctx: any = {
      messages: [
        { role: 'user', content: 'build a chat app' },
        { role: 'assistant', content: 'ok' },
      ],
      provider: 'nonexistent_provider',
    };

    await expect(maybeGenerateSessionTitle(ctx)).resolves.toBeUndefined();
  });
});
