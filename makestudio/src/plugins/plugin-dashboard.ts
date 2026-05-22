import { swallow } from '../utils/log';
/**
 * plugin-dashboard — Local web dashboard for viewing metrics, cost, and history.
 * Starts a minimal HTTP server on localhost.
 *
 * Usage: makestudio dashboard [--port 3737]
 * Config: plugins.dashboard.port (default: 3737)
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin } from '../core/plugin-types';

const MAKESTUDIO_HOME = path.join(os.homedir(), '.makestudio');

function readJsonFile(filePath: string): any {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) { swallow(err); }
  return null;
}

function buildDashboardHTML(metrics: any, abResults: any, learning: any, costAlerts: string[]): string {
  const totalTasks = metrics?.totalTasks || 0;
  const totalCost = metrics?.totalCostUsd?.toFixed(2) || '0.00';
  const avgCost = totalTasks > 0 ? (metrics.totalCostUsd / totalTasks).toFixed(4) : '0.00';
  const totalHours = metrics?.totalDurationMs ? (metrics.totalDurationMs / 3600000).toFixed(1) : '0';

  const recentTasks = (metrics?.entries || []).slice(-20).reverse();
  const taskRows = recentTasks.map((t: any) =>
    `<tr><td>${t.timestamp?.split('T')[0] || '-'}</td><td>${t.taskTitle || t.taskId || '-'}</td><td>${t.taskType || '-'}</td><td>${t.cli || '-'}</td><td>$${t.costUsd?.toFixed(4) || '0'}</td><td>${t.durationMs ? Math.round(t.durationMs / 1000) + 's' : '-'}</td></tr>`
  ).join('');

  const abSummary = abResults?.summary ? Object.entries(abResults.summary).map(([key, s]: [string, any]) =>
    `<tr><td>${key}</td><td>${s.totalTasks}</td><td>$${s.avgCostUsd?.toFixed(4)}</td><td>${Math.round(s.avgDurationMs / 1000)}s</td><td>${(s.successRate * 100).toFixed(0)}%</td></tr>`
  ).join('') : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MakeStudio Dashboard</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
h1{font-size:24px;margin-bottom:24px;color:#38bdf8}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
.card{background:#1e293b;border-radius:12px;padding:20px}.card h3{font-size:13px;color:#94a3b8;text-transform:uppercase;margin-bottom:8px}
.card .value{font-size:28px;font-weight:bold;color:#f8fafc}table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #334155;font-size:13px}th{color:#94a3b8;font-weight:600}
h2{font-size:18px;margin:24px 0 12px;color:#60a5fa}.section{background:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px}</style></head>
<body><h1>MakeStudio Dashboard</h1>
<div class="cards">
<div class="card"><h3>Total Tasks</h3><div class="value">${totalTasks}</div></div>
<div class="card"><h3>Total Cost</h3><div class="value">$${totalCost}</div></div>
<div class="card"><h3>Avg Cost/Task</h3><div class="value">$${avgCost}</div></div>
<div class="card"><h3>Total Time</h3><div class="value">${totalHours}h</div></div>
</div>
<div class="section"><h2>Recent Tasks</h2><table><tr><th>Date</th><th>Title</th><th>Type</th><th>CLI</th><th>Cost</th><th>Duration</th></tr>${taskRows || '<tr><td colspan="6">No tasks yet</td></tr>'}</table></div>
${abSummary ? `<div class="section"><h2>A/B Test Results</h2><table><tr><th>Config</th><th>Tasks</th><th>Avg Cost</th><th>Avg Time</th><th>Success</th></tr>${abSummary}</table></div>` : ''}
<div class="section"><h2>Learning Patterns</h2><p>${learning?.entries?.length || 0} learned pattern(s)</p></div>
<script>setTimeout(()=>location.reload(),30000)</script></body></html>`;
}

const plugin: MakeStudioPlugin = {
  name: 'dashboard',
  version: '1.0.0',
  description: 'Local web dashboard for metrics, cost, and execution history',

  commands: [
    {
      name: 'dashboard',
      description: 'Open local metrics dashboard in the browser',
      options: [
        { flags: '-p, --port <port>', description: 'Port number (default: 3737)' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const port = parseInt(options.port) || 3737;

        const server = http.createServer((_req, res) => {
          const metrics = readJsonFile(path.join(MAKESTUDIO_HOME, 'metrics.json'));
          const abResults = readJsonFile(path.join(MAKESTUDIO_HOME, 'ab-results.json'));
          const learning = readJsonFile(path.join(MAKESTUDIO_HOME, 'learning.json'));

          let costAlerts: string[] = [];
          try {
            const alertsPath = path.join(MAKESTUDIO_HOME, 'cost-alerts.log');
            if (fs.existsSync(alertsPath)) {
              costAlerts = fs.readFileSync(alertsPath, 'utf8').trim().split('\n').slice(-20);
            }
          } catch (err) { swallow(err); }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildDashboardHTML(metrics, abResults, learning, costAlerts));
        });

        server.listen(port, '127.0.0.1', () => {
          console.log(chalk.green(`\n  Dashboard running at http://127.0.0.1:${port}\n`));
          console.log(chalk.dim('  Press Ctrl+C to stop\n'));
        });

        // Keep process alive
        await new Promise(() => {});
      },
    },
  ],
};

export default plugin;
