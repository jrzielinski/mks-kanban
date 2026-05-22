import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withSpan, withSpanSync, isOtelEnabled, resetOtelCache, currentTraceId } from './otel-tracer';

describe('otel-tracer', () => {
  beforeEach(() => {
    delete process.env.MAKESTUDIO_OTEL;
    resetOtelCache();
  });

  describe('off mode (default)', () => {
    it('isOtelEnabled returns false', () => {
      expect(isOtelEnabled()).toBe(false);
    });

    it('withSpan returns the function result unchanged', async () => {
      const result = await withSpan('test', {}, async () => 42);
      expect(result).toBe(42);
    });

    it('withSpan re-throws errors', async () => {
      await expect(
        withSpan('test', {}, async () => { throw new Error('boom'); }),
      ).rejects.toThrow('boom');
    });

    it('withSpanSync returns the function result unchanged', () => {
      expect(withSpanSync('test', {}, () => 'hello')).toBe('hello');
    });

    it('does not write any traces to disk', async () => {
      const tracesDir = path.join(os.homedir(), '.makestudio', 'traces');
      const before = fs.existsSync(tracesDir) ? fs.readdirSync(tracesDir).length : 0;
      await withSpan('test', {}, async () => 1);
      const after = fs.existsSync(tracesDir) ? fs.readdirSync(tracesDir).length : 0;
      expect(after).toBe(before);
    });

    it('currentTraceId returns null when off', () => {
      expect(currentTraceId()).toBeNull();
    });
  });

  describe('stdout mode', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
      process.env.MAKESTUDIO_OTEL = 'stdout';
      resetOtelCache();
      stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('isOtelEnabled returns true', () => {
      expect(isOtelEnabled()).toBe(true);
    });

    it('emits OTLP/JSON to stderr on success', async () => {
      const result = await withSpan('test.span', { attrs: { foo: 'bar' } }, async () => 'ok');
      expect(result).toBe('ok');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('test.span');
      expect(parsed.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(1);
    });

    it('emits with status=ERROR on throw', async () => {
      await expect(
        withSpan('test.fail', {}, async () => { throw new Error('kaboom'); }),
      ).rejects.toThrow('kaboom');
      const line = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
      expect(parsed.resourceSpans[0].scopeSpans[0].spans[0].status.message).toContain('kaboom');
    });

    it('attaches custom attributes', async () => {
      await withSpan('attr.test', { attrs: { 'tool.name': 'Read', count: 3 } }, async () => 1);
      const line = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      const attrs = parsed.resourceSpans[0].scopeSpans[0].spans[0].attributes;
      const map = Object.fromEntries(attrs.map((a: any) => [a.key, a.value]));
      expect(map['tool.name']).toEqual({ stringValue: 'Read' });
      expect(map['count']).toEqual({ intValue: 3 });
    });

    it('produces 32-char traceId and 16-char spanId', async () => {
      await withSpan('id.test', {}, async () => 1);
      const line = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      const span = parsed.resourceSpans[0].scopeSpans[0].spans[0];
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('parents propagate trace id to nested spans', async () => {
      let innerTraceId: string | null = null;
      await withSpan('outer', {}, async () => {
        await withSpan('inner', {}, async () => {
          innerTraceId = currentTraceId();
        });
      });
      expect(stderrSpy).toHaveBeenCalledTimes(2);
      const lines = stderrSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
      // Both spans should share the same traceId
      const innerSpan = lines.find((p) => p.resourceSpans[0].scopeSpans[0].spans[0].name === 'inner').resourceSpans[0].scopeSpans[0].spans[0];
      const outerSpan = lines.find((p) => p.resourceSpans[0].scopeSpans[0].spans[0].name === 'outer').resourceSpans[0].scopeSpans[0].spans[0];
      expect(innerSpan.traceId).toBe(outerSpan.traceId);
      expect(innerSpan.parentSpanId).toBe(outerSpan.spanId);
    });
  });
});
