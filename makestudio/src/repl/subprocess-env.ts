/**
 * subprocess-env.ts
 *
 * Returns a copy of process.env scrubbed of sensitive secrets, for use when
 * spawning subprocesses (Bash tool, MCP stdio servers, hooks, plugin scripts).
 *
 * Port of Claude Code's src/utils/subprocessEnv.ts. Default behavior is
 * passthrough (process.env as-is) for compat — hooks legitimately need the
 * user's NODE_ENV, custom PATH, EDITOR, etc. The scrub only activates when
 * MAKESTUDIO_SUBPROCESS_ENV_SCRUB is truthy, which is the intended policy
 * when running in an exposed environment (CI with untrusted input,
 * multi-tenant runners, the dark-factory backend).
 *
 * The denylist targets credentials that never need to be read by a child
 * process — provider SDKs re-read them per request, cloud SDKs do lazy
 * credential reads, etc.
 */

const SUBPROCESS_SCRUB = [
  // LLM provider auth — providers re-read these per request
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',

  // Cloud provider creds — same lazy SDK pattern
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',

  // OTLP exporter headers carry Authorization=Bearer in practice
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',

  // GitHub Actions OIDC — leaking these allows minting App installation tokens
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // makestudio-specific — stored in ~/.makestudio/config.json, read lazily
  'MAKESTUDIO_TOKEN',
  'MAKESTUDIO_REFRESH_TOKEN',
] as const;

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Returns process.env, scrubbed of secrets if MAKESTUDIO_SUBPROCESS_ENV_SCRUB
 * is set. Default (unset) returns process.env as-is.
 *
 * DESIGN — why opt-in is the default:
 *   Local dev workflows depend on env passthrough: NODE_ENV picked up by
 *   `npm test` hooks, custom PATH for `fvm`/`pyenv`/`asdf`, EDITOR for
 *   `git commit` hooks, etc. Defaulting to scrub would break legitimate
 *   user hooks for the local case, where the trust boundary is "this is
 *   my own machine and my own settings.json".
 *
 *   For the adversarial case (dispatched dark-factory tasks executing
 *   code from a freshly-cloned untrusted workspace), the scrub is auto-
 *   enabled in `ws-client.ts:connect` — so production dispatch always
 *   runs with secrets stripped, while local dev keeps full passthrough.
 *
 *   This mirrors Claude Code's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` design:
 *   opt-in flag, auto-enabled by `claude-code-action` only when the
 *   workflow accepts untrusted input.
 */
export function subprocessEnv(): NodeJS.ProcessEnv {
  if (!isTruthy(process.env.MAKESTUDIO_SUBPROCESS_ENV_SCRUB)) {
    return process.env;
  }
  const env = { ...process.env };
  for (const k of SUBPROCESS_SCRUB) {
    delete env[k];
    // GitHub Actions auto-creates INPUT_<NAME> for action inputs
    delete env[`INPUT_${k}`];
  }
  return env;
}
