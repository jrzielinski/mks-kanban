import { swallow } from '../utils/log';
/**
 * plugin-ab-testing — A/B tests different CLIs/models and tracks which performs best.
 * Stores results in ~/.makestudio/ab-results.json for analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface ABResult {
  timestamp: string;
  taskType: string;
  cli: string;
  modelTier: string;
  costUsd: number;
  durationMs: number;
  verifyPassed: boolean;
  retries: number;
}

interface ABData {
  results: ABResult[];
  summary: Record<string, {
    totalTasks: number;
    avgCostUsd: number;
    avgDurationMs: number;
    successRate: number;
    avgRetries: number;
  }>;
}

const MAX_RESULTS = 1000;
let abPath: string;
let taskStartTimes: Map<string, number> = new Map();

function loadAB(): ABData {
  try {
    if (fs.existsSync(abPath)) {
      return JSON.parse(fs.readFileSync(abPath, 'utf8'));
    }
  } catch (err) { swallow(err); }
  return { results: [], summary: {} };
}

function saveAB(data: ABData): void {
  if (data.results.length > MAX_RESULTS) {
    data.results = data.results.slice(-MAX_RESULTS);
  }

  // Recalculate summary
  data.summary = {};
  for (const r of data.results) {
    const key = `${r.cli}:${r.modelTier}:${r.taskType}`;
    if (!data.summary[key]) {
      data.summary[key] = { totalTasks: 0, avgCostUsd: 0, avgDurationMs: 0, successRate: 0, avgRetries: 0 };
    }
    const s = data.summary[key];
    s.totalTasks++;
    s.avgCostUsd = ((s.avgCostUsd * (s.totalTasks - 1)) + r.costUsd) / s.totalTasks;
    s.avgDurationMs = ((s.avgDurationMs * (s.totalTasks - 1)) + r.durationMs) / s.totalTasks;
    s.successRate = ((s.successRate * (s.totalTasks - 1)) + (r.verifyPassed ? 1 : 0)) / s.totalTasks;
    s.avgRetries = ((s.avgRetries * (s.totalTasks - 1)) + r.retries) / s.totalTasks;
  }

  try {
    fs.writeFileSync(abPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

const plugin: MakeStudioPlugin = {
  name: 'ab-testing',
  version: '1.0.0',
  description: 'A/B test CLIs and models — track cost, speed, and success rate',

  async onLoad(ctx: PluginContext) {
    abPath = path.join(ctx.homeDir, 'ab-results.json');
    const data = loadAB();
    const keys = Object.keys(data.summary);
    if (keys.length > 0) {
      ctx.logger.info(`A/B testing: ${data.results.length} results across ${keys.length} configurations`);

      // Show best performer
      let bestKey = '';
      let bestScore = -1;
      for (const [key, s] of Object.entries(data.summary)) {
        if (s.totalTasks < 3) continue; // Need at least 3 samples
        const score = s.successRate * 100 - s.avgCostUsd * 10 - s.avgRetries * 5;
        if (score > bestScore) {
          bestScore = score;
          bestKey = key;
        }
      }
      if (bestKey) {
        ctx.logger.info(`  Best performer: ${bestKey} (score: ${bestScore.toFixed(1)})`);
      }
    }
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      taskStartTimes.set(task.taskId, Date.now());
      if (taskStartTimes.size > 100) {
        const oldest = taskStartTimes.keys().next().value;
        if (oldest) taskStartTimes.delete(oldest);
      }
      return task;
    },

    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const startTime = taskStartTimes.get(task.taskId);
      const durationMs = startTime ? Date.now() - startTime : 0;
      taskStartTimes.delete(task.taskId);

      const data = loadAB();
      data.results.push({
        timestamp: new Date().toISOString(),
        taskType: task.taskType || 'unknown',
        cli: task.cli,
        modelTier: task.modelTier || 'standard',
        costUsd: result.costUsd,
        durationMs,
        verifyPassed: true, // afterTaskExec = success
        retries: 0,
      });
      saveAB(data);
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      const startTime = taskStartTimes.get(task.taskId);
      const durationMs = startTime ? Date.now() - startTime : 0;
      taskStartTimes.delete(task.taskId);

      const data = loadAB();
      data.results.push({
        timestamp: new Date().toISOString(),
        taskType: task.taskType || 'unknown',
        cli: task.cli,
        modelTier: task.modelTier || 'standard',
        costUsd: 0,
        durationMs,
        verifyPassed: false,
        retries: 0,
      });
      saveAB(data);

      return 'fail';
    },
  },
};

export default plugin;
