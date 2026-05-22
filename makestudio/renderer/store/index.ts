/**
 * Zustand store root. Slices individuais estão em ./slices/*.
 * Fase 1a: chat slice completo. Fases subsequentes plugam mais slices
 * (prompts, toasts, sessions, permissions, usage…).
 */

export { useChatStore } from './slices/chat';
export type { ChatState } from './slices/chat';

export { useThemeStore, THEMES } from './slices/theme';
export type { ThemeName, ThemeMeta } from './slices/theme';
