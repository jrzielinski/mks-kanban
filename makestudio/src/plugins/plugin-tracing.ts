import { swallow } from '../utils/log';
/**
 * plugin-tracing — Exports execution traces as OTLP-compatible JSON.
 * Each task becomes a span with tool calls as child spans.
 * Stores in ~/.makestudio/traces/ for import into Grafana/Jaeger/Datadog.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

const TRACES_DIR = path.join(os.homedir(), '.makestudio', 'traces');
const MAX_TRACES = 200;

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  tags: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
}

let activeSpans: Map<string, Span> = new Map();

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function cleanOldTraces(): void {
  try {
    if (!fs.existsSync(TRACES_DIR)) return;
    const files = fs.readdirSync(TRACES_DIR)
      .map(f => ({ name: f, path: path.join(TRACES_DIR, f), mtime: fs.statSync(path.join(TRACES_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const f of files.slice(MAX_TRACES)) {
      fs.unlinkSync(f.path);
    }
  } catch (err) { swallow(err); }
}

const plugin: MakeStudioPlugin = {
  name: 'tracing',
  version: '1.0.0',
  description: 'Export execution traces as OTLP-compatible JSON for observability',

  async onLoad(ctx: PluginContext) {
    fs.mkdirSync(TRACES_DIR, { recursive: true });
    cleanOldTraces();
    ctx.logger.info(`Tracing enabled — traces at ${TRACES_DIR}`);
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      const span: Span = {
        traceId: generateId() + generateId(),
        spanId: generateId(),
        operationName: `task:${task.taskType || 'unknown'}`,
        startTime: Date.now(),
        tags: {
          'task.id': task.taskId,
          'task.title': task.taskTitle || '',
          'task.type': task.taskType || '',
          'task.cli': task.cli,
          'task.tier': task.modelTier || 'standard',
          'task.branch': task.taskBranch || '',
        },
        status: 'ok',
      };

      activeSpans.set(task.taskId, span);

      // Limit map size
      if (activeSpans.size > 50) {
        const oldest = activeSpans.keys().next().value;
        if (oldest) activeSpans.delete(oldest);
      }

      return task;
    },

    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const span = activeSpans.get(task.taskId);
      if (!span) return;
      activeSpans.delete(task.taskId);

      span.endTime = Date.now();
      span.status = 'ok';
      span.tags['result.costUsd'] = result.costUsd;
      span.tags['result.branch'] = result.gitInfo?.branch || '';
      span.tags['result.pushed'] = result.gitInfo?.pushed || false;
      span.tags['result.commits'] = result.gitInfo?.commits || 0;
      span.tags['duration_ms'] = span.endTime - span.startTime;

      // Save as OTLP-compatible JSON
      const tracePath = path.join(TRACES_DIR, `${task.taskId}_${Date.now()}.json`);
      try {
        fs.writeFileSync(tracePath, JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'makestudio-agent' } }] },
            scopeSpans: [{
              scope: { name: 'makestudio-agent' },
              spans: [span],
            }],
          }],
        }, null, 2), 'utf8');
      } catch (err) { swallow(err); }
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      const span = activeSpans.get(task.taskId);
      if (span) {
        activeSpans.delete(task.taskId);
        span.endTime = Date.now();
        span.status = 'error';
        span.tags['error.message'] = error.message.substring(0, 200);
        span.tags['duration_ms'] = span.endTime - span.startTime;

        const tracePath = path.join(TRACES_DIR, `${task.taskId}_error_${Date.now()}.json`);
        try {
          fs.writeFileSync(tracePath, JSON.stringify({
            resourceSpans: [{
              resource: { attributes: [{ key: 'service.name', value: { stringValue: 'makestudio-agent' } }] },
              scopeSpans: [{ scope: { name: 'makestudio-agent' }, spans: [span] }],
            }],
          }, null, 2), 'utf8');
        } catch (err) { swallow(err); }
      }
      return 'fail';
    },
  },
};

export default plugin;
