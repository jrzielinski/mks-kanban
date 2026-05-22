/**
 * tool-input-validator.ts
 *
 * Pre-dispatch validation for tool calls. Some providers (notably smaller
 * OSS models like deepseek-v4-flash) emit malformed tool_use blocks —
 * empty input, missing required fields, wrong types — and the underlying
 * impl crashes with raw Node errors like:
 *   "The 'path' argument must be of type string. Received undefined"
 *
 * That message tells the LLM nothing about which tool, which field, or
 * what shape was expected. The model retries with the same broken call.
 *
 * This validator runs BEFORE the impl, catches missing/wrong-type fields,
 * and throws a descriptive error the LLM can act on:
 *   "Write requires `file_path` (absolute string) and `content` (string).
 *    You called: {}. Re-emit with both fields set."
 *
 * The error string is what becomes the tool_result the model sees on the
 * next turn — it self-corrects in the same loop instead of looping on the
 * raw Node TypeError.
 */
type ArgKind = 'string' | 'string-or-number' | 'array' | 'object' | 'boolean';

interface FieldSpec {
  name: string;
  kind: ArgKind;
  required: boolean;
  /** Short hint about expected shape — appears in the error message. */
  hint?: string;
}

const TOOL_SCHEMAS: Record<string, FieldSpec[]> = {
  // ── File tools ─────────────────────────────────────────────────────
  Read: [
    { name: 'file_path', kind: 'string', required: true, hint: 'absolute path' },
  ],
  Write: [
    { name: 'file_path', kind: 'string', required: true, hint: 'absolute path' },
    { name: 'content', kind: 'string', required: true, hint: 'full file contents (may be empty string)' },
  ],
  Edit: [
    { name: 'file_path', kind: 'string', required: true, hint: 'absolute path' },
    { name: 'old_string', kind: 'string', required: true, hint: 'exact text to replace' },
    { name: 'new_string', kind: 'string', required: true, hint: 'replacement text (must differ from old_string)' },
  ],
  MultiEdit: [
    { name: 'file_path', kind: 'string', required: true, hint: 'absolute path' },
    { name: 'edits', kind: 'array', required: true, hint: 'array of {old_string, new_string} objects, applied in order' },
  ],
  Glob: [
    { name: 'pattern', kind: 'string', required: true, hint: 'glob like "src/**/*.ts" or "**/foo.json"' },
  ],
  Grep: [
    { name: 'pattern', kind: 'string', required: true, hint: 'regex (ripgrep syntax)' },
  ],
  Bash: [
    { name: 'command', kind: 'string', required: true, hint: 'shell command line' },
  ],
  NotebookEdit: [
    { name: 'notebook_path', kind: 'string', required: true, hint: 'absolute .ipynb path' },
  ],

  // ── Common advanced tools ──────────────────────────────────────────
  TodoWrite: [
    { name: 'todos', kind: 'array', required: true, hint: 'array of {content, status, activeForm} objects' },
  ],
  WebFetch: [
    { name: 'url', kind: 'string', required: true, hint: 'fully-qualified URL with scheme' },
    { name: 'prompt', kind: 'string', required: true, hint: 'what to extract / answer about the page' },
  ],
  WebSearch: [
    { name: 'query', kind: 'string', required: true, hint: 'search query' },
  ],
  read_attachment: [
    { name: 'id', kind: 'string-or-number', required: true, hint: 'attachment id from the system (integer or numeric string)' },
  ],
  read_file: [
    { name: 'projectPath', kind: 'string', required: true, hint: 'absolute path to project root' },
    { name: 'filePath', kind: 'string', required: true, hint: 'project-relative file path (NOT an absolute path)' },
  ],
  AskUserQuestion: [
    { name: 'questions', kind: 'array', required: true, hint: 'array of {question, header, multiSelect, options}' },
  ],

  // ── Sub-agent dispatch ─────────────────────────────────────────────
  // These are particularly important to validate: a malformed
  // dispatch_agent crashes deep in the subagent runtime with confusing
  // stack traces, when in reality the model just forgot to set `task`.
  dispatch_agent: [
    { name: 'task', kind: 'string', required: true, hint: 'clear focused task description for the subagent' },
  ],
  dispatch_agents_parallel: [
    { name: 'agents', kind: 'array', required: true, hint: 'array of 2-6 {task, subagent_type, ...} entries' },
  ],
};

function classify(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesKind(value: unknown, kind: ArgKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'string-or-number':
      return typeof value === 'string' || typeof value === 'number';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

/**
 * Validate a tool call's input against the tool's known schema. Throws a
 * descriptive error when fields are missing or have the wrong type. No-op
 * when the tool isn't in the schema table (plugin tools, custom subagent
 * tools — those validate themselves).
 */
export function validateToolInput(toolName: string, input: unknown): void {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) return; // unknown tool — let the impl handle it
  if (input === null || input === undefined || typeof input !== 'object') {
    const required = schema
      .filter((f) => f.required)
      .map((f) => `\`${f.name}\` (${f.kind}${f.hint ? `, ${f.hint}` : ''})`)
      .join(', ');
    throw new Error(
      `${toolName} called with no arguments (${classify(input)}). Re-emit with: ${required}.`,
    );
  }

  const obj = input as Record<string, unknown>;
  const missing: string[] = [];
  const wrongType: string[] = [];

  for (const field of schema) {
    const present = Object.prototype.hasOwnProperty.call(obj, field.name);
    const value = obj[field.name];
    if (field.required) {
      if (!present || value === undefined || value === null) {
        missing.push(`\`${field.name}\` (${field.kind}${field.hint ? ` — ${field.hint}` : ''})`);
        continue;
      }
    } else if (!present || value === undefined) {
      continue; // optional field omitted — fine
    }
    if (!matchesKind(value, field.kind)) {
      wrongType.push(
        `\`${field.name}\`: expected ${field.kind}${field.hint ? ` (${field.hint})` : ''}, got ${classify(value)}`,
      );
    }
  }

  if (missing.length === 0 && wrongType.length === 0) return;

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (wrongType.length > 0) parts.push(`wrong type: ${wrongType.join('; ')}`);

  // Compact preview of what the model actually sent — helps it spot the
  // schema drift (e.g. "I sent `path` instead of `file_path`").
  let preview: string;
  try {
    preview = JSON.stringify(obj).slice(0, 200);
  } catch {
    preview = '[unserializable]';
  }

  throw new Error(
    `${toolName} called with invalid input — ${parts.join('; ')}. You sent: ${preview}. Re-emit ${toolName} with the missing/correct fields.`,
  );
}
