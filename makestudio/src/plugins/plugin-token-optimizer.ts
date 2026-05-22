import { swallow } from '../utils/log';
/**
 * plugin-token-optimizer — Estimates token count and optimizes prompt when too large.
 * Truncates less relevant sections to keep within budget.
 *
 * Config: plugins.tokenOptimizer.maxTokens (default: 100000)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch } from '../types';

function getMaxTokens(): number {
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.plugins?.tokenOptimizer?.maxTokens || 100_000;
    }
  } catch (err) { swallow(err); }
  return 100_000;
}

/**
 * Rough token estimation: ~4 chars per token for English text, ~3 for code.
 */
function estimateTokens(text: string): number {
  const codeRatio = (text.match(/[{}();=<>]/g) || []).length / text.length;
  const charsPerToken = codeRatio > 0.05 ? 3 : 4;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Truncate prompt sections to fit within token budget.
 * Priority (keep): task description > code context > requirements > market research
 */
function optimizePrompt(prompt: string, maxTokens: number): { prompt: string; removed: string[] } {
  const tokens = estimateTokens(prompt);
  if (tokens <= maxTokens) return { prompt, removed: [] };

  const removed: string[] = [];
  let optimized = prompt;

  // Low-priority sections to trim first
  const lowPrioritySections = [
    /## Visual References[\s\S]*?(?=##|$)/gi,
    /## Market Research[\s\S]*?(?=##|$)/gi,
    /## Design System[\s\S]*?(?=##|$)/gi,
    /## Clarifications[\s\S]*?(?=##|$)/gi,
    /## Codebase Analysis[\s\S]*?(?=##|$)/gi,
  ];

  for (const pattern of lowPrioritySections) {
    if (estimateTokens(optimized) <= maxTokens) break;

    const match = optimized.match(pattern);
    if (match) {
      removed.push(match[0].substring(0, 50) + '...');
      optimized = optimized.replace(pattern, '\n[Section trimmed to save tokens]\n');
    }
  }

  // If still too large, truncate hookContext
  if (estimateTokens(optimized) > maxTokens) {
    const hookStart = optimized.lastIndexOf('\n\n## ');
    if (hookStart > optimized.length / 2) {
      removed.push('hookContext (tail)');
      optimized = optimized.substring(0, hookStart) + '\n[Context truncated — prompt exceeded token limit]';
    }
  }

  return { prompt: optimized, removed };
}

const plugin: MakeStudioPlugin = {
  name: 'token-optimizer',
  version: '1.0.0',
  description: 'Estimate token count and optimize prompts that exceed budget',

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      const maxTokens = getMaxTokens();
      const originalTokens = estimateTokens(task.prompt);

      if (originalTokens > maxTokens) {
        const { prompt, removed } = optimizePrompt(task.prompt, maxTokens);
        const newTokens = estimateTokens(prompt);

        const { logWarning } = await import('../ui/terminal');
        logWarning(`[token-optimizer] Prompt reduced: ~${originalTokens} → ~${newTokens} tokens (removed: ${removed.join(', ')})`);

        task.prompt = prompt;
      }

      return task;
    },
  },
};

export default plugin;
