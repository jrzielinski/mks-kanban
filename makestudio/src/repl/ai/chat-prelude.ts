import { ReplContext } from '../context';
import { toolDefinitions, getCoordinatorToolDefs } from './tools';
import { microCompact } from './micro-compact';
import { appendMessage } from '../sessions';

import { swallow } from '../../utils/log';
/**
 * Pre-flight gates: must be authenticated AND have the boot-time API
 * key injected from /repl-chat/info. Surface failures via the supplied
 * surface callback (TUI bridge or console.log shim).
 *
 * Returns the resolved provider on success or `null` if the caller
 * should bail out of the chat handler.
 */
export function runChatPreflight(
  ctx: ReplContext,
  surfaceError: (text: string) => void,
): { provider: any | null } {
  if (!ctx.isAuthenticated()) {
    surfaceError('Faca login primeiro: /login');
    return { provider: null };
  }
  // Architectural contract: chat goes DIRECT to the provider with the key
  // injected at boot from /repl-chat/info. If the boot didn't get a usable
  // key (tenant apiConfig.apiKey is null, /repl-chat/info failed, etc.) we
  // refuse to start the turn instead of silently routing through the
  // backend proxy.
  if (!(ctx as any).sessionKeyInjected) {
    const reason = (ctx as any).sessionKeyError || 'unknown';
    surfaceError(
      `Session key not injected at boot — direct LLM call is not available. ` +
      `Reason: ${reason}. Run /login again after fixing the backend apiConfig.`,
    );
    return { provider: null };
  }
  const { getProvider } = require('./providers');
  return { provider: getProvider(ctx.provider) };
}

/**
 * Capture image attachments queued via /paste or detected as paths in
 * the user input. Returns the (possibly rewritten) input + a content-
 * blocks array ready to be merged into the user message.
 */
export function captureImageAttachments(
  input: string,
  surface: (count: number) => void,
): { input: string; pendingImageBlocks: any[] } {
  let pendingImageBlocks: any[] = [];
  try {
    const { detectImagePathsInText, listAttachedImages, imagesToContentBlocks, clearAttachedImages } = require('../image-paste');
    const detected = detectImagePathsInText(input);
    const queued = listAttachedImages();
    const all = [...queued, ...detected.attached];
    if (all.length > 0) {
      pendingImageBlocks = imagesToContentBlocks(all);
      surface(all.length);
      clearAttachedImages();
      input = detected.text;
    }
  } catch (err) { swallow(err); }
  return { input, pendingImageBlocks };
}

/**
 * Persist the user message into ctx.messages + the session log + the
 * cassette recorder, and record the user/turn_start trajectory event.
 * Honours `ctx.__skillDisplayText` (set by the router on slash-skill
 * expansions) so session resume doesn't re-dump the skill body.
 */
export function persistUserMessage(
  ctx: ReplContext,
  userMsg: any,
  input: string,
): void {
  if ((ctx as any).__skillDisplayText) {
    userMsg.displayText = String((ctx as any).__skillDisplayText);
    delete (ctx as any).__skillDisplayText;
  }
  ctx.messages.push(userMsg);
  appendMessage(ctx, userMsg);
  try { require('../cassettes').recordTurn(ctx, userMsg); } catch (err) { swallow(err); }
  ctx.lastUserMessage = input;
  try {
    const { recordCtxEvent } = require('../trajectory');
    recordCtxEvent(ctx, 'user', 'turn_start', {
      provider: ctx.providerInfo?.provider,
      model: ctx.providerInfo?.model,
      effort: ctx.effort,
      inputPreview: String(input || '').slice(0, 600),
    });
  } catch (err) { swallow(err); }
}

/**
 * Reset per-turn state that's NOT covered by `resetTurnRetryFlags`:
 * post-edit tracking, file-Read cache, /rewind checkpoint open.
 */
