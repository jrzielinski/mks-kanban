import { useRef, useCallback, useState } from 'react';
import {
  createVimState,
  handleVimKey,
  type VimState,
} from '@agent/tui/vim';

const VIM_PREF_KEY = 'makestudio:settings:vimMode';

export function loadVimEnabled(): boolean {
  try {
    return localStorage.getItem(VIM_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export function setVimEnabled(v: boolean): void {
  try {
    localStorage.setItem(VIM_PREF_KEY, v ? '1' : '0');
  } catch {
    /* quota */
  }
}

/**
 * Vim mode hook pro InputBox. Wrappea o state-machine puro do agent
 * (`src/repl/tui/vim.ts`) e mapeia pra `textarea.selectionStart/End`.
 *
 * Retorna:
 *   - mode: 'INSERT' | 'NORMAL'
 *   - handleKey: chamador em onKeyDown — retorna true se o key foi
 *     consumido pelo vim e o caller deve `preventDefault`.
 *   - onSubmitFromNormal: callback quando usuário aperta Enter em NORMAL
 *     (o state machine trata isso como submit).
 */
export function useVim(params: {
  enabled: boolean;
  taRef: React.RefObject<HTMLTextAreaElement>;
  onChangeValue: (next: string) => void;
  onSubmit: (value: string) => void;
}): {
  mode: 'INSERT' | 'NORMAL';
  handleKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  resetToInsert: () => void;
} {
  const { enabled, taRef, onChangeValue, onSubmit } = params;
  const stateRef = useRef<VimState>(createVimState());
  const [mode, setMode] = useState<'INSERT' | 'NORMAL'>('INSERT');

  const applyResult = useCallback(
    (next: { value: string; cursor: number; state: VimState; submit?: string }) => {
      stateRef.current = next.state;
      setMode(next.state.mode);
      if (next.submit !== undefined) {
        onSubmit(next.submit);
        return;
      }
      onChangeValue(next.value);
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.selectionStart = next.cursor;
        el.selectionEnd = next.cursor;
      });
    },
    [onChangeValue, onSubmit, taRef],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!enabled) return false;
      const el = taRef.current;
      if (!el) return false;
      const value = el.value;
      const cursor = el.selectionStart ?? 0;

      const input = e.key.length === 1 ? e.key : '';
      const key = {
        escape: e.key === 'Escape',
        return: e.key === 'Enter' && !e.shiftKey && !e.ctrlKey,
        backspace: e.key === 'Backspace',
        delete: e.key === 'Delete',
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
        upArrow: e.key === 'ArrowUp',
        downArrow: e.key === 'ArrowDown',
        leftArrow: e.key === 'ArrowLeft',
        rightArrow: e.key === 'ArrowRight',
        tab: e.key === 'Tab',
      };

      const result = handleVimKey({ value, cursor, state: stateRef.current }, input, key);
      if (!result.handled) return false;

      applyResult(result);
      return true;
    },
    [enabled, taRef, applyResult],
  );

  const resetToInsert = useCallback(() => {
    stateRef.current = { ...stateRef.current, mode: 'INSERT', pendingOperator: null, pendingReplace: false };
    setMode('INSERT');
  }, []);

  return { mode, handleKey, resetToInsert };
}
