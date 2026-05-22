import { create } from 'zustand';
import type { TuiMessageDTO } from '@shared/types';

export interface ChatState {
  messages: TuiMessageDTO[];
  busy: boolean;
  busyLabel: string;
  busyStartedAt: number | null;
  streamTokens: number;
  currentTool: string | null;
  lastTool: string | null;
  agentSummary: string | null;
  contextPct: number;
  model: string | null;
  totalTokens: number;
  msgsCount: number;

  // VS Code embed only — file the user is currently focused on in the
  // editor. Pinned as a chip above the input, and prepended to the
  // outgoing prompt so the LLM knows what the user is staring at.
  activeFile: { path: string; fileName: string; languageId?: string } | null;

  // Ações locais (aplicadas pelos eventos de push)
  addMessage: (m: TuiMessageDTO) => void;
  updateMessage: (id: string, patch: Partial<TuiMessageDTO>) => void;
  clearMessages: () => void;
  setBusy: (busy: boolean, label: string) => void;
  setStreamTokens: (n: number) => void;
  setCurrentTool: (info: { current: string | null; last: string | null }) => void;
  setAgentSummary: (s: string | null) => void;
  setContextPct: (n: number) => void;
  setActiveFile: (
    f: { path: string; fileName: string; languageId?: string } | null,
  ) => void;
  hydrate: (snapshot: Partial<ChatState>) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  busy: false,
  busyLabel: '',
  busyStartedAt: null,
  streamTokens: 0,
  currentTool: null,
  lastTool: null,
  agentSummary: null,
  contextPct: 0,
  model: null,
  totalTokens: 0,
  msgsCount: 0,
  activeFile: null,

  addMessage: (m) =>
    set((s) => ({
      messages: [...s.messages, m],
      msgsCount: s.msgsCount + 1,
    })),

  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),

  clearMessages: () => set({ messages: [], msgsCount: 0 }),

  setBusy: (busy, label) =>
    set(() => ({
      busy,
      busyLabel: label,
      busyStartedAt: busy ? Date.now() : null,
      streamTokens: busy ? 0 : 0,
    })),

  setStreamTokens: (n) => set({ streamTokens: n }),

  setCurrentTool: ({ current, last }) =>
    set({ currentTool: current, lastTool: last }),

  setAgentSummary: (agentSummary) => set({ agentSummary }),

  setContextPct: (contextPct) => set({ contextPct }),

  setActiveFile: (activeFile) => set({ activeFile }),

  hydrate: (snapshot) => set((s) => ({ ...s, ...snapshot })),
}));
