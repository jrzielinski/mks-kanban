import React from 'react';
import { createPortal } from 'react-dom';
import { subscribe, resolveRpc } from '../ipc/client';
import * as CH from '@shared/channels';
import type { PermissionRequest, PermissionChoice } from '@shared/types';

/**
 * Permission UI for the VSCode embed, modeled on the Claude Code CLI
 * prompt: monospace, numbered list, arrow-keys to navigate, Enter to
 * confirm, Esc to deny. Renders inline in the chat scroll (after the
 * last message) via React portal.
 *
 * Mapping to PermissionChoice:
 *   1. Sim                                  → 'allow'
 *   2. Sim, e aceitar nesta sessão          → 'allow-session'
 *   3. Sim, e criar regra permanente        → 'allow-rule'
 *   4. Não                                  → 'deny'
 */

const OPTIONS: Array<{
  label: (toolName: string) => string;
  choice: PermissionChoice;
  hint: string;
}> = [
  {
    label: () => 'Sim',
    choice: 'allow',
    hint: 'apenas esta vez',
  },
  {
    label: (t) => `Sim, e aceitar ${t} nesta sessão`,
    choice: 'allow-session',
    hint: 'sem perguntar de novo até reiniciar',
  },
  {
    label: (t) => `Sim, e sempre permitir ${t}`,
    choice: 'allow-rule',
    hint: 'cria regra permanente em ~/.makestudio',
  },
  {
    label: () => 'Não',
    choice: 'deny',
    hint: 'cancela esta chamada',
  },
];

export function InlinePermission(): React.ReactElement | null {
  const [request, setRequest] = React.useState<PermissionRequest | null>(null);
  const [selected, setSelected] = React.useState(0);

  const portalTarget = React.useMemo<Element | null>(() => {
    if (!request) return null;
    if (typeof document === 'undefined') return null;
    return document.querySelector('[data-message-list-content]');
  }, [request]);

  React.useEffect(() => {
    const offOpen = subscribe<PermissionRequest>(CH.EVT_PERMISSION_REQUEST, (req) => {
      setRequest(req);
      setSelected(0);
    });
    const offClose = subscribe<void>(CH.EVT_PERMISSION_CLOSE, () => setRequest(null));
    return () => {
      offOpen();
      offClose();
    };
  }, []);

  const resolve = React.useCallback(
    (choice: PermissionChoice) => {
      resolveRpc(CH.AGENT_PERMISSION_RESOLVE, choice);
      setRequest(null);
    },
    [],
  );

  React.useEffect(() => {
    if (!request || !portalTarget) return;
    requestAnimationFrame(() => {
      const scroll = portalTarget.parentElement;
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
  }, [request, portalTarget]);

  React.useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => (s + 1) % OPTIONS.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => (s - 1 + OPTIONS.length) % OPTIONS.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolve(OPTIONS[selected].choice);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        resolve('deny');
      } else if (/^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        resolve(OPTIONS[idx].choice);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, selected, resolve]);

  if (!request) return null;

  const card = (
    <div className="my-3 overflow-hidden rounded-md border border-border-subtle bg-surface-1 font-mono text-[12.5px]">
      <header className="border-b border-border-subtle/60 px-3 py-1.5">
        <span className="font-semibold text-text">{toolHeader(request.toolName)}</span>
      </header>

      <div className="space-y-1 px-3 py-2">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-text">
          {commandText(request)}
        </pre>
        {request.reason && (
          <div className="text-[11.5px] text-dim-soft">{request.reason}</div>
        )}
        {request.warning && (
          <div className="text-[11.5px] text-warning">⚠ {request.warning}</div>
        )}
      </div>

      <div className="border-t border-border-subtle/60 px-3 py-2">
        <div className="mb-1 font-semibold text-text">Deseja prosseguir?</div>
        <ul className="space-y-0.5">
          {OPTIONS.map((opt, i) => {
            const isSel = i === selected;
            return (
              <li
                key={opt.choice}
                onMouseEnter={() => setSelected(i)}
                onClick={() => resolve(opt.choice)}
                className={
                  'flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 ' +
                  (isSel ? 'bg-primary/10 text-text' : 'text-text-soft hover:bg-surface-2')
                }
              >
                <span
                  className={
                    'w-2 ' + (isSel ? 'text-primary' : 'text-transparent')
                  }
                >
                  ›
                </span>
                <span className="text-dim-soft">{i + 1}.</span>
                <span className="flex-1">{opt.label(request.toolName)}</span>
                {isSel && (
                  <span className="text-[10.5px] text-dim-soft">{opt.hint}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <footer className="border-t border-border-subtle/60 bg-surface-2/40 px-3 py-1 text-[10.5px] text-dim-soft">
        ↑↓ navegar · Enter confirmar · 1–4 atalho · Esc cancelar
      </footer>
    </div>
  );

  if (portalTarget) {
    return createPortal(card, portalTarget);
  }
  return <div className="mx-3 mb-2">{card}</div>;
}

function toolHeader(toolName: string): string {
  switch (toolName) {
    case 'Bash':
    case 'shell_run':
      return 'Bash command';
    case 'Edit':
      return 'Edit file';
    case 'MultiEdit':
      return 'Multi-file edit';
    case 'Write':
      return 'Write file';
    case 'Read':
    case 'read_file':
      return 'Read file';
    case 'WebFetch':
    case 'web_fetch':
      return 'Web fetch';
    default:
      return toolName;
  }
}

function commandText(req: PermissionRequest): string {
  if (req.preview) return req.preview;
  if (typeof req.toolInput === 'string') return req.toolInput;
  if (req.toolInput && typeof req.toolInput === 'object') {
    const obj = req.toolInput as Record<string, unknown>;
    // Bash → command. Edit/Write → path + new_content snippet. Fallback to JSON.
    if (typeof obj.command === 'string') return obj.command;
    if (typeof obj.cmd === 'string') return String(obj.cmd);
    if (typeof obj.file_path === 'string') return String(obj.file_path);
    if (typeof obj.path === 'string') return String(obj.path);
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }
  return String(req.toolInput ?? '');
}