export function resetPerTurnState(ctx: ReplContext, input: string): void {
  try { require('./post-edit-hooks').clearTurnEdits(ctx); } catch (err) { swallow(err); }
  try { ctx.readCache?.clear(); } catch (err) { swallow(err); }
  try { require('../rewind').beginTurn(ctx, input); } catch (err) { swallow(err); }
}

/**
 * Run the UserPromptSubmit hook chain. The user can wire this to e.g.
 * append context (`git status`) or log the prompt externally.
 * Non-blocking; failures logged via the supplied surface and don't abort
 * the turn.
 */
export async function runUserPromptSubmitHook(
  ctx: ReplContext,
  input: string,
  surfaceWarn: (msg: string) => void,
): Promise<void> {
  try {
    const { runHooks } = require('../hooks');
    const res = await runHooks('UserPromptSubmit', {
      projectPath: ctx.cwd,
      userMessage: input,
      currentAbortController: ctx.currentAbortController,
    });
    if (res.failures.length > 0) {
      for (const f of res.failures) surfaceWarn(f);
    }
  } catch (err) { swallow(err); }
}

/**
 * Reset all per-turn retry flags. Both streaming and non-streaming paths
 * call this at the very start of a turn so each new turn gets one fresh
 * shot at every guard / verifier loop.
 */
export function resetTurnRetryFlags(ctx: ReplContext): void {
  (ctx as any).__reasoningRecoveryTries = 0;
  (ctx as any).__verifierRetryDone = false;
  (ctx as any).__contradictionRetryDone = false;
  (ctx as any).__promisedActionNudgeFired = false;
  (ctx as any).__toolMarkupRetryCount = 0;
  (ctx as any).__toolMarkupAbort = false;
  (ctx as any).__fabricatedOutputRetryDone = false;
  (ctx as any).__bashFailureRetryDone = false;
  (ctx as any).__numberFabricationRetryDone = false;
  (ctx as any).__searchClaimRetryDone = false;
  (ctx as any).__missingTestRetryDone = false;
  (ctx as any).__turnBashFailures = [];
}

/**
 * Extract text attachments (long pastes externalised to /attachments).
 * Skipped for one turn after a skill expansion (router sets the flag) —
 * the skill body is instructions, not user-pasted content, and turning
 * it into [Pasted #N] confuses the model.
 *
 * Returns the (possibly rewritten) message body. The number of
 * extracted attachments is reported via `surface(count)` so the caller
 * decides how to render the notice (TUI bridge vs console.log).
 */
export function extractTextAttachments(
  inputRaw: string,
  ctx: ReplContext,
  surface: (count: number) => void,
): string {
  if ((ctx as any).__skipAttachmentExtractionOnce) {
    (ctx as any).__skipAttachmentExtractionOnce = false;
    return inputRaw;
  }
  try {
    const { extractAttachments } = require('../attachments');
    const r = extractAttachments(inputRaw);
    if (r.attachments?.length > 0) surface(r.attachments.length);
    return r.message;
  } catch {
    return inputRaw;
  }
}

/**
 * Build the system prompt with relevant memory topics injected. Returns
 * the joined system prompt + the static/dynamic halves so the caller
 * can pass them as separate cache_control blocks to Anthropic.
 */
