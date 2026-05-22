import { swallow } from '../utils/log';
/**
 * plugin-cursor — Adds Cursor AI as a CLI execution strategy.
 * Cursor must be installed and accessible via `cursor` command.
 */

import { execSync } from 'child_process';
import { MakeStudioPlugin } from '../core/plugin-types';
import { CLIInfo } from '../types';
import { CLIBuildOptions } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'cursor',
  version: '1.0.0',
  description: 'Add Cursor AI as a CLI execution strategy',

  cliStrategies: [
    {
      name: 'cursor',

      async detect(): Promise<CLIInfo | null> {
        try {
          const version = execSync('cursor --version 2>/dev/null', {
            encoding: 'utf8',
            timeout: 10_000,
          }).trim();

          let cliPath = 'cursor';
          try {
            cliPath = execSync('which cursor 2>/dev/null', {
              encoding: 'utf8',
              timeout: 5_000,
            }).trim();
          } catch (err) { swallow(err); }

          return {
            name: 'cursor',
            version: version.split('\n')[0] || version,
            path: cliPath,
          };
        } catch {
          return null;
        }
      },

      buildCommand(_prompt: string, options: CLIBuildOptions): { command: string; args: string[] } {
        return {
          command: 'cursor',
          args: [
            'agent',
            '--full-auto',
            ...(options.extraFlags || []),
          ],
        };
      },

      parseOutput(line: string, _taskId: string, _startTime: number) {
        // Basic output parsing — Cursor uses a similar format to claude CLI
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'tool_use' || parsed.type === 'tool_call') {
            return { type: 'tool_call' as const, tool: parsed.name || parsed.tool, file: parsed.file };
          }
          if (parsed.type === 'text' || parsed.type === 'message') {
            return { type: 'text' as const, message: parsed.text || parsed.content };
          }
          if (parsed.type === 'result' || parsed.type === 'done') {
            return { type: 'result' as const, message: parsed.result || 'Completed' };
          }
        } catch {
          // Not JSON — plain text output
          if (line.trim()) {
            return { type: 'text' as const, message: line.trim().substring(0, 120) };
          }
        }
        return null;
      },
    },
  ],
};

export default plugin;
