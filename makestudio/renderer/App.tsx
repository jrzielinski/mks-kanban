import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AppLayout } from './components/layout/AppLayout';
import { useAgentStream } from './hooks/useAgentStream';
import { useAuth } from './hooks/useAuth';
import { useThemeStore } from './store';
import * as CH from '@shared/channels';
import { CommandPalette, useCommandPalette, useNavigateFromMain } from './overlays/CommandPalette';
import { OnboardingWizard, useOnboardingCompleted } from './overlays/OnboardingWizard';
import { DoomEasterEgg } from './overlays/DoomEasterEgg';
import { Order66EasterEgg } from './overlays/Order66EasterEgg';
import { useKonamiCode } from './hooks/useKonamiCode';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { SessionsPage } from './pages/SessionsPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { RewindPage } from './pages/RewindPage';
import { FileHistoryPage } from './pages/FileHistoryPage';
import { CassettesPage } from './pages/CassettesPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { KanbanPage } from './pages/KanbanPage';
import { DumDetailPage } from './pages/DumDetailPage';
import { WorktreePage } from './pages/WorktreePage';
import { MemoryPage } from './pages/MemoryPage';
import { SkillsPage } from './pages/SkillsPage';
import { CustomAgentsPage } from './pages/CustomAgentsPage';
import { PluginsPage } from './pages/PluginsPage';
import { BoilerplatesPage } from './pages/BoilerplatesPage';
import { SchedulePage } from './pages/SchedulePage';
import { HooksPage } from './pages/HooksPage';
import { HeadlessRunnerPage } from './pages/HeadlessRunnerPage';
import { SecurityReviewPage } from './pages/SecurityReviewPage';
import { McpPage } from './pages/McpPage';
import { ClusterPage } from './pages/ClusterPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { AccountPage } from './pages/AccountPage';
import { GitPage } from './pages/GitPage';
import { AppearanceSettingsPage } from './pages/settings/AppearanceSettingsPage';
import { KeybindingsSettingsPage } from './pages/settings/KeybindingsSettingsPage';
import { StatusLineSettingsPage } from './pages/settings/StatusLineSettingsPage';
import { InputSettingsPage } from './pages/settings/InputSettingsPage';
import { PermissionsSettingsPage } from './pages/settings/PermissionsSettingsPage';
import { SecuritySettingsPage } from './pages/settings/SecuritySettingsPage';
import { FlagsSettingsPage } from './pages/settings/FlagsSettingsPage';
import { UsagePage } from './pages/UsagePage';
import { DoctorPage } from './pages/DoctorPage';
import { DebugLogsPage } from './pages/DebugLogsPage';
import { TipsPage } from './pages/TipsPage';
import { FeedbackPage } from './pages/FeedbackPage';

function AppInner(): React.ReactElement {
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const [onboardingDone, completeOnboarding] = useOnboardingCompleted();
  const [doomOpen, setDoomOpen] = React.useState(false);
  const [order66Open, setOrder66Open] = React.useState(false);
  useKonamiCode(() => setDoomOpen(true));

  // Hidden /order66 slash command — InputBox dispatches this event when
  // the command is typed, swallowing it before it reaches the agent.
  // Flips the global theme to "starwars" via the same store the
  // AppearanceSettingsPage uses (persists to localStorage, drives data-theme
  // attr + Star Jedi font swap).
  const setTheme = useThemeStore((s) => s.setTheme);
  useEffect(() => {
    const onOrder66 = (): void => {
      setTheme('starwars');
      setOrder66Open(true);
    };
    window.addEventListener('makestudio:order66', onOrder66);
    return () => window.removeEventListener('makestudio:order66', onOrder66);
  }, [setTheme]);

  // Wire navigate events from main-process tray menu
  useNavigateFromMain();

  // Global keyboard shortcut Ctrl/Cmd+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    const onOpen = (): void => setPaletteOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('makestudio:openPalette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('makestudio:openPalette', onOpen);
    };
  }, [paletteOpen, setPaletteOpen]);

  return (
    <>
      {!onboardingDone && <OnboardingWizard onComplete={completeOnboarding} />}
      {paletteOpen && <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />}
      <DoomEasterEgg open={doomOpen} onClose={() => setDoomOpen(false)} />
      <Order66EasterEgg open={order66Open} onClose={() => setOrder66Open(false)} />
    </>
  );
}

