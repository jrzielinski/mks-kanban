import { sanitizeMessagesForLLM } from './sanitize-messages';

describe('sanitizeMessagesForLLM', () => {
  describe('reasoning_content / thinking_signature', () => {
    it('adds empty reasoning_content when absent on assistant', () => {
      const out = sanitizeMessagesForLLM([{ role: 'assistant', content: 'hi' }]);
      expect(out).toHaveLength(1);
      expect(out[0].reasoning_content).toBe('');
    });

    it('preserves reasoning_content when present', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'assistant', content: 'answer', reasoning_content: 'because X' },
      ]);
      expect(out[0].reasoning_content).toBe('because X');
    });

    it('passes thinking_signature through verbatim', () => {
      const sig = 'sig-abc-123';
      const out = sanitizeMessagesForLLM([
        { role: 'assistant', content: 'answer', thinking_signature: sig },
      ]);
      expect(out[0].thinking_signature).toBe(sig);
    });

    it('does NOT add thinking_signature when absent', () => {
      const out = sanitizeMessagesForLLM([{ role: 'assistant', content: 'hi' }]);
      expect(out[0].thinking_signature).toBeUndefined();
    });

    it('non-string reasoning_content is coerced to empty string', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'assistant', content: 'hi', reasoning_content: { nested: 'object' } },
      ]);
      expect(out[0].reasoning_content).toBe('');
    });
  });

  describe('tool_calls orphan detection', () => {
    it('keeps tool_calls when followed by a tool result', () => {
      const out = sanitizeMessagesForLLM([
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', name: 'Bash', arguments: '{}' }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'output' },
      ]);
      expect(out[0].tool_calls).toEqual([{ id: 'c1', name: 'Bash', arguments: '{}' }]);
    });

    it('keeps tool_calls when assistant is the LAST message (about-to-execute)', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'user', content: 'do X' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', name: 'Bash', arguments: '{}' }],
        },
      ]);
      expect(out[1].tool_calls).toBeDefined();
    });

    it('drops tool_calls when next message is NOT a tool result (orphan)', () => {
      const out = sanitizeMessagesForLLM([
        {
          role: 'assistant',
          content: 'planning…',
          tool_calls: [{ id: 'c1', name: 'Bash', arguments: '{}' }],
        },
        { role: 'user', content: 'cancel that' },
      ]);
      expect(out[0].tool_calls).toBeUndefined();
      // The text content is preserved so the conversation is still coherent.
      expect(out[0].content).toBe('planning…');
    });

    it('drops tool_calls when next message is another assistant', () => {
      const out = sanitizeMessagesForLLM([
        {
          role: 'assistant',
          content: 'first turn',
          tool_calls: [{ id: 'c1', name: 'Bash', arguments: '{}' }],
        },
        { role: 'assistant', content: 'second turn (no tool result in between)' },
      ]);
      expect(out[0].tool_calls).toBeUndefined();
    });

    it('empty tool_calls array is treated as no tool_calls', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'assistant', content: 'hi', tool_calls: [] },
      ]);
      expect(out[0].tool_calls).toBeUndefined();
    });
  });

  describe('empty assistant detection', () => {
    it('drops assistant with null content + no tool_calls + no reasoning', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null },
      ]);
      // The user message stays; the empty assistant is dropped.
      expect(out).toHaveLength(1);
      expect(out[0].role).toBe('user');
    });

    it('drops assistant with empty-string content + nothing else', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '' },
      ]);
      expect(out).toHaveLength(1);
    });

    it('drops assistant with empty-array content + nothing else', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [] },
      ]);
      expect(out).toHaveLength(1);
    });

    it('KEEPS assistant with null content but reasoning_content set', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'assistant', content: null, reasoning_content: 'thinking…' },
      ]);
      expect(out).toHaveLength(1);
    });

    it('KEEPS assistant with null content + tool_calls (last message)', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'Read' }] },
      ]);
      expect(out).toHaveLength(1);
    });
  });

  describe('tool message handling', () => {
    it('keeps tool message with tool_call_id', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'tool', tool_call_id: 'abc', content: 'result' },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].tool_call_id).toBe('abc');
    });

    it('drops tool message missing tool_call_id', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'tool', content: 'orphan result' },
      ]);
      expect(out).toEqual([]);
    });
  });

  describe('content coercion', () => {
    it('coerces undefined content to null', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'assistant', tool_calls: [{ id: 'c1', name: 'X' }] },
      ]);
      expect(out[0].content).toBeNull();
    });

    it('preserves null content unchanged', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'X' }] },
      ]);
      expect(out[0].content).toBeNull();
    });

    it('preserves array content (multimodal blocks)', () => {
      const blocks = [
        { type: 'text', text: 'hi' },
        { type: 'image', source: { type: 'base64', data: 'abc' } },
      ];
      const out = sanitizeMessagesForLLM([{ role: 'user', content: blocks }]);
      expect(out[0].content).toBe(blocks);
    });
  });

  describe('defensive guards', () => {
    it('drops messages with no role', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'user', content: 'hi' },
        { content: 'orphan' } as any,
        { role: 'assistant', content: 'reply' },
      ]);
      expect(out).toHaveLength(2);
      expect(out[0].role).toBe('user');
      expect(out[1].role).toBe('assistant');
    });

    it('skips null/undefined entries silently', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'user', content: 'a' },
        null as any,
        undefined as any,
        { role: 'assistant', content: 'b' },
      ]);
      expect(out).toHaveLength(2);
    });

    it('does not mutate the input array', () => {
      const input: any[] = [
        { role: 'assistant', content: 'hi' },
      ];
      const snapshot = JSON.parse(JSON.stringify(input));
      sanitizeMessagesForLLM(input);
      expect(input).toEqual(snapshot);
    });

    it('preserves order across mixed messages', () => {
      const out = sanitizeMessagesForLLM([
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', name: 'X' }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'assistant', content: 'a2' },
      ]);
      expect(out.map((m: any) => m.role)).toEqual([
        'user', 'assistant', 'user', 'assistant', 'tool', 'assistant',
      ]);
    });

    it('returns a NEW array (not the same reference)', () => {
      const input: any[] = [{ role: 'user', content: 'hi' }];
      const out = sanitizeMessagesForLLM(input);
      expect(out).not.toBe(input);
    });
  });
});
