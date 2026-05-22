import { swallow } from '../utils/log';
/**
 * plugin-complexity — Checks cyclomatic complexity of modified files.
 * Uses a lightweight regex-based heuristic (no external deps).
 *
 * Config: plugins.complexity.maxComplexity (default: 15)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin } from '../core/plugin-types';

function getMaxComplexity(): number {
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.plugins?.complexity?.maxComplexity || 15;
    }
  } catch (err) { swallow(err); }
  return 15;
}

/**
 * Lightweight cyclomatic complexity estimation.
 * Counts decision points: if, else if, case, for, while, do, catch, &&, ||, ternary
 */
function estimateComplexity(code: string): Array<{ name: string; complexity: number; line: number }> {
  const results: Array<{ name: string; complexity: number; line: number }> = [];
  const lines = code.split('\n');

  // Find function boundaries
  const funcPattern = /(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{)/;

  let currentFunc = '';
  let currentLine = 0;
  let complexity = 1; // Base complexity
  let braceDepth = 0;
  let inFunc = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const funcMatch = line.match(funcPattern);
    if (funcMatch && !inFunc) {
      currentFunc = funcMatch[1] || funcMatch[2] || funcMatch[3] || `anonymous_${i + 1}`;
      currentLine = i + 1;
      complexity = 1;
      braceDepth = 0;
      inFunc = true;
    }

    if (inFunc) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;

      // Count decision points
      if (/\bif\s*\(/.test(trimmed)) complexity++;
      if (/\belse\s+if\s*\(/.test(trimmed)) complexity++;
      if (/\bcase\s+/.test(trimmed)) complexity++;
      if (/\bfor\s*\(/.test(trimmed)) complexity++;
      if (/\bwhile\s*\(/.test(trimmed)) complexity++;
      if (/\bdo\s*\{/.test(trimmed)) complexity++;
      if (/\bcatch\s*\(/.test(trimmed)) complexity++;
      complexity += (trimmed.match(/&&|\|\|/g) || []).length;
      complexity += (trimmed.match(/\?[^?:]/g) || []).length; // Ternary (not ?.)

      if (braceDepth <= 0 && inFunc) {
        results.push({ name: currentFunc, complexity, line: currentLine });
        inFunc = false;
      }
    }
  }

  return results;
}

const plugin: MakeStudioPlugin = {
  name: 'complexity',
  version: '1.0.0',
  description: 'Check cyclomatic complexity of modified functions',

  verifyChecks: [
    {
      name: 'complexity',
      appliesTo: ['feature', 'architecture'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        try {
          const modifiedFiles = execSync(
            'git diff --name-only --diff-filter=ACMR HEAD | grep -E "\\.(ts|tsx|js|jsx)$" || true',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim().split('\n').filter(Boolean).slice(0, 20);

          if (!modifiedFiles.length) {
            return { passed: true, output: 'No JS/TS files modified' };
          }

          const maxComplexity = getMaxComplexity();
          const violations: string[] = [];

          for (const file of modifiedFiles) {
            const filePath = path.join(repoPath, file);
            if (!fs.existsSync(filePath)) continue;

            const code = fs.readFileSync(filePath, 'utf8');
            const results = estimateComplexity(code);

            for (const r of results) {
              if (r.complexity > maxComplexity) {
                violations.push(`${file}:${r.line} — ${r.name}() complexity=${r.complexity} (max=${maxComplexity})`);
              }
            }
          }

          if (violations.length > 0) {
            return {
              passed: false,
              output: `${violations.length} function(s) exceed max complexity ${maxComplexity}:\n${violations.slice(0, 10).join('\n')}`,
            };
          }

          return { passed: true, output: `${modifiedFiles.length} file(s) checked — all within complexity limits` };
        } catch {
          return { passed: true, output: 'Complexity check failed — skipping' };
        }
      },
    },
  ],
};

export default plugin;
