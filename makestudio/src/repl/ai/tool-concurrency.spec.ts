import { isToolConcurrencySafe, partitionToolUses, getMaxConcurrency } from './tool-concurrency';

describe('isToolConcurrencySafe', () => {
  it('marks Read/Glob/Grep/LSP/WebFetch as safe', () => {
    expect(isToolConcurrencySafe('Read', { file_path: '/a' })).toBe(true);
    expect(isToolConcurrencySafe('Glob', { pattern: '*.ts' })).toBe(true);
    expect(isToolConcurrencySafe('Grep', { pattern: 'foo' })).toBe(true);
    expect(isToolConcurrencySafe('lsp_definition', {})).toBe(true);
    expect(isToolConcurrencySafe('WebFetch', { url: 'http://x' })).toBe(true);
  });

  it('marks Edit/Write/MultiEdit as NOT safe', () => {
    expect(isToolConcurrencySafe('Edit', {})).toBe(false);
    expect(isToolConcurrencySafe('Write', {})).toBe(false);
    expect(isToolConcurrencySafe('MultiEdit', {})).toBe(false);
    expect(isToolConcurrencySafe('NotebookEdit', {})).toBe(false);
  });

  it('marks dispatch_agent and TodoWrite as NOT safe (own concurrency model)', () => {
    expect(isToolConcurrencySafe('dispatch_agent', {})).toBe(false);
    expect(isToolConcurrencySafe('TodoWrite', {})).toBe(false);
  });

  it('classifies Bash by command shape', () => {
    expect(isToolConcurrencySafe('Bash', { command: 'grep -r foo .' })).toBe(true);
    expect(isToolConcurrencySafe('Bash', { command: 'find . -name x' })).toBe(true);
    expect(isToolConcurrencySafe('Bash', { command: 'git log --oneline' })).toBe(true);
    expect(isToolConcurrencySafe('Bash', { command: 'ls -la /tmp' })).toBe(true);
    expect(isToolConcurrencySafe('Bash', { command: 'cat /etc/hosts' })).toBe(true);

    // Mutating/build commands NOT safe even though diagnostic-streak
    // would call them "progress" — running two builds in parallel is
    // a race on dist/.
    expect(isToolConcurrencySafe('Bash', { command: 'npm run build' })).toBe(false);
    expect(isToolConcurrencySafe('Bash', { command: 'git commit -m wip' })).toBe(false);
    expect(isToolConcurrencySafe('Bash', { command: 'mkdir foo' })).toBe(false);

    // Unknown / empty bash → conservative false
    expect(isToolConcurrencySafe('Bash', { command: '' })).toBe(false);
    expect(isToolConcurrencySafe('Bash', { command: 'echo "hi"' })).toBe(true); // echo is read-shaped
  });

  it('unknown tool → conservative false', () => {
    expect(isToolConcurrencySafe('SomeMcpTool', {})).toBe(false);
    expect(isToolConcurrencySafe('mcp.something', {})).toBe(false);
  });
});

describe('partitionToolUses', () => {
  it('groups consecutive safe tools into one batch', () => {
    const tools = [
      { id: 't1', name: 'Read', input: { file_path: '/a' } },
      { id: 't2', name: 'Read', input: { file_path: '/b' } },
      { id: 't3', name: 'Grep', input: { pattern: 'x' } },
    ];
    const batches = partitionToolUses(tools);
    expect(batches).toHaveLength(1);
    expect(batches[0].concurrencySafe).toBe(true);
    expect(batches[0].tools).toHaveLength(3);
  });

  it('isolates a non-safe tool into its own batch', () => {
    const tools = [
      { id: 't1', name: 'Read', input: { file_path: '/a' } },
      { id: 't2', name: 'Read', input: { file_path: '/b' } },
      { id: 't3', name: 'Edit', input: { file_path: '/c', old_string: 'a', new_string: 'b' } },
      { id: 't4', name: 'Read', input: { file_path: '/d' } },
    ];
    const batches = partitionToolUses(tools);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual({ concurrencySafe: true, tools: [tools[0], tools[1]] });
    expect(batches[1]).toEqual({ concurrencySafe: false, tools: [tools[2]] });
    expect(batches[2]).toEqual({ concurrencySafe: true, tools: [tools[3]] });
  });

  it('all-non-safe → one batch per tool', () => {
    const tools = [
      { id: 't1', name: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b' } },
      { id: 't2', name: 'Write', input: { file_path: '/b', content: 'x' } },
    ];
    const batches = partitionToolUses(tools);
    expect(batches).toHaveLength(2);
    expect(batches[0].tools).toEqual([tools[0]]);
    expect(batches[1].tools).toEqual([tools[1]]);
  });

  it('empty list → no batches', () => {
    expect(partitionToolUses([])).toEqual([]);
  });

  it('single safe tool → one batch of size 1 marked safe', () => {
    const tools = [{ id: 't1', name: 'Read', input: { file_path: '/a' } }];
    const batches = partitionToolUses(tools);
    expect(batches).toEqual([{ concurrencySafe: true, tools: [tools[0]] }]);
  });

  it('Bash classified per-command in partition', () => {
    const tools = [
      { id: 't1', name: 'Bash', input: { command: 'grep foo bar' } },
      { id: 't2', name: 'Bash', input: { command: 'find . -name x' } },
      { id: 't3', name: 'Bash', input: { command: 'npm run build' } },
      { id: 't4', name: 'Bash', input: { command: 'git log --oneline' } },
    ];
    const batches = partitionToolUses(tools);
    expect(batches).toHaveLength(3);
    expect(batches[0].concurrencySafe).toBe(true);
    expect(batches[0].tools).toHaveLength(2);
    expect(batches[1].concurrencySafe).toBe(false);
    expect(batches[1].tools).toHaveLength(1);
    expect(batches[2].concurrencySafe).toBe(true);
    expect(batches[2].tools).toHaveLength(1);
  });
});

describe('getMaxConcurrency', () => {
  beforeEach(() => { delete process.env.MAKESTUDIO_MAX_TOOL_CONCURRENCY; });

  it('defaults to 10', () => {
    expect(getMaxConcurrency()).toBe(10);
  });

  it('honours env var override', () => {
    process.env.MAKESTUDIO_MAX_TOOL_CONCURRENCY = '4';
    expect(getMaxConcurrency()).toBe(4);
  });

  it('ignores invalid env values (NaN, ≤0)', () => {
    process.env.MAKESTUDIO_MAX_TOOL_CONCURRENCY = 'banana';
    expect(getMaxConcurrency()).toBe(10);
    process.env.MAKESTUDIO_MAX_TOOL_CONCURRENCY = '0';
    expect(getMaxConcurrency()).toBe(10);
    process.env.MAKESTUDIO_MAX_TOOL_CONCURRENCY = '-3';
    expect(getMaxConcurrency()).toBe(10);
  });
});
