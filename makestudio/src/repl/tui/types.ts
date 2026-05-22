import { ReplContext } from '../context';

export interface TuiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'info' | 'error';
  text: string;
  timestamp: number;
  streaming?: boolean;
  /**
   * When true, `text` is already an ANSI-rendered string (markdown already
   * lexed/formatted during hydration). MessageItem should emit `<Text>` raw
   * instead of running `<Markdown>` again — the <Static> path into scrollback
   * doesn't play well with the Markdown component's Box layout, which is why
   * resumed sessions show "## heading" and `**bold**` as literal text.
   */
  preRendered?: boolean;
  toolName?: string;
  toolInput?: any;
  toolOutput?: string;
  toolDurationMs?: number;
  /** Epoch ms when this tool call started — used to compute elapsed in live Bash card. */
  startedAt?: number;
  /** Rolling last-N lines of stdout while a Bash tool is streaming. */
  liveLines?: string[];
  /** Total lines seen so far (including those not in liveLines). */
  totalLiveLines?: number;
}

export interface TuiState {
  messages: TuiMessage[];
  busy: boolean;
  busyLabel: string;
  ctx: ReplContext;
  contextPct: number;
  scrollOffset: number;
  completions: string[];
  refreshTrigger: number;
}

export type AddMessage = (m: Omit<TuiMessage, 'id' | 'timestamp'>) => string;
export type UpdateMessage = (id: string, patch: Partial<TuiMessage>) => void;
export type SetBusy = (busy: boolean, label?: string) => void;
