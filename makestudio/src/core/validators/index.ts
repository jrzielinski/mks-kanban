/**
 * validators/index.ts — registry and runner for stack-specific validators.
 *
 * The execute.ts loop calls `runValidators(ctx)` after every task.
 * This function:
 *   1. Detects which stacks apply to the current repo (via `validator.detect(cwd)`)
 *   2. Runs only the relevant validators
 *   3. Collects all warnings
 *   4. Returns them to the caller (which logs + posts as audit artifacts)
 *
 * Validators NEVER modify files. They are read-only.
 *
 * To add a new stack: create `<name>.ts`, export a StackValidator, and register it below.
 */

import { StackValidator, ValidatorContext, ValidationWarning } from './types';
import { UniversalValidator, parseDeclaredPaths } from './universal';
import { DartFlutterValidator } from './dart-flutter';
import { JavaSpringValidator } from './java-spring';

export { parseDeclaredPaths } from './universal';
export type { StackValidator, ValidatorContext, ValidationWarning, Severity } from './types';

/**
 * Registered validators, in order of execution.
 * Universal always runs first, then stack-specific ones that detect themselves.
 */
const REGISTRY: StackValidator[] = [
  UniversalValidator,
  DartFlutterValidator,
  JavaSpringValidator,
  // Future: TypeScriptNestJsValidator, PythonFastApiValidator, GoValidator, ReactValidator
];

/**
 * Cache of detected validators per cwd — detect() is called once per execute run.
 */
const detectionCache = new Map<string, StackValidator[]>();

function getApplicableValidators(cwd: string): StackValidator[] {
  const cached = detectionCache.get(cwd);
  if (cached) return cached;
  const applicable = REGISTRY.filter(v => {
    try { return v.detect(cwd); } catch { return false; }
  });
  detectionCache.set(cwd, applicable);
  return applicable;
}

/**
 * Main entry point: run all applicable validators against the given context.
 * Returns merged warnings from every validator that fired.
 */
export async function runValidators(ctx: ValidatorContext): Promise<ValidationWarning[]> {
  const validators = getApplicableValidators(ctx.cwd);
  const all: ValidationWarning[] = [];
  for (const v of validators) {
    try {
      const warnings = await v.validate(ctx);
      if (warnings.length > 0) {
        // Prefix the code with the validator name for easier debugging
        for (const w of warnings) {
          all.push({ ...w, code: w.code || `${v.name.toUpperCase()}_UNKNOWN` });
        }
      }
    } catch (err: any) {
      // Never fail the task because of a validator bug — log and continue
      all.push({
        code: 'VALIDATOR_ERROR',
        severity: 'low',
        message: `Validator "${v.name}" threw: ${err?.message || String(err)}`,
      });
    }
  }
  return all;
}

/**
 * Return the list of detected stack names for the given repo.
 * Used by the console UI to show the user which checks will run.
 */
export function detectStackNames(cwd: string): string[] {
  return getApplicableValidators(cwd).map(v => v.label);
}
