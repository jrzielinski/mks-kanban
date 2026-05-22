import { swallow } from '../utils/log';
/**
 * plugin-watcher — Monitors errors/events and auto-creates fix tasks.
 * Adds `makestudio watch` command that polls for issues.
 *
 * Config: plugins.watcher.sources[] — array of { type, config }
 * Supported types: 'log-file', 'http-endpoint'
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

interface WatcherSource {
  type: 'log-file' | 'http-endpoint';
  name: string;
  config: {
    path?: string;       // For log-file
    url?: string;        // For http-endpoint
    pattern?: string;    // Regex pattern to match errors
    interval?: number;   // Poll interval in seconds (default: 60)
  };
}

function getConfig(): { serverUrl: string; token: string; sources: WatcherSource[] } | null {
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.serverUrl && config.token && config.plugins?.watcher?.sources?.length) {
        return { serverUrl: config.serverUrl, token: config.token, sources: config.plugins.watcher.sources };
      }
    }
  } catch (err) { swallow(err); }
  return null;
}

async function checkLogFile(source: WatcherSource, lastPosition: number): Promise<{ errors: string[]; newPosition: number }> {
  const filePath = source.config.path;
  if (!filePath || !fs.existsSync(filePath)) return { errors: [], newPosition: lastPosition };

  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= lastPosition) return { errors: [], newPosition: lastPosition };

    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size - lastPosition, 1024 * 1024)); // Max 1MB
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);

    const content = buffer.toString('utf8');
    const pattern = source.config.pattern ? new RegExp(source.config.pattern, 'gi') : /error|exception|fatal|critical/gi;
    const errors: string[] = [];

    for (const line of content.split('\n')) {
      if (pattern.test(line)) {
        errors.push(line.trim().substring(0, 200));
      }
    }

    return { errors: errors.slice(0, 10), newPosition: stat.size };
  } catch {
    return { errors: [], newPosition: lastPosition };
  }
}

async function checkHttpEndpoint(source: WatcherSource): Promise<string[]> {
  const url = source.config.url;
  if (!url) return [];

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout: 10_000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            resolve([`HTTP ${res.statusCode}: ${data.substring(0, 200)}`]);
          } else {
            resolve([]);
          }
        });
      });

      req.on('error', (err) => resolve([`Endpoint error: ${err.message}`]));
      req.on('timeout', () => { req.destroy(); resolve([`Endpoint timeout: ${url}`]); });
      req.end();
    } catch { resolve([]); }
  });
}

const plugin: MakeStudioPlugin = {
  name: 'watcher',
  version: '1.0.0',
  description: 'Monitor errors in logs/endpoints and report them',

  commands: [
    {
      name: 'watch',
      description: 'Start watching configured sources for errors',
      options: [
        { flags: '-i, --interval <seconds>', description: 'Poll interval in seconds (default: 60)' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const config = getConfig();

        if (!config) {
          console.log(chalk.red('Watcher not configured.'));
          console.log(chalk.dim('Add plugins.watcher.sources to ~/.makestudio/config.json'));
          console.log(chalk.dim('Example: { "sources": [{ "type": "log-file", "name": "backend", "config": { "path": "/var/log/app.log" } }] }'));
          return;
        }

        const interval = (parseInt(options.interval) || 60) * 1000;
        const filePositions: Map<string, number> = new Map();

        console.log(chalk.cyan(`Watching ${config.sources.length} source(s) every ${interval / 1000}s...`));
        console.log(chalk.dim('Press Ctrl+C to stop\n'));

        const poll = async () => {
          for (const source of config.sources) {
            if (source.type === 'log-file') {
              const lastPos = filePositions.get(source.name) || 0;
              const { errors, newPosition } = await checkLogFile(source, lastPos);
              filePositions.set(source.name, newPosition);

              if (errors.length > 0) {
                console.log(chalk.red(`[${source.name}] ${errors.length} error(s) detected:`));
                for (const err of errors.slice(0, 5)) {
                  console.log(chalk.dim(`  ${err}`));
                }
              }
            } else if (source.type === 'http-endpoint') {
              const errors = await checkHttpEndpoint(source);
              if (errors.length > 0) {
                console.log(chalk.red(`[${source.name}] ${errors.length} issue(s):`));
                for (const err of errors) {
                  console.log(chalk.dim(`  ${err}`));
                }
              }
            }
          }
        };

        // Initial poll
        await poll();

        // Keep polling
        setInterval(poll, interval);
        await new Promise(() => {}); // Keep alive
      },
    },
  ],
};

export default plugin;
