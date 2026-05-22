import { getAllToolDefinitions, getCoordinatorToolDefs, toolDefinitions } from './tools';
import type { ReplContext } from '../context';

// ── mocks for executeTool / runUnderlyingTool ────────────────────
jest.mock('../trajectory', () => ({
  recordCtxEvent: jest.fn(() => 1),
}));

jest.mock('./tool-loop-detection', () => ({
  detectToolCallLoop: jest.fn(() => ({ stuck: false, level: 'ok', message: '', detector: '' })),
  recordToolCall: jest.fn(),
  recordToolCallOutcome: jest.fn(),
}));

jest.mock('../tui/bridge', () => ({
  setTransientStatus: jest.fn(),
  setCurrentTool: jest.fn(),
}));

jest.mock('./tool-input-validator', () => ({
  validateToolInput: jest.fn(),
}));

jest.mock('./tool-handlers', () => ({
  findToolHandler: jest.fn(() => null),
}));

jest.mock('./coordinator-tools', () => {
  const actual = jest.requireActual('./coordinator-tools');
  return {
    ...actual,
    executeCoordinatorTool: jest.fn(() => Promise.resolve('coordinator result')),
  };
});

jest.mock('./file-tools', () => {
  const actual = jest.requireActual('./file-tools');
  return {
    ...actual,
    executeFileTool: jest.fn(() => Promise.resolve('file tool result')),
  };
});

jest.mock('./advanced-tools', () => {
  const actual = jest.requireActual('./advanced-tools');
  return {
    ...actual,
    executeAdvancedTool: jest.fn(() => Promise.resolve('advanced tool result')),
    getPluginReplToolDefinitions: jest.fn(() => []),
  };
});

jest.mock('./post-edit-hooks', () => ({
  runPostEditCheck: jest.fn(() => ({ ok: true, message: '' })),
  trackEdit: jest.fn(),
}));

jest.mock('../lsp', () => ({
  getDiagnostics: jest.fn(() => []),
}));

import { executeTool } from './tools';

describe('tools module', () => {
  describe('toolDefinitions', () => {
    it('exports an array of ToolDefinition', () => {
      expect(Array.isArray(toolDefinitions)).toBe(true);
      expect(toolDefinitions.length).toBeGreaterThan(0);
    });

    it('each definition has name, description, input_schema', () => {
      for (const def of toolDefinitions) {
        expect(typeof def.name).toBe('string');
        expect(typeof def.description).toBe('string');
        expect(typeof def.input_schema).toBe('object');
      }
    });

    it('contains core tools: Read, Edit, Write, Bash', () => {
      const names = toolDefinitions.map((d) => d.name);
      expect(names).toContain('Read');
      expect(names).toContain('Edit');
      expect(names).toContain('Write');
      expect(names).toContain('Bash');
    });

    it('Batch has the correct input_schema shape', () => {
      const batch = toolDefinitions.find((d) => d.name === 'Batch');
      if (batch) {
        expect(batch.input_schema.type).toBe('object');
        expect(batch.input_schema.properties).toBeDefined();
      }
    });
  });

  describe('getAllToolDefinitions', () => {
    it('returns an array of ToolDefinition', () => {
      const defs = getAllToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
    });

    it('includes the same core tools as toolDefinitions', () => {
      const defs = getAllToolDefinitions();
      const names = defs.map((d) => d.name);
      expect(names).toContain('Read');
      expect(names).toContain('Edit');
      expect(names).toContain('Bash');
    });

    it('never contains undefined entries', () => {
      const defs = getAllToolDefinitions();
      for (const d of defs) {
        expect(d).toBeDefined();
        expect(d.name).toBeDefined();
      }
    });

    it('each definition is unique by name', () => {
      const defs = getAllToolDefinitions();
      const names = defs.map((d) => d.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('getCoordinatorToolDefs', () => {
    it('returns lifecycle tools when coordinator is not active', () => {
      const ctx: any = { coordinatorActive: false };
      const defs = getCoordinatorToolDefs(ctx);
      const names = defs.map((d) => d.name);
      expect(names).toContain('coordinator_activate');
      expect(names).toContain('coordinator_deactivate');
    });

    it('returns lifecycle + active tools when coordinator is active', () => {
      const ctx: any = { coordinatorActive: true };
      const defs = getCoordinatorToolDefs(ctx);
      const names = defs.map((d) => d.name);
      expect(names).toContain('coordinator_activate');
      expect(names).toContain('coordinator_deactivate');
    });

    it('all defs have valid schema', () => {
      const ctx: any = { coordinatorActive: true };
      const defs = getCoordinatorToolDefs(ctx);
      for (const d of defs) {
        expect(typeof d.name).toBe('string');
        expect(typeof d.description).toBe('string');
        expect(typeof d.input_schema).toBe('object');
      }
    });
  });

  describe('executeTool', () => {
    it('returns a string result for a valid file tool', async () => {
      const ctx: any = {
        coordinatorActive: false,
        autoApprove: false,
        approvedTools: new Set(),
        cwd: '/tmp',
        toolLoopDetectionConfig: {},
      };
      const result = await executeTool('Read', { file_path: '/tmp/test.ts', limit: 5 }, ctx);
      expect(typeof result).toBe('string');
    });

    it('returns error string when tool handler not found', async () => {
      const ctx: any = {
        coordinatorActive: false,
        cwd: '/tmp',
        toolLoopDetectionConfig: {},
      };
      const result = await executeTool('NonExistentTool123', {}, ctx);
      expect(result).toContain('No such tool available');
      expect(result).toContain('NonExistentTool123');
    });

    it('returns loop-detection critical message when stuck', async () => {
      const detectToolCallLoop = require('./tool-loop-detection').detectToolCallLoop;
      detectToolCallLoop.mockReturnValueOnce({
        stuck: true,
        level: 'critical',
        message: 'Too many identical calls',
        detector: 'hash_repeat',
      });

      const ctx: any = {
        coordinatorActive: false,
        cwd: '/tmp',
        toolLoopDetectionConfig: {},
      };
      const result = await executeTool('Read', { file_path: '/tmp/a.ts' }, ctx);
      expect(result).toContain('[tool-loop-detection]');
      expect(result).toContain('Too many identical calls');
    });

    it('prepends warning on warning-level detection', async () => {
      const detectToolCallLoop = require('./tool-loop-detection').detectToolCallLoop;
      detectToolCallLoop.mockReturnValueOnce({
        stuck: true,
        level: 'warning',
        message: 'Getting repetitive',
        detector: 'fuzzy_intent',
      });

      const ctx: any = {
        coordinatorActive: false,
        cwd: '/tmp',
        toolLoopDetectionConfig: {},
      };
      const result = await executeTool('Read', { file_path: '/tmp/a.ts' }, ctx);
      expect(result).toContain('[tool-loop-detection]');
      expect(result).toContain('Getting repetitive');
      // Warning still runs the tool — result should contain the real output too
      expect(result).toContain('file tool result');
    });
  });

  describe('module exports', () => {
    it('exports executeTool function', () => {
      const mod = require('./tools');
      expect(typeof mod.executeTool).toBe('function');
    });
  });
});
