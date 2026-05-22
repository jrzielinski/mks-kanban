import { recoverStreamError } from './streaming-error-recovery';

function makeArgs(overrides: any = {}) {
  const bridge = { addMessage: jest.fn(), updateMessage: jest.fn() };
  return {
    errText: '',
    ctx: {},
    chatMessages: [],
    enrichedTools: [{ name: 'Read' }, { name: 'Edit' }, { name: 'Write' }],
    accumulatedText: 'some text',
    buildAssistantMessage: (text: string | null, toolCalls?: any[]) => ({ role: 'assistant', content: text, tool_calls: toolCalls }),
    bridge,
    msgId: 'msg-1',
    ...overrides,
  };
}

describe('recoverStreamError', () => {
  describe('Recovery 1 — Bad tool name', () => {
    it('returns recovered when tool name is not in valid list', async () => {
      const args = makeArgs({ errText: 'attempted to call tool "FooTool" which is not a valid tool' });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      expect(args.chatMessages).toHaveLength(2);
      expect(args.chatMessages[1].content).toContain('not valid');
      expect(args.chatMessages[1].content).toContain('FooTool');
    });

    it('falls through when tool name IS valid (bad args error)', async () => {
      const args = makeArgs({ errText: 'attempted to call tool "Read" with invalid arguments' });
      const result = await recoverStreamError(args);
      expect(result).not.toBe('recovered');
    });

    it('handles quoted tool names', async () => {
      const args = makeArgs({ errText: "attempted to call tool 'InvalidTool'" });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
    });
  });

  describe('Recovery 2 — Malformed JSON arguments', () => {
    it('returns recovered on "parse tool call arguments as JSON"', async () => {
      const args = makeArgs({ errText: 'Failed to parse tool call arguments as JSON' });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      expect(args.chatMessages[1].content).toContain('invalid JSON');
    });

    it('returns recovered on "tool_call arguments invalid"', async () => {
      const args = makeArgs({ errText: 'tool_call arguments are malformed' });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
    });

    it('returns recovered on "tool_call arguments are invalid"', async () => {
      const args = makeArgs({ errText: 'tool_call arguments are invalid' });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
    });

    it('returns recovered on "arguments parse failure"', async () => {
      const args = makeArgs({ errText: 'tool_call arguments parse failure' });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
    });
  });

  describe('Recovery 2b — Schema validation failure', () => {
    it('returns recovered with missing fields guidance', async () => {
      const args = makeArgs({
        errText: 'parameters for tool "Read" did not match schema: missing properties [file_path]',
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      expect(args.chatMessages[1].content).toContain('Read');
    });

    it('returns recovered on "validation failed" pattern', async () => {
      const args = makeArgs({
        errText: 'parameters for tool "Edit" validation failed: missing required fields',
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
    });

    it('matches missing properties with various bracket styles', async () => {
      const args = makeArgs({
        errText: 'parameters for tool "Write" did not match schema: missing property "content"',
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      expect(args.chatMessages[1].content).toContain('content');
    });
  });

  describe('Recovery 3a — Vision not supported', () => {
    it('strips image blocks and retries', async () => {
      const chatMessages = [
        { role: 'user', content: [{ type: 'text', text: 'desc' }, { type: 'image', source: { data: 'abc' } }] },
      ];
      const args = makeArgs({
        errText: 'unknown variant: image, expected a string',
        ctx: {},
        chatMessages,
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      expect(args.ctx.__visionStrippedThisTurn).toBe(true);
      // After stripping, content collapses to a plain text string
      expect(typeof args.chatMessages[0].content).toBe('string');
      expect(args.chatMessages[0].content).toBe('desc');
    });

    it('only fires once per turn (__visionStrippedThisTurn flag)', async () => {
      const args = makeArgs({
        errText: 'image_url is not supported',
        ctx: { __visionStrippedThisTurn: true },
        chatMessages: [{ role: 'user', content: 'hi' }],
      });
      const result = await recoverStreamError(args);
      expect(result).not.toBe('recovered');
    });

    it('matches image_url in error text', async () => {
      const chatMessages = [
        { role: 'user', content: [{ type: 'text', text: 'desc' }, { type: 'image_url', image_url: { url: 'http://x' } }] },
      ];
      const args = makeArgs({
        errText: 'does not support content type image_url',
        ctx: {},
        chatMessages,
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
    });

    it('handles array content with only text after stripping', async () => {
      const chatMessages = [
        { role: 'user', content: [{ type: 'image', source: { data: 'abc' } }, { type: 'text', text: 'hello' }] },
      ];
      const args = makeArgs({
        errText: 'image not supported',
        ctx: {},
        chatMessages,
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      // After stripping image, remaining text collapses to a string
      expect(typeof args.chatMessages[0].content).toBe('string');
      expect(args.chatMessages[0].content).toBe('hello');
    });
  });

  describe('Recovery 3c — Reasoning-mode round-trip', () => {
    it('injects reasoning_content into assistant messages', async () => {
      const chatMessages = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'answer' },
      ];
      const args = makeArgs({
        errText: 'The reasoning_content in the thinking mode must be passed back',
        ctx: {},
        chatMessages,
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      expect(args.chatMessages[1].reasoning_content).toBe('');
    });

    it('does NOT inject when reasoning_content already present', async () => {
      const chatMessages = [
        { role: 'assistant', content: 'hi', reasoning_content: 'thinking…' },
      ];
      const args = makeArgs({
        errText: 'reasoning_content must be passed back',
        ctx: {},
        chatMessages,
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      expect(args.chatMessages[0].reasoning_content).toBe('thinking…');
    });

    it('returns fatal on second attempt', async () => {
      const chatMessages = [{ role: 'assistant', content: 'hi' }];
      const args = makeArgs({
        errText: 'reasoning_content must be passed back',
        ctx: { __reasoningRecoveryTries: 1, messages: [] },
        chatMessages,
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('fatal');
    });

    it('also heals ctx.messages for persistence', async () => {
      const chatMessages = [{ role: 'assistant', content: 'hi' }];
      const ctx: any = { messages: [{ role: 'assistant', content: 'old' }] };
      const args = makeArgs({
        errText: 'thinking content must be passed back',
        ctx,
        chatMessages,
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
      expect(ctx.messages[0].reasoning_content).toBe('');
    });

    it('matches "thinking mode" variant', async () => {
      const chatMessages = [{ role: 'assistant', content: 'hi' }];
      const args = makeArgs({
        errText: 'reasoning in thinking mode requires round-trip',
        ctx: {},
        chatMessages,
      });
      const result = await recoverStreamError(args);
      expect(result).toBe('recovered');
    });
  });

  describe('Recovery 3b — Context-length exhaustion', () => {
    it('returns fatal on context length error', async () => {
      const args = makeArgs({ errText: 'context length exceeded' });
      const result = await recoverStreamError(args);
      expect(result).toBe('fatal');
    });

    it('returns fatal on too many tokens', async () => {
      const args = makeArgs({ errText: 'too many tokens in the conversation' });
      const result = await recoverStreamError(args);
      expect(result).toBe('fatal');
    });

    it('returns fatal on token limit', async () => {
      const args = makeArgs({ errText: 'token limit reached' });
      const result = await recoverStreamError(args);
      expect(result).toBe('fatal');
    });
  });

  describe('Unhandled errors', () => {
    it('returns unhandled for unknown error text', async () => {
      const args = makeArgs({ errText: 'some random error' });
      const result = await recoverStreamError(args);
      expect(result).toBe('unhandled');
    });

    it('returns unhandled for empty error', async () => {
      const args = makeArgs({ errText: '' });
      const result = await recoverStreamError(args);
      expect(result).toBe('unhandled');
    });
  });
});