function applyUiScale(scale: number): void {
  document.documentElement.style.setProperty('--ui-scale', String(scale));
}

function useZoomSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    // Apply persisted zoom on first load.
    qc.fetchQuery({
      queryKey: ['settings'],
      queryFn: () => window.makestudio.agent.invoke<void, { uiScale?: number }>('settings:get'),
    }).then((s) => {
      if (s?.uiScale != null) applyUiScale(s.uiScale);
    }).catch(() => {});

    // Sync when main pushes changes (Ctrl+0/+/- menu shortcuts).
    const unsub = window.makestudio.events.on<{ uiScale?: number }>(
      CH.EVT_SETTINGS_CHANGED,
      (dto) => {
        if (dto?.uiScale != null) {
          applyUiScale(dto.uiScale);
          qc.invalidateQueries({ queryKey: ['settings'] });
        }
      },
    );
    return unsub;
  }, [qc]);
}

export function App(): React.ReactElement {
  useAgentStream();
  useZoomSync();
  const hydrateTheme = useThemeStore((s) => s.hydrate);
  useEffect(() => {
    hydrateTheme();
  }, [hydrateTheme]);

  // Gate de auth — antes do layout. Mostra LoginPage full-screen se
  // não autenticado. `isLoading` esconde flash de login durante a
  // primeira chamada de status.
  const auth = useAuth();
  if (auth.isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-0 text-dim-soft">
        <span className="animate-pulse text-[12.5px]">carregando…</span>
      </div>
    );
  }
  if (!auth.data?.authenticated) {
    return <LoginPage />;
  }

  return (
    <AppLayout>
      <Routes>
        {/* Chat — home */}
        <Route path="/" element={<ChatPage />} />

        {/* Sessions & History */}
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/history/rewind" element={<RewindPage />} />
        <Route path="/history/files" element={<FileHistoryPage />} />
        <Route path="/history/cassettes" element={<CassettesPage />} />

        {/* Projects */}
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/kanban" element={<KanbanPage />} />
        <Route path="/projects/:id/dum/:dumId" element={<DumDetailPage />} />
        <Route path="/projects/:id/worktrees" element={<WorktreePage />} />

        {/* Memory */}
        <Route path="/memory" element={<MemoryPage />} />

        {/* Agents & Skills */}
        <Route path="/agents/skills" element={<SkillsPage />} />
        <Route path="/agents/custom" element={<CustomAgentsPage />} />
        <Route path="/agents/plugins" element={<PluginsPage />} />
        <Route path="/agents/boilerplates" element={<BoilerplatesPage />} />

        {/* Automation */}
        <Route path="/automation/schedule" element={<SchedulePage />} />
        <Route path="/automation/hooks" element={<HooksPage />} />
        <Route path="/automation/headless" element={<HeadlessRunnerPage />} />
        <Route path="/automation/security-review" element={<SecurityReviewPage />} />

        {/* Integrations */}
        <Route path="/integrations/mcp" element={<McpPage />} />
        <Route path="/integrations/cluster" element={<ClusterPage />} />
        <Route path="/integrations/providers" element={<ProvidersPage />} />
        <Route path="/integrations/auth" element={<AccountPage />} />
        <Route path="/integrations/git" element={<GitPage />} />

        {/* Settings */}
        <Route path="/settings" element={<Navigate to="/settings/appearance" replace />} />
        <Route path="/settings/appearance" element={<AppearanceSettingsPage />} />
        <Route path="/settings/keybindings" element={<KeybindingsSettingsPage />} />
        <Route path="/settings/statusline" element={<StatusLineSettingsPage />} />
        <Route path="/settings/input" element={<InputSettingsPage />} />
        <Route path="/settings/permissions" element={<PermissionsSettingsPage />} />
        <Route path="/settings/security" element={<SecuritySettingsPage />} />
        <Route path="/settings/flags" element={<FlagsSettingsPage />} />

        {/* Monitor */}
        <Route path="/monitor/usage" element={<UsagePage />} />
        <Route path="/monitor/health" element={<DoctorPage />} />
        <Route path="/monitor/debug" element={<DebugLogsPage />} />
        <Route path="/monitor/tips" element={<TipsPage />} />
        <Route path="/monitor/feedback" element={<FeedbackPage />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <AppInner />
    </AppLayout>
  );
}
