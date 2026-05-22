/**
 * MakeStudio embed entry — alternative to renderer/main.tsx for the VSCode webview.
 *
 * Differences vs. the Electron entry:
 *   - Does NOT depend on `window.makestudio` provided by `preload.ts` (that's an
 *     Electron-only contextBridge). Phase 2 installs a postMessage-backed shim
 *     before any page imports `ipc/client.ts`. Phase 1 just installs a no-op
 *     stub so the renderer can mount without crashing while we wire the bridge.
 *   - Wraps the tree in <EmbedErrorBoundary> so render errors become visible
 *     instead of a silent white screen.
 *   - Forwards window.onerror, unhandledrejection, console.error to the host's
 *     Output channel via postMessage.
 *   - StrictMode disabled — double effect invocation doubles every IPC call,
 *     which adds noise and risks duplicate writes (same call as flowbuilder embed).
 */

// IMPORTANT: bridge must be imported BEFORE App — auto-installs on load so any
// transitive import that touches window.makestudio at module-init time finds it.
import './makestudioBridge';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmbedShell } from './EmbedShell';
import '../styles/globals.css';
import { EmbedErrorBoundary } from './ErrorBoundary';
import { postToHost } from './vscodeApi';

window.addEventListener('error', (e) => {
  postToHost({
    type: 'log',
    level: 'error',
    message: `[embed onerror] ${e.message}`,
    data: { filename: e.filename, lineno: e.lineno, colno: e.colno, stack: e.error?.stack },
  });
  showInlineError(`window.onerror: ${e.message}`, e.error?.stack);
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  postToHost({
    type: 'log',
    level: 'error',
    message: `[embed unhandled rejection] ${reason.message}`,
    data: { stack: reason.stack },
  });
});

function showInlineError(headline: string, stack?: string): void {
  const root = document.getElementById('app');
  if (!root) return;
  if (root.dataset.errorRendered === 'true') return;
  root.dataset.errorRendered = 'true';
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'padding:24px;font-family:monospace;color:#c0392b;background:#1e1e1e;height:100vh;overflow:auto;';
  const h = document.createElement('h2');
  h.textContent = 'MakeStudio embed crashed before mounting';
  wrap.appendChild(h);
  const pre = document.createElement('pre');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
  pre.textContent = headline + (stack ? '\n\n' + stack : '');
  wrap.appendChild(pre);
  root.appendChild(wrap);
}

const originalError = console.error;
console.error = (...args) => {
  try {
    postToHost({
      type: 'log',
      level: 'error',
      message: `[embed console.error] ${args.map((a) => safe(a)).join(' ')}`,
    });
  } catch {
    /* ignore */
  }
  originalError.apply(console, args);
};

function safe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('MakeStudio embed root element #app not found');

createRoot(rootEl).render(
  <EmbedErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <EmbedShell />
      </MemoryRouter>
    </QueryClientProvider>
  </EmbedErrorBoundary>,
);

// Tell the host we're alive — host can use this to flush any queued
// `events:push` or `flow:load` messages it had buffered while bundle was loading.
postToHost({ type: 'embed:ready' });
