import { swallow } from '../utils/log';
/**
 * plugin-cost-alert — Alerts when task execution cost exceeds a configurable threshold.
 *
 * Configuration in ~/.makestudio/config.json:
 *   { "plugins": { "costAlert": { "maxCostUsd": 5.00, "warningCostUsd": 2.00 } } }
 *
 * Or env vars:
 *   MAKESTUDIO_MAX_COST_USD=5.00
 *   MAKESTUDIO_WARNING_COST_USD=2.00
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

interface CostAlertConfig {
  maxCostUsd: number;
  warningCostUsd: number;
}

let logFilePath: string;

function getConfig(): CostAlertConfig {
  const defaults: CostAlertConfig = { maxCostUsd: 5.0, warningCostUsd: 2.0 };

  // Env vars
  const maxEnv = process.env.MAKESTUDIO_MAX_COST_USD;
  const warnEnv = process.env.MAKESTUDIO_WARNING_COST_USD;
  if (maxEnv) defaults.maxCostUsd = parseFloat(maxEnv);
  if (warnEnv) defaults.warningCostUsd = parseFloat(warnEnv);

  // Config file
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const ca = config.plugins?.costAlert;
      if (ca?.maxCostUsd) defaults.maxCostUsd = ca.maxCostUsd;
      if (ca?.warningCostUsd) defaults.warningCostUsd = ca.warningCostUsd;
    }
  } catch (err) { swallow(err); }

  return defaults;
}

function appendToLog(entry: Record<string, any>): void {
  try {
    fs.appendFileSync(logFilePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) { swallow(err); }
}

const plugin: MakeStudioPlugin = {
  name: 'cost-alert',
  version: '1.0.0',
  description: 'Alert and log when task execution cost exceeds threshold',

  async onLoad(ctx: PluginContext) {
    const config = getConfig();
    logFilePath = path.join(ctx.homeDir, 'cost-alerts.log');
    ctx.logger.info(`Cost alert: warning at $${config.warningCostUsd}, max $${config.maxCostUsd}`);
  },

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      const config = getConfig();
      const cost = result.costUsd;

      const entry = {
        timestamp: new Date().toISOString(),
        taskId: task.taskId,
        taskTitle: task.taskTitle,
        taskType: task.taskType,
        costUsd: cost,
        cli: task.cli,
        tier: task.modelTier,
      };

      if (cost >= config.maxCostUsd) {
        appendToLog({ ...entry, level: 'CRITICAL', message: `Cost $${cost.toFixed(4)} exceeds max $${config.maxCostUsd}` });
      } else if (cost >= config.warningCostUsd) {
        appendToLog({ ...entry, level: 'WARNING', message: `Cost $${cost.toFixed(4)} exceeds warning $${config.warningCostUsd}` });
      }

      // Always log cost for tracking
      appendToLog({ ...entry, level: 'INFO' });
    },
  },
};

export default plugin;
