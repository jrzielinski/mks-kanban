import { swallow } from '../utils/log';
/**
 * plugin-learning — Learns from past task failures/successes to improve future prompts.
 * Stores patterns in ~/.makestudio/learning.json and injects relevant lessons into prompts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface LearningEntry {
  timestamp: string;
  taskType: string;
  cli: string;
  pattern: string;   // What happened
  lesson: string;     // What to do differently
  frequency: number;  // How often this pattern recurred
}

interface LearningData {
  entries: LearningEntry[];
}

const MAX_ENTRIES = 200;
let learningPath: string;

function loadLearning(): LearningData {
  try {
    if (fs.existsSync(learningPath)) {
      return JSON.parse(fs.readFileSync(learningPath, 'utf8'));
    }
  } catch (err) { swallow(err); }
  return { entries: [] };
}

function saveLearning(data: LearningData): void {
  if (data.entries.length > MAX_ENTRIES) {
    // Keep most frequent + most recent
    data.entries.sort((a, b) => b.frequency - a.frequency);
    data.entries = data.entries.slice(0, MAX_ENTRIES);
  }
  try {
    fs.writeFileSync(learningPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

function addLesson(taskType: string, cli: string, pattern: string, lesson: string): void {
  const data = loadLearning();

  // Check if similar pattern exists
  const existing = data.entries.find(e =>
    e.taskType === taskType && e.pattern === pattern,
  );

  if (existing) {
    existing.frequency++;
    existing.timestamp = new Date().toISOString();
  } else {
    data.entries.push({
      timestamp: new Date().toISOString(),
      taskType,
      cli,
      pattern,
      lesson,
      frequency: 1,
    });
  }

  saveLearning(data);
}

function getRelevantLessons(taskType: string, cli: string): LearningEntry[] {
  const data = loadLearning();
  return data.entries
    .filter(e => e.taskType === taskType || e.cli === cli)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 5); // Top 5 most relevant lessons
}

const plugin: MakeStudioPlugin = {
  name: 'learning',
  version: '1.0.0',
  description: 'Learn from past failures to improve future task prompts',

  async onLoad(ctx: PluginContext) {
    learningPath = path.join(ctx.homeDir, 'learning.json');
    const data = loadLearning();
    ctx.logger.info(`Learning: ${data.entries.length} pattern(s) stored`);
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      const lessons = getRelevantLessons(task.taskType || '', task.cli);
      if (lessons.length === 0) return task;

      // Inject lessons into prompt
      const lessonsText = lessons
        .map(l => `- ${l.lesson} (seen ${l.frequency}x)`)
        .join('\n');

      task.prompt += `\n\n## LEARNED PATTERNS — Avoid these known issues:\n${lessonsText}`;

      return task;
    },

    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      // Learn from successful patterns
      if (result.costUsd > 3) {
        addLesson(
          task.taskType || 'unknown',
          task.cli,
          'high-cost-task',
          `Tasks of type "${task.taskType}" with ${task.cli} tend to be expensive ($${result.costUsd.toFixed(2)}). Consider using a faster model tier.`,
        );
      }
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      const errorMsg = error.message.toLowerCase();

      // Learn from common failure patterns
      if (errorMsg.includes('timeout')) {
        addLesson(task.taskType || 'unknown', task.cli, 'timeout', 'Task timed out — consider breaking into smaller sub-tasks or increasing timeout.');
      } else if (errorMsg.includes('memory') || errorMsg.includes('oom')) {
        addLesson(task.taskType || 'unknown', task.cli, 'oom', 'Task ran out of memory — reduce prompt size or split into smaller chunks.');
      } else if (errorMsg.includes('rate limit')) {
        addLesson(task.taskType || 'unknown', task.cli, 'rate-limit', 'Hit rate limit — add delays between API calls or use a different CLI.');
      } else if (errorMsg.includes('compilation') || errorMsg.includes('typescript')) {
        addLesson(task.taskType || 'unknown', task.cli, 'compilation-error', 'Compilation errors are common — always verify TypeScript types after code generation.');
      } else if (errorMsg.includes('eslint') || errorMsg.includes('lint')) {
        addLesson(task.taskType || 'unknown', task.cli, 'lint-error', 'ESLint errors after generation — remind AI to follow project lint rules.');
      }

      return 'fail'; // Don't override
    },
  },
};

export default plugin;
