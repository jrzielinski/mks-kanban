import {
  coordinatorLifecycleToolDefs,
  coordinatorActiveDefs,
  isCoordinatorToolName,
  executeCoordinatorTool,
  coordinatorLog,
} from './coordinator-tools';

function mockCtx(overrides: any = {}): any {
  return {
    coordinatorActive: false,
    coordinatorSessionId: '',
    coordinatorMonitor: 'linear' as const,
    coordinatorWorkers: new Map(),
    cwd: '/tmp/test',
    ...overrides,
  };
}

describe('coordinatorLifecycleToolDefs', () => {
  it('defines coordinator_activate and coordinator_deactivate', () => {
    const names = coordinatorLifecycleToolDefs.map((t) => t.name);
    expect(names).toContain('coordinator_activate');
    expect(names).toContain('coordinator_deactivate');
  });

  it('coordinator_activate has reason required', () => {
    const def = coordinatorLifecycleToolDefs.find((t) => t.name === 'coordinator_activate')!;
    const props = (def.input_schema as any).properties;
    expect(props.reason).toBeDefined();
    expect(props.reason.type).toBe('string');
  });
});

describe('coordinatorActiveDefs', () => {
  it('defines spawn_worker, send_message, read_scratchpad, write_scratchpad, coordinator_status', () => {
    const names = coordinatorActiveDefs.map((t) => t.name);
    expect(names).toContain('spawn_worker');
    expect(names).toContain('send_message');
    expect(names).toContain('read_scratchpad');
    expect(names).toContain('write_scratchpad');
    expect(names).toContain('coordinator_status');
  });
});

describe('isCoordinatorToolName', () => {
  it('returns true for coordinator_activate', () => {
    expect(isCoordinatorToolName('coordinator_activate')).toBe(true);
  });

  it('returns true for coordinator_deactivate', () => {
    expect(isCoordinatorToolName('coordinator_deactivate')).toBe(true);
  });

  it('includes active defs only when ctx.coordinatorActive is true', () => {
    expect(isCoordinatorToolName('spawn_worker')).toBe(true);
    expect(isCoordinatorToolName('spawn_worker', { coordinatorActive: true } as any)).toBe(true);
  });

  it('returns false for unknown tool', () => {
    expect(isCoordinatorToolName('nonexistent_tool')).toBe(false);
  });
});