export async function buildSystemPromptWithMemory(
  ctx: ReplContext,
  inputRaw: string,
  provider: any,
): Promise<{ systemPrompt: string; systemStatic: string; systemDynamic: string }> {
  const systemStatic = ctx.buildSystemPromptStatic();
  let systemDynamic = ctx.buildSystemPromptDynamic();
  try {
    const { findRelevant, findRelevantLLM, touchTopic } = require('../memory');
    // Prefer LLM-based semantic match (cheap via fast provider) when available;
    // falls back to keyword inside findRelevantLLM when no fast provider.
    const relevant = await findRelevantLLM(inputRaw, 3, { provider }).catch(() => findRelevant(inputRaw, 3));
    if (relevant.length > 0) {
      systemDynamic += '\n\n## Relevant memory\n' + relevant.map((t: any) => `### ${t.name}\n${t.body.substring(0, 800)}`).join('\n\n');
      for (const t of relevant) touchTopic(t.name);
    }
  } catch (err) { swallow(err); }
  // Append any session-pinned constraints (test-coverage demands, tsc
  // verification, etc) so the model sees them on every system prompt
  // build — the dominant failure mode without this is the model
  // forgetting a binding rule once the work grows long.
  try {
    const { formatConstraintsForPrompt } = require('../session-constraints');
    const block = formatConstraintsForPrompt(ctx);
    if (block) systemDynamic += '\n\n' + block;
  } catch (err) { swallow(err); }
  const systemPrompt = `${systemStatic}\n\n${systemDynamic}`;
  return { systemPrompt, systemStatic, systemDynamic };
}

/**
 * Load MCP server tools and assemble the enriched tool catalogue
 * (tool defs decorated with active-project context + coordinator tools
 * + MCP-registered tools).
 */
export async function assembleEnrichedTools(ctx: ReplContext): Promise<any[]> {
  const projectPath = ctx.activeProject?.localPath || ctx.cwd;
  let mcpTools: any[] = [];
  try {
    const { initMcpServers } = require('../mcp');
    const loaded = await initMcpServers(ctx.cwd);
    mcpTools = (loaded.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  } catch (err) { swallow(err); }

  // Lazy MCP loading — when settings.mcpLazyLoad is true (default false),
  // each MCP tool's description and input_schema are stripped to a thin
  // 1-line stub. The model sees the names + a hint to call ToolSearch
  // for full schemas before invoking. claude-code uses defer_loading=true
  // in the same vein: cuts ~200-1K tokens per turn for users with 20+
  // MCP servers, at the cost of one extra ToolSearch round-trip when a
  // specific MCP tool is needed. Worth it when the catalogue is big and
  // most tools are unused per task.
  let lazy = false;
  try {
    const { loadSettings } = require('../settings');
    lazy = !!loadSettings()?.mcpLazyLoad;
  } catch (err) { swallow(err); }
  const finalMcpTools = lazy && mcpTools.length > 6
    ? mcpTools.map((t: any) => ({
      name: t.name,
      // Strip description + schema so the cacheable tools array stays
      // small. The model can still call the tool; it just sees the name
      // and a hint pointing it at ToolSearch when it needs the schema.
      description: `[lazy] ${(t.description || '').slice(0, 60)} — call ToolSearch with select:${t.name} before invoking to load the schema.`,
      input_schema: { type: 'object', additionalProperties: true },
    }))
    : mcpTools;

  return [
    ...toolDefinitions.map((t: any) => ({
      ...t,
      description: ctx.activeProject
        ? `${t.description} (Active project: ${ctx.activeProject.name}, id: ${ctx.activeProject.id}, path: ${projectPath})`
        : t.description,
    })),
    ...getCoordinatorToolDefs(ctx),
    ...finalMcpTools,
  ];
}

/**
 * Pre-warm the prompt cache. Sends one tiny LLM call with the same
 * system + tools the next real turn will use, so Anthropic's prefix
 * cache writes the breakpoints. The first user message then hits cache
 * instead of paying the full cache-write cost (saves ~5-15K tokens
 * worth of input on big system prompts).
 *
 * Opt-in via settings.cacheWarmOnStart. Best-effort: any failure
 * (network, provider down, no key) is silently swallowed — never
 * block startup.
 */
export async function warmCacheIfEnabled(ctx: ReplContext): Promise<void> {
  // LSP warm pool — fire-and-forget. Independent of cache warm so
  // users can opt into one without the other. Triggers a background
  // server spawn for each language detected in the project root.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { warmLspPool } = require('../lsp-warm');
    warmLspPool(ctx.cwd || process.cwd());
  } catch (err) { swallow(err); }

  let enabled = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('../settings');
    enabled = !!loadSettings()?.cacheWarmOnStart;
  } catch (err) { swallow(err); }
  if (!enabled) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getProvider } = require('./providers');
    const provider = getProvider(ctx.provider);
    if (!provider?.sendMessage) return;
    const enrichedTools = await assembleEnrichedTools(ctx);
    const systemStatic = ctx.buildSystemPromptStatic();
    const systemDynamic = ctx.buildSystemPromptDynamic();
    const systemPrompt = `${systemStatic}\n\n${systemDynamic}`;
    await provider.sendMessage({
      system: systemPrompt,
      systemStatic,
      systemDynamic,
      messages: [{ role: 'user', content: 'ready' }],
      tools: enrichedTools,
      effort: 'low',
      maxTokens: 4,
    });
  } catch (err) { swallow(err); }
}

