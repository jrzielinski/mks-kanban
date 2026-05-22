import { swallow } from '../utils/log';
/**
 * plugin-self-heal — Automatically rewrites prompts when tasks fail repeatedly.
 * After 2 consecutive failures of the same task type, rewrites the prompt
 * with additional constraints and context to increase success rate.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch } from '../types';

interface FailureRecord {
  taskType: string;
  errorPattern: string;
  count: number;
  lastSeen: string;
  fixes: string[]; // Applied fix strategies
}

interface SelfHealData {
  failures: FailureRecord[];
}

const MAX_RECORDS = 100;
let dataPath: string;

function loadData(): SelfHealData {
  try {
    if (fs.existsSync(dataPath)) return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (err) { swallow(err); }
  return { failures: [] };
}

function saveData(data: SelfHealData): void {
  if (data.failures.length > MAX_RECORDS) {
    data.failures = data.failures.sort((a, b) => b.count - a.count).slice(0, MAX_RECORDS);
  }
  try {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

function classifyError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('timeout')) return 'timeout';
  if (lower.includes('compilation') || lower.includes('typescript') || lower.includes('swc')) return 'compilation';
  if (lower.includes('eslint') || lower.includes('lint')) return 'linting';
  if (lower.includes('test') || lower.includes('jest')) return 'test-failure';
  if (lower.includes('memory') || lower.includes('oom')) return 'memory';
  if (lower.includes('permission') || lower.includes('access')) return 'permission';
  if (lower.includes('import') || lower.includes('module') || lower.includes('require')) return 'import-error';
  if (lower.includes('secret') || lower.includes('credential')) return 'security';
  return 'unknown';
}

function getHealingStrategy(errorPattern: string, count: number): string {
  const strategies: Record<string, string[]> = {
    compilation: [
      'CRITICAL: Ensure all TypeScript types are correct. Do NOT use `any` type. Import all dependencies before using them.',
      'Use explicit type annotations for function parameters and return types. Check that all imports resolve correctly.',
      'Before writing code, verify the existing type signatures in the project. Match them exactly.',
    ],
    linting: [
      'Follow the ESLint rules configured in this project. Do NOT add console.log(). Use const instead of let where possible.',
      'Check .eslintrc for project rules before writing code. Ensure consistent formatting.',
    ],
    'test-failure': [
      'Write unit tests for all new functions. Mock external dependencies. Ensure tests are deterministic.',
      'Before modifying existing code, run related tests to understand expected behavior.',
    ],
    timeout: [
      'Break this task into smaller, focused changes. Do NOT attempt to modify too many files at once.',
      'Focus on the minimum viable change. Avoid refactoring unrelated code.',
    ],
    memory: [
      'Keep the response concise. Do NOT output large code blocks unnecessarily.',
      'Process files one at a time instead of reading the entire codebase.',
    ],
    'import-error': [
      'Check that all import paths are correct relative to the file location. Use the existing import patterns in the project.',
      'Verify package.json has all required dependencies before importing them.',
    ],
    security: [
      'NEVER commit secrets, tokens, or credentials. Use environment variables for sensitive data.',
    ],
    unknown: [
      'Be extra careful with this task — it has failed before. Double-check your work before finalizing.',
    ],
  };

  const strats = strategies[errorPattern] || strategies.unknown;
  const idx = Math.min(count - 1, strats.length - 1);
  return strats[idx];
}

const plugin: MakeStudioPlugin = {
  name: 'self-heal',
  version: '1.0.0',
  description: 'Auto-rewrite prompts after repeated failures to increase success rate',

  async onLoad(ctx: PluginContext) {
    dataPath = path.join(ctx.homeDir, 'self-heal.json');
    const data = loadData();
    const totalFailures = data.failures.reduce((sum, f) => sum + f.count, 0);
    if (totalFailures > 0) {
      ctx.logger.info(`Self-heal: ${data.failures.length} failure pattern(s), ${totalFailures} total occurrences`);
    }
  },

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      const data = loadData();

      // Find recurring failures for this task type
      const relevantFailures = data.failures.filter(f =>
        f.taskType === (task.taskType || 'unknown') && f.count >= 2,
      );

      if (relevantFailures.length === 0) return task;

      // Inject healing strategies
      const healingNotes = relevantFailures.map(f => {
        const strategy = getHealingStrategy(f.errorPattern, f.count);
        return `- [${f.errorPattern}] (seen ${f.count}x): ${strategy}`;
      }).join('\n');

      task.prompt += `\n\n## SELF-HEALING NOTES — Previous failures detected for this task type:\n${healingNotes}\nApply these fixes proactively.`;

      return task;
    },

    async onError(task: TaskDispatch, error: Error): Promise<'retry' | 'skip' | 'fail'> {
      const data = loadData();
      const errorPattern = classifyError(error.message);
      const taskType = task.taskType || 'unknown';

      // Find or create failure record
      let record = data.failures.find(f => f.taskType === taskType && f.errorPattern === errorPattern);
      if (record) {
        record.count++;
        record.lastSeen = new Date().toISOString();
      } else {
        record = {
          taskType,
          errorPattern,
          count: 1,
          lastSeen: new Date().toISOString(),
          fixes: [],
        };
        data.failures.push(record);
      }

      saveData(data);
      return 'fail'; // Don't override retry behavior
    },
  },
};

export default plugin;
