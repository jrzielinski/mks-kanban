import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const PTY = () => (window as any).kanbanDesktop?.pty;

/**
 * Renders the real MakeStudio Code TUI: an xterm.js terminal bound to a
 * node-pty session in the desktop main process. Each instance owns its own
 * pty session (spawned on mount, killed on unmount).
 */
export const AgentTuiTerminal: React.FC<{ className?: string }> = ({ className }) => {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const pty = PTY();
    if (!pty) {
      host.textContent = 'MakeStudio Code está disponível apenas no app desktop.';
      host.style.cssText = 'color:#8b949e;font:13px monospace;padding:12px';
      return;
    }

    const term = new Terminal({
      fontFamily: '"Cascadia Code","Fira Code","JetBrains Mono",ui-monospace,monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      // The agent TUI (Ink) handles resize by writing `rows` blank lines to push
      // content into scrollback, then re-rendering its dynamic area at the
      // bottom — so it *relies* on scrollback existing. Keep a generous buffer.
      scrollback: 5000,
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* container not measured yet */
    }

    let disposed = false;
    let sessionId: string | null = null;
    let offData: (() => void) | undefined;
    let offExit: (() => void) | undefined;

    term.onData((d) => {
      if (sessionId) pty.write(sessionId, d);
    });

    pty.start({ cols: term.cols, rows: term.rows }).then((id: string) => {
      if (disposed) {
        pty.kill(id);
        return;
      }
      sessionId = id;
      offData = pty.onData(id, (data: string) => term.write(data));
      offExit = pty.onExit(id, () =>
        term.write('\r\n\x1b[90m[sessão encerrada]\x1b[0m\r\n'),
      );
      term.focus();
    });

    // Resize is delicate with a full-screen TUI: bursts of resize events or
    // measuring before layout settles desyncs the pty rows/cols from xterm and
    // the TUI repaints into the wrong region (black gap + duplicated frame).
    // So: collapse bursts (debounce), measure after a frame (rAF), only resize
    // the pty when the geometry actually changed, then pin to the live region.
    let lastCols = term.cols;
    let lastRows = term.rows;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    const applyFit = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if ((term.cols !== lastCols || term.rows !== lastRows) && term.cols > 0 && term.rows > 0) {
        lastCols = term.cols;
        lastRows = term.rows;
        if (sessionId) pty.resize(sessionId, term.cols, term.rows);
        // The TUI re-renders its dynamic area at the bottom ~50ms after the
        // SIGWINCH (it debounces). Pin the viewport to that fresh bottom only
        // after it has repainted, so we never park in the pushed-up scrollback.
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => term.scrollToBottom(), 200);
      }
    };
    const onResize = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(applyFit);
      }, 80);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      clearTimeout(debounce);
      clearTimeout(scrollTimer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      offData?.();
      offExit?.();
      if (sessionId) pty.kill(sessionId);
      term.dispose();
    };
  }, []);

  return <div ref={hostRef} className={className} style={{ width: '100%', height: '100%' }} />;
};
