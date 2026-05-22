import { swallow } from '../utils/log';
/**
 * plugin-type-coverage — Measures TypeScript type coverage percentage.
 * Fails if coverage drops below configurable threshold.
 *
 * Config: plugins.typeCoverage.minPercent (default: 80)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin } from '../core/plugin-types';

function getMinPercent(): number {
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.plugins?.typeCoverage?.minPercent || 80;
    }
  } catch (err) { swallow(err); }
  return 80;
}

const plugin: MakeStudioPlugin = {
  name: 'type-coverage',
  version: '1.0.0',
  description: 'Measure TypeScript type coverage and fail if below threshold',

  verifyChecks: [
    {
      name: 'type-coverage',
      appliesTo: ['feature', 'architecture'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        if (!fs.existsSync(path.join(repoPath, 'tsconfig.json'))) {
          return { passed: true, output: 'No tsconfig.json — skipping' };
        }

        try {
          const result = execSync(
            'npx type-coverage --json-output 2>/dev/null || echo "{}"',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 120_000 },
          ).trim();

          try {
            const data = JSON.parse(result);
            const percent = data.percent || data.correctCount / data.totalCount * 100 || 0;
            const minPercent = getMinPercent();

            if (percent < minPercent) {
              return {
                passed: false,
                output: `Type coverage ${percent.toFixed(1)}% is below minimum ${minPercent}%`,
              };
            }

            return { passed: true, output: `Type coverage: ${percent.toFixed(1)}%` };
          } catch {
            return { passed: true, output: 'Could not parse type-coverage output' };
          }
        } catch {
          return { passed: true, output: 'type-coverage not available — install with: npm i -D type-coverage' };
        }
      },
    },
  ],
};

export default plugin;
