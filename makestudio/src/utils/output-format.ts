/**
 * output-format.ts
 *
 * Shared utility for CLI commands that support `--json` flag.
 * Provides a consistent JSON output helper that:
 *   - Writes directly to stdout (no chalk, no extra formatting)
 *   - Handles BigInt and Map serialization
 *   - Supports filtering/sorting fields for stable output
 *   - Manages the "no data" vs "data" cases uniformly
 */

/**
 * Write JSON output to stdout and exit.
 * Handles BigInt, Map, Set, Date serialization transparently.
 */
export function emitJson(data: unknown, options?: { pretty?: boolean }): void {
  const indent = options?.pretty ? 2 : undefined;
  process.stdout.write(JSON.stringify(data, jsonReplacer, indent) + '\n');
}

/**
 * JSON.stringify replacer that handles BigInt, Map, Set, and Date.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Wrap data in a standard envelope: { success: true, data, meta? }.
 * Use for top-level command responses to distinguish from error outputs.
 */
export function emitSuccess(data: unknown, meta?: Record<string, unknown>): void {
  emitJson({ success: true, data, ...(meta ? { meta } : {}) });
}

/**
 * Emit an error response as JSON and exit with code 1.
 */
export function emitError(message: string, details?: unknown): never {
  const payload: Record<string, unknown> = { success: false, error: message };
  if (details !== undefined) payload.details = details;
  process.stdout.write(JSON.stringify(payload, jsonReplacer) + '\n');
  process.exit(1);
}

/**
 * Create a cleaned copy of an object with only specified fields.
 * Handles nested dot-notation paths: pickFields(obj, ['id', 'name', 'meta.size'])
 */
export function pickFields<T extends Record<string, unknown>>(
  obj: T,
  fields: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    const parts = f.split('.');
    let val: unknown = obj;
    for (const p of parts) {
      if (val && typeof val === 'object' && p in (val as Record<string, unknown>)) {
        val = (val as Record<string, unknown>)[p];
      } else {
        val = undefined;
        break;
      }
    }
    if (val !== undefined) result[f] = val;
  }
  return result;
}

/**
 * Return true if the `--json` flag is set.
 * Call at the top of a command — when true, suppress all text output
 * and route final data through emitJson/emitSuccess instead.
 */
export function isJsonMode(options: { json?: boolean }): boolean {
  return options.json === true;
}
