import { emitTaskProgress } from '../network/ws-client';

interface ProgressEvent {
  type: string;
  tool?: string;
  file?: string;
  message?: string;
}

/**
 * Redact secret-shaped substrings before broadcasting progress events to
 * the tenant via WebSocket. Without this, a tool call like
 *   `git push https://x-access-token:GHTOKEN@github.com/...`
 * or `curl -H "Authorization: Bearer SECRET"` would leak the token to
 * every connected client and into the session-replay log files.
 *
 * Patterns covered:
 *   - https URLs with x-access-token credentials
 *   - Authorization headers (Bearer / Basic)
 *   - GitHub PATs (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_)
 *   - Generic api-key=VALUE / token=VALUE / -H 'Authorization: ...'
 */
function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/https:\/\/[^@/\s]+:[^@/\s]+@/g, 'https://[REDACTED]@')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi, '$&'.split(/\s/)[0] + ' [REDACTED]')
    .replace(/\bgh[psour]_[A-Za-z0-9]{16,}/g, '[REDACTED-GH]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[REDACTED-GH]')
    .replace(/\b(?:api[-_]?key|token|secret|password|authorization)\s*[=:]\s*['"]?[A-Za-z0-9._\-+/=]{8,}/gi, (m) => {
      const key = m.split(/[=:]/)[0];
      return `${key}=[REDACTED]`;
    });
}

/**
 * Parse claude CLI stream-json output line.
 * Only extract meaningful events — ignore raw tool results and system messages.
 */
export function parseClaudeOutputStream(
  taskId: string,
  line: string,
  startTime: number,
): ProgressEvent | null {
  const elapsed = Date.now() - startTime;

  if (!line.trim()) return null;

  try {
    const parsed = JSON.parse(line);

    // Ignore system init messages
    if (parsed.type === 'system') return null;

    // Ignore user messages (tool results — huge and irrelevant for progress)
    if (parsed.type === 'user') return null;

    // Ignore rate limit events
    if (parsed.type === 'rate_limit_event') return null;

    // Assistant message with tool use
    if (parsed.type === 'assistant' && parsed.message?.content) {
      const content = parsed.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          // Tool use — this is what we want to show
          if (block.type === 'tool_use') {
            const tool = block.name || 'unknown';
            let detail = '';

            if (block.input) {
              // Extract the most relevant field from tool input
              detail = block.input.file_path
                || block.input.pattern
                || block.input.command?.substring(0, 80)
                || block.input.content?.substring(0, 60)
                || block.input.query?.substring(0, 60)
                || block.input.url?.substring(0, 60)
                || '';
            }
            // Redact secrets BEFORE emitting — `detail` is broadcast to the
            // tenant room and persisted in session replay; without this a
            // single `git push https://x-access-token:TOKEN@...` would leak
            // the token to every connected operator and into the replay logs.
            detail = redactSecrets(detail);

            const message = detail ? `${tool}: ${detail}` : tool;
            const event: ProgressEvent = { type: 'tool_call', tool, file: detail, message };
            emitTaskProgress(taskId, 'tool_call', elapsed, { tool, file: detail, message });
            return event;
          }

          // Text content from assistant — show short messages
          if (block.type === 'text' && block.text) {
            const text = block.text.trim();
            if (text.length > 0 && text.length < 200) {
              const event: ProgressEvent = { type: 'text', message: text };
              emitTaskProgress(taskId, 'text', elapsed, { message: text });
              return event;
            }
          }
        }
      }
      return null;
    }

    // Final result
    if (parsed.type === 'result') {
      const cost = parsed.total_cost_usd || 0;
      const turns = parsed.num_turns || 0;
      const duration = parsed.duration_ms ? Math.round(parsed.duration_ms / 1000) : 0;
      const message = `Concluído: ${turns} turnos, ${duration}s, $${cost.toFixed(4)}`;
      const event: ProgressEvent = { type: 'result', message };
      emitTaskProgress(taskId, 'result', elapsed, { message });
      return event;
    }

    return null;
  } catch {
    // Not JSON — ignore raw output lines (don't spam)
    return null;
  }
}

/**
 * Parse generic CLI output (codex/gemini) and emit progress.
 */
export function parseGenericOutput(
  taskId: string,
  line: string,
  startTime: number,
): ProgressEvent | null {
  const elapsed = Date.now() - startTime;
  const trimmed = line.trim();

  if (!trimmed || trimmed.length < 3) return null;

  // Skip very long lines (probably data dumps)
  if (trimmed.length > 200) return null;

  const event: ProgressEvent = {
    type: 'output',
    message: trimmed,
  };
  emitTaskProgress(taskId, 'output', elapsed, { message: trimmed });
  return event;
}
