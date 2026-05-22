import { swallow } from '../utils/log';
/**
 * plugin-metrics — Collects execution metrics (cost, time, retries) to a JSON file.
 * Stores data in ~/.makestudio/metrics.json for analysis and reporting.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface MetricEntry {
  timestamp: string;
  taskId: string;
  taskTitle?: string;
  taskType?: string;
  cli: string;
  modelTier?: string;
  costUsd: number;
  durationMs: number;
  branch?: string;
  pushed?: boolean;
  commits?: number;
}

interface MetricsData {
  version: number;
  lastUpdated: string;
  totalTasks: number;
  totalCostUsd: number;
  totalDurationMs: number;
  entries: MetricEntry[];
}

let metricsPath: string;
let taskStartTimes: Map<string, number> = new Map();
const MAX_ENTRIES = 5000; // Prevent unbounded growth

function loadMetrics(): MetricsData {
  try {
    if (fs.existsSync(metricsPath)) {
      return JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    }
  } catch (err) { swallow(err); }

  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    totalTasks: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    entries: [],
  };
}

function saveMetrics(data: MetricsData): void {
  try {
    // Trim entries if exceeding max
    if (data.entries.length > MAX_ENTRIES) {
      data.entries = data.entries.slice(-MAX_ENTRIES);
    }
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(metricsPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

const plugin: MakeStudioPlugin = {
  name: 'metrics',
  version: '1.0.0',
  description: 'Collect execution metrics (cost, time, retries) for analysis',

  async onLoad(ctx: PluginContext) {
    metricsPath = path.join(ctx.homeDir, 'metrics.json');
    const data = loadMetrics();
    ctx.logger.info(`Metrics: ${data.totalTasks} tasks tracked, $${data.totalCostUsd.toFixed(2)} total cost`);
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      taskStartTimes.set(task.taskId, Date.now());

      // Enforce memory limit on start times map
      if (taskStartTimes.size > 100) {
        const oldestKey = taskStartTimes.keys().next().value;
        if (oldestKey) taskStartTimes.delete(oldestKey);
      }

      return task; // Pass through unmodified
    },

    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const startTime = taskStartTimes.get(task.taskId);
      const durationMs = startTime ? Date.now() - startTime : 0;
      taskStartTimes.delete(task.taskId);

      const entry: MetricEntry = {
        timestamp: new Date().toISOString(),
        taskId: task.taskId,
        taskTitle: task.taskTitle,
        taskType: task.taskType,
        cli: task.cli,
        modelTier: task.modelTier,
        costUsd: result.costUsd,
        durationMs,
        branch: result.gitInfo?.branch,
        pushed: result.gitInfo?.pushed,
        commits: result.gitInfo?.commits,
      };

      const data = loadMetrics();
      data.entries.push(entry);
      data.totalTasks++;
      data.totalCostUsd += result.costUsd;
      data.totalDurationMs += durationMs;
      saveMetrics(data);
    },
  },
};

export default plugin;