/**
 * Eager microCompact pass — zero LLM cost, just trims tool_result
 * bodies in turns older than MICRO_COMPACT_KEEP_RECENT. Runs EVERY
 * turn regardless of the autoCompact threshold so big outputs from
 * Read/Edit/Bash don't pile up linearly during a long task with many
 * file edits. Idempotent: already-trimmed bodies stay below the
 * min-size threshold and are skipped.
 */
export function runEagerMicroCompactPass(
  ctx: ReplContext,
  surface: (msg: string) => void,
): void {
  try {
    const microEager = microCompact(ctx);
    if (microEager.trimmed > 0) {
      surface(`microCompact: freed ${microEager.freedChars.toLocaleString()} chars across ${microEager.trimmed} old tool_result${microEager.trimmed === 1 ? '' : 's'}`);
    }
  } catch (err) { swallow(err); }
}

/**
 * AwaySummary: if the user idled past the threshold since last turn,
 * fire a recap that BLOCKS the main turn until done (prevents
 * interleaving). DOUBLE-FIRE GUARD: ctx.lastTurnAt is updated AND
 * ctx.awaySummaryFiredAt is set before the async call so back-to-back
 * turns can't both trigger.
 */
export async function runAwaySummaryIfNeeded(
  ctx: ReplContext,
  bridge: { addMessage: (m: any) => any },
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const away = require('./away-summary');
    const prevTurnAt = ctx.lastTurnAt;
    const now = Date.now();
    ctx.lastTurnAt = now;
    // Secondary guard: don't fire if another recap ran within the last 60s.
    const recentFire = (ctx as any).awaySummaryFiredAt || 0;
    if (away.gapIsAway(prevTurnAt) && (now - recentFire) > 60_000) {
      (ctx as any).awaySummaryFiredAt = now;
      const gapMin = Math.round((now - prevTurnAt) / 60000);
      try {
        const { setTransientStatus } = require('../tui/bridge');
        setTransientStatus?.(`welcome back · ${gapMin} min since last turn — recapping...`, 8000);
      } catch (err) { swallow(err); }
      try {
        const s = await away.generateAwaySummary(ctx);
        if (s) bridge.addMessage({ role: 'info', text: '↳ ' + s });
      } catch (err) { swallow(err); }
    }
  } catch { ctx.lastTurnAt = Date.now(); }
}

/**
 * /clear hint. When the cumulative token count is high AND the user
 * looks like they're switching topics (new-task opener OR long idle
 * gap), nudge with "new task? /clear to save Nk tokens" so the next
 * turn doesn't pay re-processing cost on stale context. Cheap
 * heuristic — a false positive is an easy-to-ignore one-liner; a
 * false negative just means the user pays a few extra cents of tokens.
 */
