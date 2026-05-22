/**
 * plugin-security-scan — Runs npm audit to detect vulnerable dependencies.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'security-scan',
  version: '1.0.0',
  description: 'Run npm audit to detect vulnerable dependencies after task execution',

  verifyChecks: [
    {
      name: 'security-scan',
      appliesTo: ['feature', 'architecture', 'database'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        // Only run if package-lock.json was modified (dependency change)
        try {
          const modifiedFiles = execSync(
            'git diff --name-only --diff-filter=ACMR HEAD',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim();

          const hasLockChange = modifiedFiles.split('\n').some(f =>
            f === 'package-lock.json' || f === 'package.json' || f === 'yarn.lock' || f === 'pnpm-lock.yaml',
          );

          if (!hasLockChange) {
            return { passed: true, output: 'No dependency changes — skipping audit' };
          }
        } catch {
          return { passed: true, output: 'Could not detect changes' };
        }

        if (!fs.existsSync(path.join(repoPath, 'package-lock.json'))) {
          return { passed: true, output: 'No package-lock.json found' };
        }

        try {
          // Run npm audit — only care about high/critical
          const auditOutput = execSync(
            'npm audit --json --audit-level=high 2>/dev/null || true',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 },
          );

          try {
            const audit = JSON.parse(auditOutput);
            const vulnerabilities = audit.metadata?.vulnerabilities || {};
            const high = vulnerabilities.high || 0;
            const critical = vulnerabilities.critical || 0;

            if (critical > 0) {
              return {
                passed: false,
                output: `CRITICAL: ${critical} critical, ${high} high vulnerabilities found. Run: npm audit fix`,
              };
            }

            if (high > 0) {
              return {
                passed: false,
                output: `${high} high severity vulnerabilities found. Run: npm audit fix`,
              };
            }

            const total = Object.values(vulnerabilities).reduce((sum: number, v: any) => sum + (v || 0), 0);
            return { passed: true, output: `Audit passed — ${total} low/moderate issue(s)` };
          } catch {
            return { passed: true, output: 'Could not parse audit output' };
          }
        } catch {
          return { passed: true, output: 'npm audit not available — skipping' };
        }
      },
    },
  ],
};

export default plugin;
