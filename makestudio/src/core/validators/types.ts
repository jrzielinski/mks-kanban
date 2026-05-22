/**
 * types.ts — shared types for the stack-specific validator registry.
 *
 * Each stack (Dart/Flutter, TypeScript/NestJS, Java/Spring, Python/FastAPI, etc.)
 * implements a StackValidator and registers itself in index.ts. After every task,
 * execute.ts runs the relevant validators on the files that were created/modified.
 *
 * Validators are read-only — they emit warnings that become audit artifacts
 * in the backend. They NEVER modify files themselves.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface ValidationWarning {
  /** Stable machine-readable code, e.g. "DART_FORCE_UNWRAP_ABUSE" */
  code: string;
  severity: Severity;
  /** Human-readable message for the console and audit artifact */
  message: string;
  /** File path (relative to repo root) this warning applies to — may be empty for project-wide */
  file?: string;
  /** Optional line number inside the file */
  line?: number;
  /** Optional extra context for debugging */
  evidence?: string;
}

export interface ValidatorContext {
  /** Repository root (absolute) */
  cwd: string;
  /** Files changed/created in the current task or DUM (relative to cwd) */
  changedFiles: string[];
  /** The task that just executed (for task.techContext and task.title) */
  task?: any;
  /** The DUM the task belongs to (for dum.type and dum.dumNumber) */
  dum?: any;
}

export interface StackValidator {
  /** Short identifier, e.g. "dart-flutter", "typescript-nestjs" */
  name: string;
  /** Human-readable label for console output */
  label: string;
  /**
   * Returns true if this validator applies to the given repo root.
   * Called ONCE per execute run — not per task.
   *
   * Implementations typically check for the presence of stack markers
   * (pubspec.yaml for Dart, pom.xml for Java, package.json with @nestjs/* for NestJS, etc.)
   */
  detect(cwd: string): boolean;
  /**
   * Run all checks for this stack against the given context.
   * Must be read-only: no file writes, no shell mutations.
   * Return ALL warnings found — the caller decides what to do with them.
   */
  validate(ctx: ValidatorContext): Promise<ValidationWarning[]>;
}
