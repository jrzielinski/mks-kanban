import { isAtBlockingLimit, handleAIChatStream, handleAIChat, compactNow } from "./chat";

// ── Module-level shared refs ─────────────────────────────────────
// `var` to avoid TDZ with jest.mock() hoisting by ts-jest.
const b = { addMessage: jest.fn().mockReturnValue("m1"), updateMessage: jest.fn(), setMode: jest.fn(), setStatus: jest.fn() };
const gtb = jest.fn(() => b);
var mockConsumeProviderStream: jest.Mock;
var mockNormalizeUsage: jest.Mock;
var mockParseSendMessageResponse: jest.Mock;

jest.mock("./providers", () => { const p = { available: true, name: "claude", sendMessage: jest.fn(), streamMessage: jest.fn() }; return { getProvider: jest.fn(() => p), isProviderAvailable: jest.fn(() => true) }; });
jest.mock("../tui/bridge", () => ({ addMessage: jest.fn(), setTransientStatus: jest.fn(), setMode: jest.fn(), setStatus: jest.fn(), getTuiBridge: (...a: any[]) => gtb(...a) }));
jest.mock("./chat-prelude", () => ({ runChatPreflight: jest.fn(() => ({ provider: require("./providers").getProvider() })), buildSystemPromptWithMemory: jest.fn(() => Promise.resolve({ systemPrompt: "sp", systemStatic: "st", systemDynamic: "dy" })), assembleEnrichedTools: jest.fn(() => Promise.resolve([])), extractTextAttachments: jest.fn((s: any) => s), captureImageAttachments: jest.fn(() => ({ input: "in", pendingImageBlocks: [] })), persistUserMessage: jest.fn(), resetTurnRetryFlags: jest.fn(), resetPerTurnState: jest.fn(), runAwaySummaryIfNeeded: jest.fn(() => Promise.resolve()), maybeShowClearHint: jest.fn(), installTurnAlertTimer: jest.fn(), healHistoryReasoning: jest.fn(), buildChatMessagesFromHistory: jest.fn((a: any) => a), runUserPromptSubmitHook: jest.fn(() => Promise.resolve()), runEagerMicroCompactPass: jest.fn(), buildSystemPrompt: jest.fn(() => "sp") }));
jest.mock("./token-estimation", () => ({ isAtBlockingLimit: jest.fn(() => false), checkTokenWarning: jest.fn(), estimateContextPct: jest.fn(() => 50) }));
jest.mock("./sanitize-messages", () => ({ sanitizeMessagesForLLM: jest.fn((a: any) => a) }));
jest.mock("./chat-utils", () => ({ compactMessages: jest.fn((a: any) => a) }));
jest.mock("./auto-compact", () => ({ autoCompact: jest.fn(() => Promise.resolve(false)) }));
jest.mock("./history-sanitization", () => ({ sanitizeHistoryForLLM: jest.fn((a: any) => a), appendAtReferenceHint: jest.fn(), reduceHistoryForToolLoop: jest.fn((a: any) => a) }));
jest.mock("./image-pipeline", () => ({ routeImageBlocks: jest.fn(() => Promise.resolve({ effectiveInput: "in", effectiveImageBlocks: [] })), prepareImagesForTurn: jest.fn(() => Promise.resolve({ effectiveInput: "in", effectiveImageBlocks: [], visionStripped: false })) }));
jest.mock("./tool-dispatch-cli", () => ({ dispatchCliTool: jest.fn() }));
jest.mock("./post-turn", () => ({ runStreamingPostTurn: jest.fn(() => Promise.resolve()) }));
jest.mock("./streaming-guards", () => ({ runStreamingGuards: jest.fn(() => Promise.resolve(false)) }));
jest.mock("./audit-mode", () => ({ applyAuditMode: jest.fn((_: any, e: any) => e) }));
jest.mock("../sessions", () => ({ appendMessage: jest.fn() }));
jest.mock("./chat-guards", () => ({ runAntiFabricationGuards: jest.fn(() => Promise.resolve(false)) }));
jest.mock("./agent-summary", () => ({ startAgentSummarization: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock("../../utils/events", () => ({ recordEvent: jest.fn() }));
jest.mock("./streaming-iteration", () => ({ consumeProviderStream: (...a: any[]) => (mockConsumeProviderStream as Function)(...a), handleStreamException: jest.fn(), surfacePreambleNarration: jest.fn(), recordLlmRequestStart: jest.fn(() => 1), recordLlmRequestEnd: jest.fn(), persistFinalAssistantMessage: jest.fn(), surfaceEmptyTurnNoTextResponse: jest.fn(), logStreamResponseSummary: jest.fn() }));
jest.mock("./streaming-response", () => ({ normalizeUsage: (...a: any[]) => (mockNormalizeUsage as Function)(...a), handleMaxTokensTruncation: jest.fn(() => false) }));
jest.mock("../markdown", () => ({ renderMarkdown: jest.fn((s: string) => s), looksLikeMarkdown: jest.fn(() => false) }));
jest.mock("./non-streaming-iteration", () => ({ parseSendMessageResponse: (...a: any[]) => (mockParseSendMessageResponse as Function)(...a), healReasoningContentForRetry: jest.fn(() => null), runCliPostTurn: jest.fn() }));

function m(o = {}) {
  return { provider: "claude", messages: [{ role: "user", content: "hi" }], lastUserMessage: "", isAuthenticated: () => true, addUsage: jest.fn(), recordApiMs: jest.fn(), detectCacheBreak: jest.fn(() => null), buildSystemPrompt: () => "sp", currentAbortController: null, previousAbortController: null, providerInfo: { model: "m" }, cwd: "/t", readCache: { clear: jest.fn() }, usage: { totalTokens: 0, cacheMisses: 0 }, ...o };
}

beforeAll(() => {
  mockConsumeProviderStream = jest.fn(() => Promise.resolve({ recoverAndRetry: false, fatal: false }));
  mockNormalizeUsage = jest.fn((u: any) => u);
  mockParseSendMessageResponse = jest.fn((r: any) => { const tb: string[] = []; const tu: any[] = []; let tt = "", ts = ""; for (const b of (r?.content || [])) { if (b.type === "thinking") { if (b.thinking) tt += b.thinking; if (b.signature) ts = b.signature; } else if (b.type === "text" && b.text) tb.push(b.text); else if (b.type === "tool_use") tu.push({ id: b.id, name: b.name, input: b.input }); } return { textBlocks: tb, toolUseBlocks: tu, thinkingText: tt, thinkingSignature: ts }; });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockParseSendMessageResponse.mockReset();
  mockParseSendMessageResponse.mockImplementation((r: any) => {
    const tb: string[] = []; const tu: any[] = []; let tt = "", ts = "";
    for (const b of (r?.content || [])) {
      if (b.type === "thinking") { if (b.thinking) tt += b.thinking; if (b.signature) ts = b.signature; }
      else if (b.type === "text" && b.text) tb.push(b.text);
      else if (b.type === "tool_use") tu.push({ id: b.id, name: b.name, input: b.input });
    }
    return { textBlocks: tb, toolUseBlocks: tu, thinkingText: tt, thinkingSignature: ts };
  });
  mockConsumeProviderStream.mockImplementation(({ state }: any) => {
    state.accumulatedText = state.accumulatedText || "response";
    state.toolUses = state.toolUses || [];
    state.lastUsage = state.lastUsage || { promptTokens: 5, completionTokens: 5 };
    return Promise.resolve({ fatal: false, recoverAndRetry: false });
  });
  mockNormalizeUsage.mockImplementation((u: any) => u);
  const p = { available: true, name: "claude", sendMessage: jest.fn(), streamMessage: jest.fn() };
  require("./providers").getProvider.mockReturnValue(p);
  p.sendMessage.mockResolvedValue({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { promptTokens: 5, completionTokens: 5 } });
  p.streamMessage.mockReturnValue((async function*() { yield { type: "end" }; })());
  gtb.mockReturnValue(b);
  b.addMessage.mockReturnValue("m1");
  b.updateMessage.mockImplementation(() => {});
});

describe("chat", () => {
  it("exports", () => { expect(typeof isAtBlockingLimit).toBe("function"); expect(typeof handleAIChatStream).toBe("function"); expect(typeof handleAIChat).toBe("function"); expect(typeof compactNow).toBe("function"); });

  describe("AIChatStream", () => {
    it("no TUI", async () => { gtb.mockReturnValue(null); await expect(handleAIChatStream("hello", m())).resolves.toBeUndefined(); });
    it("basic turn", async () => { await expect(handleAIChatStream("hello", m())).resolves.toBeUndefined(); expect(require("./chat-prelude").runChatPreflight).toHaveBeenCalled(); });
    it("blocking limit", async () => { require("./token-estimation").isAtBlockingLimit.mockReturnValueOnce(true); await handleAIChatStream("hello", m()); expect(require("./streaming-iteration").recordLlmRequestStart).not.toHaveBeenCalled(); });
    it("audit mode", async () => { await handleAIChatStream("hello", m()); expect(require("./audit-mode").applyAuditMode).toHaveBeenCalled(); });
    it("checkToken", async () => { await handleAIChatStream("hello", m()); expect(require("./token-estimation").checkTokenWarning).toHaveBeenCalled(); });
    it("sanitizeLLM", async () => { await handleAIChatStream("hello", m({ __skipReasoningRoundTrip: true })); expect(require("./sanitize-messages").sanitizeMessagesForLLM).toHaveBeenCalled(); });
    it("sanitizeHistory", async () => { await handleAIChatStream("hello", m()); expect(require("./history-sanitization").sanitizeHistoryForLLM).toHaveBeenCalled(); });
    it("surfaceEmpty", async () => { mockConsumeProviderStream.mockImplementationOnce(({ state }: any) => { state.accumulatedText = ""; state.toolUses = []; state.lastUsage = null; return Promise.resolve({ fatal: false, recoverAndRetry: false }); }); await handleAIChatStream("hello", m()); expect(require("./streaming-iteration").surfaceEmptyTurnNoTextResponse).toHaveBeenCalled(); });
    it("persistFinal", async () => { await handleAIChatStream("hello", m()); expect(require("./streaming-iteration").persistFinalAssistantMessage).toHaveBeenCalled(); });
    it("exit fatal", async () => { mockConsumeProviderStream.mockResolvedValueOnce({ fatal: true, recoverAndRetry: false }); await handleAIChatStream("hello", m()); expect(require("./streaming-iteration").persistFinalAssistantMessage).not.toHaveBeenCalled(); expect(require("./streaming-iteration").logStreamResponseSummary).not.toHaveBeenCalled(); });
    it("recover & retry", async () => { let c = 0; mockConsumeProviderStream.mockImplementation(({ state }: any) => { c++; state.toolUses = c <= 2 ? [{ id: "t1", name: "r", input: {} }] : []; state.accumulatedText = c <= 2 ? "" : "done"; state.lastUsage = { promptTokens: 5 }; return Promise.resolve(c <= 2 ? { fatal: false, recoverAndRetry: true } : { fatal: false, recoverAndRetry: false }); }); await handleAIChatStream("hello", m({ __headlessMaxTurns: 4 })); expect(mockNormalizeUsage).toHaveBeenCalled(); });
    it("error caught", async () => { mockConsumeProviderStream.mockRejectedValue(new Error("x")); await handleAIChatStream("hello", m()); expect(require("./streaming-iteration").handleStreamException).toHaveBeenCalled(); });
  });

  describe("AIChat", () => {
    beforeEach(() => { const p = require("./providers").getProvider(); p.streamMessage = undefined as any; });
    afterEach(() => { const p = require("./providers").getProvider(); p.streamMessage = jest.fn(); });
    it("basic", async () => { await expect(handleAIChat("hello", m())).resolves.toBeUndefined(); expect(require("./chat-prelude").runChatPreflight).toHaveBeenCalled(); });
    it("no provider", async () => { require("./chat-prelude").runChatPreflight.mockReturnValueOnce({ provider: null }); await handleAIChat("hello", m()); });
    it("image pipeline", async () => { await handleAIChat("hello", m()); expect(require("./image-pipeline").prepareImagesForTurn).toHaveBeenCalled(); });
    it("skill text", async () => { const ctx = m({ __skillDisplayText: "[skill]" }); await handleAIChat("hello", ctx); expect(ctx.messages.find((u: any) => u.displayText)?.displayText).toBe("[skill]"); expect(ctx.__skillDisplayText).toBeUndefined(); });
    it("appendMessage", async () => { await handleAIChat("hello", m()); expect(require("../sessions").appendMessage).toHaveBeenCalled(); });
    it("appendRef", async () => { await handleAIChat("hello", m()); expect(require("./history-sanitization").appendAtReferenceHint).toHaveBeenCalled(); });
    it("cache break", async () => { const ctx = m({ detectCacheBreak: jest.fn(() => "new") }); await handleAIChat("hello", ctx); expect(ctx.detectCacheBreak).toHaveBeenCalled(); });
    it("headless", async () => { process.env.MAKESTUDIO_HEADLESS = "1"; await handleAIChat("hello", m()); delete process.env.MAKESTUDIO_HEADLESS; });
    it("blocking warning", async () => { require("./token-estimation").isAtBlockingLimit.mockReturnValueOnce(true); await handleAIChat("hello", m()); expect(require("../../utils/events").recordEvent).toHaveBeenCalled(); });
    it("cache miss", async () => { const ctx = m({ detectCacheBreak: jest.fn(() => "model_changed") }); ctx.usage.cacheMisses = 0; await handleAIChat("hello", ctx); expect(ctx.usage.cacheMisses).toBe(1); });
    it("thinking accum", async () => { mockParseSendMessageResponse.mockReturnValueOnce({ textBlocks: ["a1"], toolUseBlocks: [{ id: "t1", name: "r", input: {} }], thinkingText: "r1", thinkingSignature: "s1" }); mockParseSendMessageResponse.mockReturnValueOnce({ textBlocks: ["a2"], toolUseBlocks: [], thinkingText: "r2", thinkingSignature: "s2" }); const s = jest.spyOn(console, "log").mockImplementation(() => {}); await handleAIChat("hello", m()); expect(mockParseSendMessageResponse).toHaveBeenCalled(); expect(require("./tool-dispatch-cli").dispatchCliTool).toHaveBeenCalled(); expect(require("./non-streaming-iteration").runCliPostTurn).toHaveBeenCalled(); expect(s).toHaveBeenCalled(); s.mockRestore(); });
    it("generic error", async () => { require("./providers").getProvider().sendMessage.mockRejectedValue(new Error("err")); const s = jest.spyOn(console, "log").mockImplementation(() => {}); await handleAIChat("hello", m()); expect(s).toHaveBeenCalled(); s.mockRestore(); });
    it("skill display", async () => { const ctx = m(); ctx.__skillDisplayText = "Skill: t"; await handleAIChat("hello", ctx); expect(ctx.messages.filter((u: any) => u.role === "user").pop()?.displayText).toBe("Skill: t"); });
    it("checkToken nonstream", async () => { await handleAIChat("hello", m()); expect(require("./token-estimation").checkTokenWarning).toHaveBeenCalled(); });
    it("sanitizeLLM nonstream", async () => { await handleAIChat("hello", m({ __skipReasoningRoundTrip: true })); expect(require("./sanitize-messages").sanitizeMessagesForLLM).toHaveBeenCalled(); });
    it("autoCompact print", async () => { require("./auto-compact").autoCompact.mockResolvedValueOnce(true); const s = jest.spyOn(console, "log").mockImplementation(() => {}); await handleAIChat("hello", m()); expect(s).toHaveBeenCalled(); s.mockRestore(); });
    it("tools dispatch", async () => { mockParseSendMessageResponse.mockReturnValueOnce({ textBlocks: ["step"], toolUseBlocks: [{ id: "t1", name: "read", input: {} }], thinkingText: "", thinkingSignature: "" }); mockParseSendMessageResponse.mockReturnValueOnce({ textBlocks: ["done"], toolUseBlocks: [], thinkingText: "", thinkingSignature: "" }); const s = jest.spyOn(console, "log").mockImplementation(() => {}); await handleAIChat("hello", m()); expect(require("./tool-dispatch-cli").dispatchCliTool).toHaveBeenCalled(); s.mockRestore(); });
  });

  describe("compactNow", () => {
    it("quick", async () => { const r = await compactNow({ messages: [{ role: "user", content: "a" }], buildSystemPrompt: () => "t" } as any); expect(r.compacted).toBe(false); expect(r.before).toBe(1); });
    it("autoCompact", async () => { require("./auto-compact").autoCompact.mockResolvedValueOnce(true); const msgs = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m-${i}` })); const r = await compactNow({ messages: msgs, buildSystemPrompt: () => "t" } as any); expect(r.compacted).toBe(true); });
  });
});
