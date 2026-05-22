/**
 * cluster/tool-proxy-policy.ts — what tool calls a remote worker is allowed
 * to route back to the origin (the coordinator that opened the connection).
 *
 * Three categories:
 *   1. PROXYABLE_TOOLS — read-only FS / git / LSP. Safe to execute on the
 *      origin's real codebase. These are the reason tool proxying exists:
 *      without them a remote `explore` worker has no files to explore.
 *   2. ALWAYS_LOCAL_TOOLS — self-contained (web_search, web_fetch, time).
 *      Executing them on the origin would just add round-trip latency.
 *      The worker runs them on its own filesystem.
 *   3. Everything else — rejected when the worker asks the origin to run
 *      them. Bash is gated separately by cluster-trust.json; Edit/Write/
 *      MultiEdit/NotebookEdit are currently never proxied (would mutate
 *      the origin's code and we don't have a trust.allowWrite story yet).
 */

/** Tools whose execution needs the origin's filesystem. */
export const PROXYABLE_TOOLS = new Set<string>([
  'Read', 'Glob', 'Grep', 'LSP',
  'read_file', 'list_files', 'search_code',
  'find_definition', 'find_references', 'get_symbols', 'hover',
  'git_status', 'git_log',
]);

/** Tools that don't touch the filesystem and are safe to run on the worker. */
export const ALWAYS_LOCAL_TOOLS = new Set<string>([
  'web_search', 'web_fetch',
]);

/** Tools that require explicit trust.allowBash to proxy. */
export const BASH_TOOLS = new Set<string>([
  'Bash', 'shell_run',
]);

/** Tools that require explicit trust.allowWrite to proxy (currently none
 *  supported — placeholder for the future when we decide to allow remote
 *  writes to the origin's code, which is genuinely scary). */
export const WRITE_TOOLS = new Set<string>([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

export type ProxyVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Origin-side check: can we honor this tool-call from a remote worker?
 *
 * The remote has already authenticated via Ed25519 (signed hello) so the
 * peerId is not forgeable. `trust` is the resolved PeerTrust from
 * cluster-trust.json for THIS peer at the current cwd.
 */
export function canProxyToolCall(
  toolName: string,
  trust: { allowBash: boolean; allowWrite: boolean },
): ProxyVerdict {
  if (PROXYABLE_TOOLS.has(toolName)) return { allowed: true };
  if (BASH_TOOLS.has(toolName)) {
    return trust.allowBash
      ? { allowed: true }
      : { allowed: false, reason: `Bash proxy requires /cluster trust <peer> --allow-bash` };
  }
  if (WRITE_TOOLS.has(toolName)) {
    // Even with allowWrite, explicit confirmation is safer. For now: no.
    return { allowed: false, reason: `remote writes not supported (would mutate origin's code)` };
  }
  return { allowed: false, reason: `tool "${toolName}" is not proxyable (not in PROXYABLE_TOOLS)` };
}

/** Worker-side check: should we proxy this call to the origin, or run locally? */
export function shouldProxyToOrigin(toolName: string): boolean {
  if (ALWAYS_LOCAL_TOOLS.has(toolName)) return false;
  if (PROXYABLE_TOOLS.has(toolName)) return true;
  // Bash / Edit / unknown: also proxy (let origin's trust policy decide).
  return true;
}
