import { emitJson, emitSuccess, pickFields, isJsonMode } from './output-format';

describe('output-format', () => {
  let stdoutWriteMock: jest.SpyInstance;
  let originalExit: typeof process.exit;

  beforeAll(() => {
    originalExit = process.exit;
    process.exit = jest.fn(() => { throw new Error('process.exit'); }) as any;
  });

  afterAll(() => {
    process.exit = originalExit;
  });

  beforeEach(() => {
    stdoutWriteMock = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteMock.mockRestore();
  });

  describe('emitJson', () => {
    it('writes JSON to stdout', () => {
      emitJson({ key: 'value', num: 42 });
      const output = stdoutWriteMock.mock.calls[0][0];
      expect(JSON.parse(output)).toEqual({ key: 'value', num: 42 });
    });

    it('handles arrays', () => {
      emitJson([1, 2, 3]);
      const output = stdoutWriteMock.mock.calls[0][0];
      expect(JSON.parse(output)).toEqual([1, 2, 3]);
    });

    it('handles empty payload', () => {
      emitJson(null);
      const output = stdoutWriteMock.mock.calls[0][0];
      expect(JSON.parse(output)).toBeNull();
    });

    it('pretty-prints with indent when requested', () => {
      emitJson({ a: 1 }, { pretty: true });
      const output = stdoutWriteMock.mock.calls[0][0];
      expect(output).toContain('\n  ');
      expect(output).toContain('"a"');
    });
  });

  describe('emitSuccess', () => {
    it('wraps data in envelope', () => {
      emitSuccess(['task1', 'task2']);
      const output = JSON.parse(stdoutWriteMock.mock.calls[0][0]);
      expect(output).toEqual({ success: true, data: ['task1', 'task2'] });
    });

    it('includes meta when provided', () => {
      emitSuccess({ id: 'x' }, { count: 1 });
      const output = JSON.parse(stdoutWriteMock.mock.calls[0][0]);
      expect(output.success).toBe(true);
      expect(output.meta).toEqual({ count: 1 });
    });

    it('omits meta when not provided', () => {
      emitSuccess([]);
      const output = JSON.parse(stdoutWriteMock.mock.calls[0][0]);
      expect(output.meta).toBeUndefined();
    });
  });

  describe('pickFields', () => {
    it('extracts specified fields', () => {
      const obj = { id: 'abc', name: 'Test', hidden: 'secret', meta: { size: 10 } };
      const result = pickFields(obj, ['id', 'name', 'meta.size']);
      expect(result).toEqual({ id: 'abc', name: 'Test', 'meta.size': 10 });
    });

    it('omits undefined fields silently', () => {
      const obj = { a: 1 };
      const result = pickFields(obj, ['a', 'b', 'c.d']);
      expect(result).toEqual({ a: 1 });
    });

    it('returns empty for missing fields', () => {
      const result = pickFields({}, ['x', 'y']);
      expect(result).toEqual({});
    });
  });

  describe('isJsonMode', () => {
    it('returns true when json is true', () => {
      expect(isJsonMode({ json: true })).toBe(true);
    });

    it('returns false when json is false', () => {
      expect(isJsonMode({ json: false })).toBe(false);
    });

    it('returns false when json is undefined', () => {
      expect(isJsonMode({})).toBe(false);
      expect(isJsonMode({} as any)).toBe(false);
    });

    it('returns false when json is null', () => {
      expect(isJsonMode({ json: null as any })).toBe(false);
    });
  });
});
