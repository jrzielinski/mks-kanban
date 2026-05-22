import React, { useEffect } from 'react';
import { ChatPage } from '../pages/ChatPage';
import { LoginPage } from '../pages/LoginPage';
import { useAgentStream } from '../hooks/useAgentStream';
import { useAuth } from '../hooks/useAuth';
import { useThemeStore } from '../store';
import { InlinePermission } from './InlinePermission';
import { BusyIndicator } from './BusyIndicator';
import { EmbedHeader } from './EmbedHeader';
import { PickerModal } from '../overlays/PickerModal';
import { QuestionBanner } from '../overlays/QuestionBanner';
import { Toasts } from '../overlays/Toasts';

/**
 * Minimal layout for the VSCode webview embed — only what makes sense in the
 * narrow sidebar: ChatPage + modal/banner overlays the kernel needs to
 * function (permission prompts, picker, AskUserQuestion, toasts).
 *
 * Excluded vs the desktop App.tsx:
 *   - TitleBar (VSCode owns the chrome)
 *   - Sidebar with all 30+ page nav (doesn't fit in a sidebar webview)
 *   - StatusBar / ProfileBar footer
 *   - Routes for non-chat pages (Memory/Hooks/MCP/etc.)
 *   - CommandPalette, OnboardingWizard, easter eggs
 *
 * The chat is the whole UX in the embed. Other pages still exist in the
 * desktop app — they'll come back as separate VSCode commands or webview
 * panels in Phase 7 if needed.
 */
export function EmbedShell(): React.ReactElement {
  useAgentStream();
  const hydrateTheme = useThemeStore((s) => s.hydrate);
  useEffect(() => {
    hydrateTheme();
  }, [hydrateTheme]);

  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-0 text-dim-soft">
        <span className="animate-pulse text-[12.5px]">carregando…</span>
      </div>
    );
  }

  if (!auth.data?.authenticated) {
    return (
      <div className="h-full w-full bg-surface-0">
        <LoginPage />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-0">
      <EmbedHeader />
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatPage />
      </div>
      {/* Busy indicator + permission card both portal into the message
          scroll so they read like inline chat content (Claude Code style). */}
      <BusyIndicator />
      <InlinePermission />
      <PickerModal />
      <QuestionBanner />
      <Toasts />
    </div>
  );
}
