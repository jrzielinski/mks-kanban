import { swallow } from '../utils/log';
/**
 * plugin-kanban-burndown — Generates burndown data from Kanban board activity.
 * Tracks cards completed per day and projects completion date.
 * Writes burndown report to .makestudio/burndown.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface BurndownEntry {
  date: string;
  tasksCompleted: number;
  totalCostUsd: number;
}

interface BurndownData {
  entries: BurndownEntry[];
  lastUpdated: string;
}

let burndownPath: string;

function loadBurndown(): BurndownData {
  try {
    if (fs.existsSync(burndownPath)) {
      return JSON.parse(fs.readFileSync(burndownPath, 'utf8'));
    }
  } catch (err) { swallow(err); }
  return { entries: [], lastUpdated: new Date().toISOString() };
}

function saveBurndown(data: BurndownData): void {
  data.lastUpdated = new Date().toISOString();
  // Keep last 90 days
  if (data.entries.length > 90) data.entries = data.entries.slice(-90);
  try {
    fs.writeFileSync(burndownPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

const plugin: MakeStudioPlugin = {
  name: 'kanban-burndown',
  version: '1.0.0',
  description: 'Track daily task completion for burndown charts',

  async onLoad(ctx: PluginContext) {
    burndownPath = path.join(ctx.homeDir, 'burndown.json');
    const data = loadBurndown();
    ctx.logger.info(`Burndown: ${data.entries.length} day(s) tracked`);
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const data = loadBurndown();
      const today = new Date().toISOString().split('T')[0];

      let todayEntry = data.entries.find(e => e.date === today);
      if (!todayEntry) {
        todayEntry = { date: today, tasksCompleted: 0, totalCostUsd: 0 };
        data.entries.push(todayEntry);
      }

      todayEntry.tasksCompleted++;
      todayEntry.totalCostUsd += result.costUsd;

      saveBurndown(data);
    },
  },

  contextProviders: [
    {
      name: 'burndown',
      fileName: 'burndown-report.md',

      async generate(): Promise<string | null> {
        if (!burndownPath || !fs.existsSync(burndownPath)) return null;

        const data = loadBurndown();
        if (data.entries.length < 2) return null;

        const lines: string[] = [
          '# Burndown Report',
          '',
          `> Last ${data.entries.length} day(s) of activity`,
          '',
          '| Date | Tasks | Cost |',
          '|------|-------|------|',
        ];

        let totalTasks = 0;
        let totalCost = 0;

        for (const e of data.entries.slice(-14)) { // Last 2 weeks
          lines.push(`| ${e.date} | ${e.tasksCompleted} | $${e.totalCostUsd.toFixed(2)} |`);
          totalTasks += e.tasksCompleted;
          totalCost += e.totalCostUsd;
        }

        const avgPerDay = totalTasks / Math.min(data.entries.length, 14);
        lines.push('', `**Average:** ${avgPerDay.toFixed(1)} tasks/day | $${(totalCost / Math.min(data.entries.length, 14)).toFixed(2)}/day`);

        return lines.join('\n');
      },
    },
  ],
};

export default plugin;
