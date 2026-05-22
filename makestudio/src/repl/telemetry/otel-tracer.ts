import { swallow } from '../../utils/log';
/**
 * otel-tracer.ts — minimal, dependency-free OpenTelemetry-compatible
 * tracing for tool dispatch.
 *
 * The OpenTelemetry NodeJS SDK pulls a heavy dependency tree (gRPC,
 * Babel runtime, dozens of packages). We don't need most of it: the
 * agent runs as a single process with a known sink (a file under
 * ~/.makestudio/traces). Instead we emit OTLP HTTP/JSON-shaped span
 * objects, one per JSON line, that any OTel collector can ingest via
 * filelog receiver.
 *
 * Schema follows the OTLP/JSON standard (resource, scope, span fields)
 * so a downstream collector configured with the otlpjson parser ingests
 * the file directly without translation.
 *
 * Activation:
 *   - settings.otelEnabled: true
 *   - or env MAKESTUDIO_OTEL=1
 *   - or env MAKESTUDIO_OTEL=stdout (write to stderr instead of file)
 *
 * When inactive, withSpan() degrades to a passthrough (zero overhead
 * beyond a function call).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ── Activation check (cached) ────────────────────────────────────────

type Mode = 'off' | 'file' | 'stdout';

let cachedMode: Mode | null = null;

function getMode(): Mode {
  if (cachedMode !== null) return cachedMode;
  const env = (process.env.MAKESTUDIO_OTEL || '').toLowerCase().trim();
  if (env === 'stdout' || env === 'stderr') { cachedMode = 'stdout'; return cachedMode; }
  if (env === '1' || env === 'true' || env === 'on') { cachedMode = 'file'; return cachedMode; }
  if (env === '0' || env === 'false' || env === 'off') { cachedMode = 'off'; return cachedMode; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('../settings');
    const s = loadSettings() as any;
    if (s?.otelEnabled === true) { cachedMode = 'file'; return cachedMode; }
  } catch (err) { swallow(err); }
  cachedMode = 'off';
  return cachedMode;
}

export function resetOtelCache(): void { cachedMode = null; }
export function isOtelEnabled(): boolean { return getMode() !== 'off'; }

// ── Span model ───────────────────────────────────────────────────────

export type SpanAttrs = Record<string, string | number | boolean | undefined | null>;

export interface OtelSpan {
  /** 16-byte hex (32 chars). All spans in a single trace share this. */
  traceId: string;
  /** 8-byte hex (16 chars). Unique per span. */
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** OTel SpanKind: 1=internal, 2=server, 3=client, 4=producer, 5=consumer. */
  kind: number;
  /** Nanosecond epoch (Date.now()*1e6 + jitter). */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  /** OTel status: 0=unset, 1=ok, 2=error. */
  statusCode: number;
  statusMessage?: string;
}

// ── ID generation ────────────────────────────────────────────────────

function randHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function nowNano(): string {
  // Node lacks ns precision in Date — use process.hrtime.bigint() and
  // anchor against Date.now(). Returns a *string* because OTLP/JSON
  // expects ns as a string (avoid 64-bit precision loss on large vals).
  const nowMs = Date.now();
  // hrtime is monotonic but not wall-clock; we just need a monotonic
  // sub-ms component appended to ms-precision wall time.
  const sub = Number(process.hrtime.bigint() % BigInt(1_000_000));
  return String(BigInt(nowMs) * 1_000_000n + BigInt(sub));
}

// ── Async-context tracking via AsyncLocalStorage ─────────────────────

import { AsyncLocalStorage } from 'async_hooks';

interface SpanContext { traceId: string; spanId: string }
const als = new AsyncLocalStorage<SpanContext>();

export function currentTraceId(): string | null {
  return als.getStore()?.traceId || null;
}

// ── Exporter (lazy; writes are append-only and best-effort) ──────────

let writeStream: fs.WriteStream | null = null;
let writeStreamPath: string | null = null;