describe('coordinatorLog', () => {
  let stderrSpy: jest.SpyInstance;
  let origStderr: any;

  beforeEach(() => {
    origStderr = process.stderr;
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true as any);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('does nothing in silent mode', () => {
    const ctx = mockCtx({ coordinatorMonitor: 'silent' });
    coordinatorLog(ctx, 'worker1', 'test message');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes to stderr in linear mode', () => {
    const ctx = mockCtx({ coordinatorMonitor: 'linear' });
    coordinatorLog(ctx, 'test-worker', 'hello world');
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('test-worker');
    expect(written).toContain('hello world');
  });

  it('uses [coordinator] prefix for coordinator messages', () => {
    const ctx = mockCtx({ coordinatorMonitor: 'linear' });
    coordinatorLog(ctx, 'coordinator', 'mode activated');
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('[coordinator]');
  });
});

describe('executeCoordinatorTool', () => {
  describe('coordinator_activate', () => {
    it('activates coordinator mode', async () => {
      const ctx = mockCtx();
      const result = await executeCoordinatorTool('coordinator_activate', { reason: 'test', monitor: 'linear' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(ctx.coordinatorActive).toBe(true);
      expect(ctx.coordinatorSessionId).toBeTruthy();
    });

    it('defaults monitor to linear when invalid', async () => {
      const ctx = mockCtx();
      await executeCoordinatorTool('coordinator_activate', { reason: 'test', monitor: 'invalid_value' }, ctx);
      expect(ctx.coordinatorMonitor).toBe('linear');
    });

    it('rejects if already active', async () => {
      const ctx = mockCtx({ coordinatorActive: true });
      const result = await executeCoordinatorTool('coordinator_activate', { reason: 'test' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('coordinator_deactivate', () => {
    it('deactivates coordinator mode', async () => {
      const ctx = mockCtx({ coordinatorActive: true, coordinatorSessionId: 'sess1', coordinatorWorkers: new Map() });
      const result = await executeCoordinatorTool('coordinator_deactivate', {}, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(ctx.coordinatorActive).toBe(false);
    });

    it('fails if not active', async () => {
      const ctx = mockCtx();
      const result = await executeCoordinatorTool('coordinator_deactivate', {}, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('spawn_worker', () => {
    it('fails if coordinator not active', async () => {
      const ctx = mockCtx();
      const result = await executeCoordinatorTool('spawn_worker', { worker_id: 'w1', task: 'do stuff' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toBe('coordinator_activate must be called first.');
    });

    it('fails if worker_id or task missing', async () => {
      const ctx = mockCtx({ coordinatorActive: true, coordinatorSessionId: 's1', coordinatorWorkers: new Map() });
      const result = await executeCoordinatorTool('spawn_worker', {}, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it('fails if worker already exists', async () => {
      const workers = new Map<string, any>();
      workers.set('w1', { id: 'w1', status: 'running' });
      const ctx = mockCtx({ coordinatorActive: true, coordinatorSessionId: 's1', coordinatorWorkers: workers });
      const result = await executeCoordinatorTool('spawn_worker', { worker_id: 'w1', task: 'do stuff' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('already exists');
    });

    it('registers a running worker', async () => {
      const ctx = mockCtx({ coordinatorActive: true, coordinatorSessionId: 's1', coordinatorWorkers: new Map() });
      const result = await executeCoordinatorTool('spawn_worker', { worker_id: 'w2', task: 'explore X' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(ctx.coordinatorWorkers.has('w2')).toBe(true);
    });
  });

  describe('send_message', () => {
    it('fails if coordinator not active', async () => {
      const ctx = mockCtx();
      const result = await executeCoordinatorTool('send_message', { worker_id: 'w1', message: 'hi' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it('fails if worker not found', async () => {
      const ctx = mockCtx({ coordinatorActive: true, coordinatorWorkers: new Map() });
      const result = await executeCoordinatorTool('send_message', { worker_id: 'w1', message: 'hi' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('not found');
    });
  });

  describe('read_scratchpad', () => {
    it('fails if coordinator not active', async () => {
      const ctx = mockCtx();
      const result = await executeCoordinatorTool('read_scratchpad', { key: 'test.md' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it('returns empty content for nonexistent key', async () => {
      const ctx = mockCtx({ coordinatorActive: true, coordinatorSessionId: 'test-session', coordinatorWorkers: new Map() });
      const result = await executeCoordinatorTool('read_scratchpad', { key: 'nonexistent.md' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.content).toBe('');
    });
  });

  describe('write_scratchpad', () => {
    it('fails if coordinator not active', async () => {
      const ctx = mockCtx();
      const result = await executeCoordinatorTool('write_scratchpad', { key: 'test.md', content: 'hello' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it('writes content and returns bytes', async () => {
      const ctx = mockCtx({ coordinatorActive: true, coordinatorSessionId: 'test-session', coordinatorWorkers: new Map() });
      const result = await executeCoordinatorTool('write_scratchpad', { key: 'note.md', content: 'hello world' }, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.bytes).toBeGreaterThan(0);
    });
  });

  describe('coordinator_status', () => {
    it('fails if coordinator not active', async () => {
      const ctx = mockCtx();
      const result = await executeCoordinatorTool('coordinator_status', {}, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it('returns empty workers list when no workers', async () => {
      const ctx = mockCtx({ coordinatorActive: true, coordinatorSessionId: 's1', coordinatorWorkers: new Map() });
      const result = await executeCoordinatorTool('coordinator_status', {}, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.workers).toEqual([]);
      expect(parsed.sessionId).toBe('s1');
    });

    it('includes registered workers', async () => {
      const workers = new Map<string, any>();
      workers.set('w1', { id: 'w1', status: 'running', mode: 'auto', startedAt: Date.now() });
      const ctx = mockCtx({ coordinatorActive: true, coordinatorSessionId: 's1', coordinatorWorkers: workers });
      const result = await executeCoordinatorTool('coordinator_status', {}, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.workers.length).toBe(1);
      expect(parsed.workers[0].id).toBe('w1');
    });
  });

  describe('unknown tool', () => {
    it('returns error for unknown tool name', async () => {
      const ctx = mockCtx();
      const result = await executeCoordinatorTool('unknown_tool', {}, ctx);
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Unknown coordinator tool');
    });
  });
});
