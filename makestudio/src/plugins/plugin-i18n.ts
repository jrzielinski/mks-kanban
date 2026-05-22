/**
 * plugin-i18n — Detects hardcoded strings in new code and reports them.
 * Helps enforce internationalization by flagging user-facing strings.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'i18n',
  version: '1.0.0',
  description: 'Detect hardcoded user-facing strings in new code',

  verifyChecks: [
    {
      name: 'i18n-strings',
      appliesTo: ['feature', 'design'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        try {
          const diff = execSync('git diff HEAD', {
            cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 15_000,
          }).trim();

          if (!diff) return { passed: true, output: 'No changes to check' };

          // Find added lines with hardcoded strings in JSX/TSX
          const hardcodedStrings: string[] = [];
          const lines = diff.split('\n');

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.startsWith('+') || line.startsWith('+++')) continue;

            const content = line.substring(1).trim();

            // Skip imports, comments, type definitions
            if (content.startsWith('import ') || content.startsWith('//') || content.startsWith('*') ||
                content.startsWith('type ') || content.startsWith('interface ')) continue;

            // Detect user-facing strings in JSX: >Text here<
            const jsxText = content.match(/>([A-Z][a-zÀ-ú][\w\sÀ-ú]{3,})</g);
            if (jsxText) {
              hardcodedStrings.push(...jsxText.map(t => t.substring(1).substring(0, 50)));
            }

            // Detect strings in props like: title="Some Text", placeholder="Enter..."
            const propStrings = content.match(/(?:title|label|placeholder|description|message|text|alt|aria-label)=["']([A-Z][a-zÀ-ú][\w\sÀ-ú]{3,})["']/g);
            if (propStrings) {
              hardcodedStrings.push(...propStrings.map(t => t.substring(0, 60)));
            }
          }

          if (hardcodedStrings.length > 0) {
            return {
              passed: true, // Warning only
              output: `${hardcodedStrings.length} hardcoded string(s) found (consider i18n):\n${hardcodedStrings.slice(0, 10).map(s => `  - ${s}`).join('\n')}`,
            };
          }

          return { passed: true, output: 'No hardcoded strings detected' };
        } catch {
          return { passed: true, output: 'i18n check failed — skipping' };
        }
      },
    },
  ],
};

export default plugin;