function getStream(): fs.WriteStream | null {
  const mode = getMode();
  if (mode === 'off') return null;
  if (mode === 'stdout') return null; // emit() handles stdout
  if (writeStream) return writeStream;
  try {
    const dir = path.join(os.homedir(), '.makestudio', 'traces');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${process.pid}-${Date.now()}.otlp.jsonl`);
    writeStreamPath = file;
    writeStream = fs.createWriteStream(file, { flags: 'a' });
    writeStream.on('error', () => {
      // Stream broken → disable for this process to avoid storms.
      cachedMode = 'off';
      writeStream = null;
    });
    return writeStream;
  } catch {
    cachedMode = 'off';
    return null;
  }
}

function emit(span: OtelSpan): void {
  const mode = getMode();
  if (mode === 'off') return;
  // Wrap each span in a minimal OTLP/JSON payload — one resource with
  // service.name = "makestudio-agent", one scope, one span.
  const payload = {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'makestudio-agent' } },
          { key: 'host.name', value: { stringValue: os.hostname() } },
          { key: 'process.pid', value: { intValue: process.pid } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'makestudio.tool', version: '1' },
        spans: [{
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId || '',
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: Object.entries(span.attributes).map(([k, v]) => ({
            key: k,
            value: typeof v === 'string' ? { stringValue: v }
                 : typeof v === 'number' && Number.isInteger(v) ? { intValue: v }
                 : typeof v === 'number' ? { doubleValue: v }
                 : { boolValue: v },
          })),
          status: { code: span.statusCode, message: span.statusMessage || '' },
        }],
      }],
    }],
  };
  const line = JSON.stringify(payload) + '\n';
  if (mode === 'stdout') {
    try { process.stderr.write(line); } catch (err) { swallow(err); }
    return;
  }
  const s = getStream();
  if (s) {
    try { s.write(line); } catch (err) { swallow(err); }
  }
}

// ── Public API ───────────────────────────────────────────────────────

export interface SpanOptions {
  attrs?: SpanAttrs;
  /** Default 1 (internal). Use 3 (client) for outbound LLM calls. */
  kind?: number;
}

/**
 * Wrap an async function in an OTel span. When OTel is disabled this
 * is a transparent passthrough (just calls fn). When enabled, the span
 * is exported on completion (success OR error) with timing, attributes,
 * and parent linkage from AsyncLocalStorage.
 */
export async function withSpan<T>(name: string, opts: SpanOptions, fn: () => Promise<T> | T): Promise<T> {
  if (getMode() === 'off') return fn();

  const parent = als.getStore();
  const traceId = parent?.traceId || randHex(16);
  const spanId = randHex(8);
  const start = nowNano();
  const ctx: SpanContext = { traceId, spanId };

  const attrs: Record<string, string | number | boolean> = {};
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v == null) continue;
      attrs[k] = v as any;
    }
  }

  try {
    const result = await als.run(ctx, fn);
    emit({
      traceId, spanId,
      parentSpanId: parent?.spanId || null,
      name,
      kind: opts.kind ?? 1,
      startTimeUnixNano: start,
      endTimeUnixNano: nowNano(),
      attributes: attrs,
      statusCode: 1,
    });
    return result;
  } catch (err: any) {
    emit({
      traceId, spanId,
      parentSpanId: parent?.spanId || null,
      name,
      kind: opts.kind ?? 1,
      startTimeUnixNano: start,
      endTimeUnixNano: nowNano(),
      attributes: { ...attrs, 'exception.type': String(err?.name || 'Error'), 'exception.message': String(err?.message || err).slice(0, 200) },
      statusCode: 2,
      statusMessage: String(err?.message || err).slice(0, 200),
    });
    throw err;
  }
}

/**
 * Synchronous variant for callers that can't await — same semantics
 * but throws/returns synchronously.
 */
export function withSpanSync<T>(name: string, opts: SpanOptions, fn: () => T): T {
  if (getMode() === 'off') return fn();
  const parent = als.getStore();
  const traceId = parent?.traceId || randHex(16);
  const spanId = randHex(8);
  const start = nowNano();
  const ctx: SpanContext = { traceId, spanId };
  const attrs: Record<string, string | number | boolean> = {};
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v == null) continue;
      attrs[k] = v as any;
    }
  }
  try {
    const result = als.run(ctx, fn) as T;
    emit({
      traceId, spanId,
      parentSpanId: parent?.spanId || null,
      name, kind: opts.kind ?? 1,
      startTimeUnixNano: start, endTimeUnixNano: nowNano(),
      attributes: attrs, statusCode: 1,
    });
    return result;
  } catch (err: any) {
    emit({
      traceId, spanId,
      parentSpanId: parent?.spanId || null,
      name, kind: opts.kind ?? 1,
      startTimeUnixNano: start, endTimeUnixNano: nowNano(),
      attributes: { ...attrs, 'exception.message': String(err?.message || err).slice(0, 200) },
      statusCode: 2,
      statusMessage: String(err?.message || err).slice(0, 200),
    });
    throw err;
  }
}

/**
 * Where the current process is writing. Useful for /diagnose to show
 * "spans → /tmp/.../foo.otlp.jsonl" so the user knows where to point
 * their collector.
 */
export function currentTracePath(): string | null {
  if (getMode() !== 'file') return null;
  return writeStreamPath;
}
