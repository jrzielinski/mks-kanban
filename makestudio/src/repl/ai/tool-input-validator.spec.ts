import { validateToolInput } from './tool-input-validator';

describe('validateToolInput', () => {
  it('passes through unknown tool names without throwing', () => {
    expect(() => validateToolInput('UnknownPluginTool', { foo: 1 })).not.toThrow();
  });

  describe('Write', () => {
    it('throws on null input with hint listing required fields', () => {
      expect(() => validateToolInput('Write', null)).toThrow(/Write called with no arguments \(null\)/);
      expect(() => validateToolInput('Write', null)).toThrow(/file_path/);
      expect(() => validateToolInput('Write', null)).toThrow(/content/);
    });

    it('throws on empty object — names every missing field', () => {
      let msg = '';
      try { validateToolInput('Write', {}); } catch (e: any) { msg = e.message; }
      expect(msg).toMatch(/missing/);
      expect(msg).toMatch(/file_path/);
      expect(msg).toMatch(/content/);
      // Includes the model's actual input as preview so it can spot drift
      expect(msg).toMatch(/You sent: \{\}/);
    });

    it('throws when content is wrong type (number instead of string)', () => {
      let msg = '';
      try { validateToolInput('Write', { file_path: '/x/y.json', content: 42 }); } catch (e: any) { msg = e.message; }
      expect(msg).toMatch(/wrong type/);
      expect(msg).toMatch(/content/);
      expect(msg).toMatch(/got number/);
    });

    it('accepts well-formed input with empty string content', () => {
      expect(() => validateToolInput('Write', { file_path: '/abs/path.txt', content: '' })).not.toThrow();
    });
  });

  describe('Edit', () => {
    it('flags missing old_string AND new_string', () => {
      let msg = '';
      try { validateToolInput('Edit', { file_path: '/x.ts' }); } catch (e: any) { msg = e.message; }
      expect(msg).toMatch(/old_string/);
      expect(msg).toMatch(/new_string/);
    });

    it('accepts valid input', () => {
      expect(() => validateToolInput('Edit', { file_path: '/x.ts', old_string: 'a', new_string: 'b' })).not.toThrow();
    });
  });

  describe('MultiEdit', () => {
    it('flags edits not being array', () => {
      let msg = '';
      try { validateToolInput('MultiEdit', { file_path: '/x.ts', edits: 'not-an-array' }); } catch (e: any) { msg = e.message; }
      expect(msg).toMatch(/edits/);
      expect(msg).toMatch(/expected array/);
    });
  });

  describe('Bash', () => {
    it('flags missing command', () => {
      expect(() => validateToolInput('Bash', {})).toThrow(/command/);
    });
    it('accepts plain command', () => {
      expect(() => validateToolInput('Bash', { command: 'ls' })).not.toThrow();
    });
  });

  describe('read_attachment', () => {
    it('accepts numeric id', () => {
      expect(() => validateToolInput('read_attachment', { id: 42 })).not.toThrow();
    });
    it('accepts string id', () => {
      expect(() => validateToolInput('read_attachment', { id: '42' })).not.toThrow();
    });
    it('rejects boolean id', () => {
      expect(() => validateToolInput('read_attachment', { id: true })).toThrow(/wrong type/);
    });
  });

  describe('read_file', () => {
    it('flags missing both fields with a clear hint', () => {
      let msg = '';
      try { validateToolInput('read_file', {}); } catch (e: any) { msg = e.message; }
      expect(msg).toMatch(/projectPath/);
      expect(msg).toMatch(/filePath/);
      expect(msg).toMatch(/missing/);
    });
    it('flags a single absolute path passed as filePath without projectPath', () => {
      let msg = '';
      try { validateToolInput('read_file', { filePath: '/home/foo/bar.txt' }); } catch (e: any) { msg = e.message; }
      expect(msg).toMatch(/projectPath/);
      expect(msg).toMatch(/missing/);
    });
    it('accepts well-formed call', () => {
      expect(() => validateToolInput('read_file', { projectPath: '/p', filePath: 'src/x.ts' })).not.toThrow();
    });
  });

  describe('dispatch_agent', () => {
    it('flags missing task', () => {
      let msg = '';
      try { validateToolInput('dispatch_agent', { subagent_type: 'explore' }); } catch (e: any) { msg = e.message; }
      expect(msg).toMatch(/task/);
      expect(msg).toMatch(/missing/);
    });

    it('accepts minimal valid input', () => {
      expect(() => validateToolInput('dispatch_agent', { task: 'find all auth handlers' })).not.toThrow();
    });

    it('flags task being non-string', () => {
      expect(() => validateToolInput('dispatch_agent', { task: 42 })).toThrow(/wrong type/);
    });
  });

  describe('dispatch_agents_parallel', () => {
    it('flags agents not being array', () => {
      expect(() => validateToolInput('dispatch_agents_parallel', { agents: 'oops' })).toThrow(/array/);
    });
    it('accepts array', () => {
      expect(() => validateToolInput('dispatch_agents_parallel', { agents: [{ task: 'x' }] })).not.toThrow();
    });
  });

  describe('error message shape', () => {
    it('includes a re-emit hint with the tool name', () => {
      let msg = '';
      try { validateToolInput('Write', {}); } catch (e: any) { msg = e.message; }
      expect(msg).toMatch(/Re-emit Write/);
    });

    it('truncates large inputs in the preview', () => {
      const huge: Record<string, string> = {};
      for (let i = 0; i < 50; i++) huge['k' + i] = 'v'.repeat(20);
      let msg = '';
      try { validateToolInput('Write', huge); } catch (e: any) { msg = e.message; }
      // The serialized input is huge (~1900 chars when full). The validator
      // caps the preview at 200 chars via .slice(0, 200) — confirm the
      // emitted preview substring is bounded so we don't dump the whole blob
      // into the LLM's context.
      const previewMatch = msg.match(/You sent: ([\s\S]+?)\. Re-emit/);
      expect(previewMatch).toBeTruthy();
      if (previewMatch) expect(previewMatch[1].length).toBeLessThanOrEqual(210);
    });
  });
});