export function maybeShowClearHint(ctx: ReplContext, input: string): void {
  try {
    const totalTokens = ctx.usage?.totalTokens || 0;
    if (totalTokens > 100_000) {
      const trimmed = String(input || '').trim().toLowerCase();
      const isNewTaskOpener = /^(agora|now|ok\b|próximo|proximo|next\b|vamos|let'?s\b|new\b|novo\b|nova\b|outra|outro|another|muda|change topic|topic change)/.test(trimmed);
      const idleGapMs = ctx.lastTurnAt ? Date.now() - ctx.lastTurnAt : 0;
      const longIdle = idleGapMs > 5 * 60 * 1000; // 5 minutes
      if (isNewTaskOpener || longIdle) {
        const k = totalTokens >= 1000
          ? `${(totalTokens / 1000).toFixed(1)}k`
          : `${totalTokens}`;
        const { setTransientStatus } = require('../tui/bridge');
        setTransientStatus?.(`new task? /clear to save ${k} tokens`, 8000);
      }
    }
  } catch (err) { swallow(err); }
}

/**
 * Turn-elapsed alert. A long turn isn't necessarily stuck — could be a
 * big multi-file refactor, a slow build, etc. — but the user has zero
 * feedback past the busy spinner. Every 2 minutes during a turn we
 * flash a transient status with elapsed + a hint to /trajectory show.
 *
 * The clear function is stashed on `ctx.__clearTurnAlert` so the
 * multiple early-return paths in handleAIChatStream can fire it without
 * threading a local through every branch.
 */
export function installTurnAlertTimer(ctx: ReplContext): void {
  const turnStartedAt = Date.now();
  const TURN_ALERT_MS = 2 * 60 * 1000;
  let turnAlertTimer: NodeJS.Timeout | null = setTimeout(function tick() {
    const elapsedMin = Math.round((Date.now() - turnStartedAt) / 60_000);
    try {
      const { setTransientStatus } = require('../tui/bridge');
      setTransientStatus?.(`turn running for ${elapsedMin}m · /trajectory show to inspect · Esc Esc to interrupt`, 6000);
    } catch (err) { swallow(err); }
    turnAlertTimer = setTimeout(tick, TURN_ALERT_MS);
    turnAlertTimer.unref?.();
  }, TURN_ALERT_MS);
  turnAlertTimer.unref?.();
  (ctx as any).__clearTurnAlert = () => {
    if (turnAlertTimer) { clearTimeout(turnAlertTimer); turnAlertTimer = null; }
  };
}

/**
 * One-shot heal: ensure every assistant message in `ctx.messages` has
 * reasoning_content set (empty string if missing). Older sessions and
 * the previous (broken) recovery code left some assistant messages
 * without the field, which trips DeepSeek's "must be passed back" check
 * on the very first request of the next turn. Cheap, idempotent, runs
 * once per turn; safe to leave permanently.
 */
export function healHistoryReasoning(ctx: ReplContext): void {
  // Previously injected `reasoning_content = ''` whenever the field was
  // missing. That triggered DeepSeek-flash to enter reasoning mode on the
  // next turn (the field's mere presence is interpreted as "this
  // conversation supports reasoning, please use it"). Now: leave the field
  // truly absent when there's no actual reasoning. If a downstream
  // provider 400s asking for the field, the recovery in
  // streaming-error-recovery.ts injects it on retry.
  for (const m of ctx.messages || []) {
    if (m && (m as any).role === 'assistant') {
      const rc = (m as any).reasoning_content;
      // Drop empty strings that older code paths may have left behind.
      if (rc === '') delete (m as any).reasoning_content;
    }
  }
}

/**
 * Preserve reasoning_content + thinking_signature + tool_calls when
 * round-tripping the history. Only forwards reasoning_content when it
 * actually has content — sending empty `''` was triggering DeepSeek-flash
 * to enter reasoning mode unnecessarily.
 */
export function buildChatMessagesFromHistory(messages: any[]): any[] {
  return messages.map((m: any) => {
    const out: any = { role: m.role, content: m.content };
    if (m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) {
      out.reasoning_content = m.reasoning_content;
    }
    if (m.thinking_signature) out.thinking_signature = m.thinking_signature;
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}
