/**
 * tool-corrections.ts
 *
 * Pure helpers that produce short, targeted "what to do next" hints when
 * a tool call fails. Two failure modes covered:
 *
 *   1. POLICY DENIAL (`buildDenialCorrection`) — the user's permission
 *      rules blocked the call. The model needs to know NOT to retry the
 *      same call and what the user actually expects.
 *
 *   2. THROWN ERROR (`buildThrownToolCorrection`) — the tool itself
 *      threw with a recognisable pattern (Read-before-Write violation,
 *      FILE_UNCHANGED_STUB re-read loop, missing file_path, edit race).
 *      Returns a focused correction instead of dumping the raw error.
 *
 * Pure functions: no IO, no mutation, no provider calls. Easy to
 * unit-test in isolation.
 *
 * Originally lived in chat.ts. Extracted because (a) the logic is
 * orthogonal to the chat loop, (b) chat.ts is the project's god-file
 * and shrinking it is a continuous-improvement priority, and (c) these
 * strings are user-facing — having them in one place makes copy edits
 * easier without touching the runtime.
 */

/**
 * Build a short corrective hint after a tool is denied by policy, so the
 * model knows NOT to retry identically + what the user actually expects.
 * Port of Claude Code's withMemoryCorrectionHint (utils/messages.ts).
 * Returns a short string — kept brief so it doesn't explode tool_result size.
 */
export function buildDenialCorrection(toolName: string, input: any): string {
  if (toolName === 'Bash' || toolName === 'shell_run') {
    const cmd = String(input?.command || '').trim().split('\n')[0].slice(0, 80);
    return `The user's permission policy blocked "${cmd}". Do NOT retry the same command. Either rewrite to use read-only equivalents (status/log/info flags instead of destructive ones), or stop and ask the user whether to grant the rule (AskUserQuestion tool).`;
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const p = input?.file_path || input?.notebook_path || '(unknown path)';
    return `Writing to "${p}" is denied. Verify the path is inside the intended project root; if so, ask the user to add an allow rule for the file/dir.`;
  }
  if (toolName === 'WebFetch' || toolName === 'web_fetch') {
    return `WebFetch was denied — likely a non-preapproved domain. If the URL is safe, ask the user to add an allow rule like \`WebFetch(domain:<host>)\` to permissions.json.`;
  }
  return `Policy denied this call. Do NOT retry identically. Either adjust the approach or use AskUserQuestion to confirm the correct path.`;
}

/**
 * Match common tool-throw patterns and emit targeted corrections. Returns
 * null when no specific pattern matches — caller falls back to the raw
 * error message. Kept narrow to avoid drowning the error with boilerplate.
 */
export function buildThrownToolCorrection(toolName: string, errMsg: string): string | null {
  void toolName;
  const m = errMsg.toLowerCase();
  // Read-before-Write guard violation (common LLM mistake)
  if (m.includes('must read') && m.includes('before editing')) {
    return `Call Read on the full file first (with offset/limit if it\'s large), then retry the edit.`;
  }
  // FILE_UNCHANGED_STUB — the model keeps re-reading
  if (m.includes('file_unchanged')) {
    return `You already read this file in this turn. If you need a different section, use offset/limit on a FIRST call, or Grep for the pattern you\'re looking for.`;
  }
  // Path must be absolute
  if (m.includes('must be absolute')) {
    return `Absolute paths only. Prefix with the working directory shown in your dynamic context.`;
  }
  // Missing file_path
  if (m.includes('requires `file_path`') || m.includes('file_path is required')) {
    return `The tool schema expects \`file_path\` — check the ToolSearch output for the exact field name.`;
  }
  // Edit race detection
  if (m.includes('mtime') || m.includes('file changed between read and edit')) {
    return `Something else edited the file between your Read and Edit. Re-read and retry.`;
  }
  return null;
}
