/**
 * plugin-env-check — Validates that .env files have all required variables.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'env-check',
  version: '1.0.0',
  description: 'Validate .env files have all required variables defined in .env.example',

  verifyChecks: [
    {
      name: 'env-check',
      appliesTo: ['feature', 'architecture', 'database'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        const examplePath = path.join(repoPath, '.env.example');
        const envPath = path.join(repoPath, '.env');

        if (!fs.existsSync(examplePath)) {
          return { passed: true, output: 'No .env.example found — skipping' };
        }

        if (!fs.existsSync(envPath)) {
          return { passed: true, output: 'No .env file found — skipping (developer must create)' };
        }

        try {
          const parseEnvKeys = (content: string): Set<string> => {
            const keys = new Set<string>();
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
              if (match) keys.add(match[1]);
            }
            return keys;
          };

          const exampleKeys = parseEnvKeys(fs.readFileSync(examplePath, 'utf8'));
          const envKeys = parseEnvKeys(fs.readFileSync(envPath, 'utf8'));

          const missing: string[] = [];
          for (const key of exampleKeys) {
            if (!envKeys.has(key)) {
              missing.push(key);
            }
          }

          // Also check if new env vars were added to .env.example in this diff
          const newInExample: string[] = [];
          for (const key of envKeys) {
            if (!exampleKeys.has(key)) {
              newInExample.push(key);
            }
          }

          if (missing.length > 0) {
            return {
              passed: false,
              output: `Missing ${missing.length} env var(s) from .env that exist in .env.example:\n${missing.map(k => `  - ${k}`).join('\n')}`,
            };
          }

          let msg = `All ${exampleKeys.size} env vars present`;
          if (newInExample.length > 0) {
            msg += ` (note: ${newInExample.length} var(s) in .env not in .env.example: ${newInExample.slice(0, 5).join(', ')})`;
          }

          return { passed: true, output: msg };
        } catch (err: any) {
          return { passed: true, output: `Error reading env files: ${err.message}` };
        }
      },
    },
  ],
};

export default plugin;
