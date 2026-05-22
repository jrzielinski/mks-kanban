import { swallow } from '../utils/log';
/**
 * plugin-aider — Adds Aider as a CLI execution strategy.
 * Aider must be installed via pip: `pip install aider-chat`
 */

import { execSync } from 'child_process';
import { MakeStudioPlugin } from '../core/plugin-types';
import { CLIInfo } from '../types';
import { CLIBuildOptions } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'aider',
  version: '1.0.0',
  description: 'Add Aider (aider-chat) as a CLI execution strategy',

  cliStrategies: [
    {
      name: 'aider',

      async detect(): Promise<CLIInfo | null> {
        try {
          const version = execSync('aider --version 2>/dev/null', {
            encoding: 'utf8',
            timeout: 10_000,
          }).trim();

          let cliPath = 'aider';
          try {
            cliPath = execSync('which aider 2>/dev/null', {
              encoding: 'utf8',
              timeout: 5_000,
            }).trim();
          } catch (err) { swallow(err); }

          return {
            name: 'aider',
            version: version.split('\n')[0] || version,
            path: cliPath,
          };
        } catch {
          return null;
        }
      },

      buildCommand(_prompt: string, options: CLIBuildOptions): { command: string; args: string[] } {
        const modelFlag: string[] = [];
        if (options.modelTier === 'fast') {
          modelFlag.push('--model', 'claude-sonnet-4-6');
        } else if (options.modelTier === 'advanced') {
          modelFlag.push('--model', 'claude-opus-4-6');
        }

        return {
          command: 'aider',
          args: [
            '--yes-always',    // Auto-accept all changes
            '--no-git',        // Let MakeStudio handle git
            '--no-auto-commits',
            '--message-file', '/dev/stdin', // Read prompt from stdin
            ...modelFlag,
            ...(options.extraFlags || []),
          ],
        };
      },

      parseOutput(line: string) {
        const trimmed = line.trim();
        if (!trimmed) return null;

        // Aider uses markdown-style output
        if (trimmed.startsWith('> ')) {
          return { type: 'text' as const, message: trimmed.substring(2) };
        }
        if (trimmed.includes('Applied edit to')) {
          const file = trimmed.match(/Applied edit to (.+)/)?.[1];
          return { type: 'tool_call' as const, tool: 'edit', file };
        }
        if (trimmed.includes('Added') && trimmed.includes('to the chat')) {
          const file = trimmed.match(/Added (.+?) to/)?.[1];
          return { type: 'tool_call' as const, tool: 'read', file };
        }

        return { type: 'text' as const, message: trimmed.substring(0, 120) };
      },
    },
  ],
};

export default plugin;
