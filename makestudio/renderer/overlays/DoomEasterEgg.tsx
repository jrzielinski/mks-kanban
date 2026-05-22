import React from 'react';

const JSDOS_BASE = './vendor/jsdos/';
const JSDOS_SCRIPT_ID = 'makestudio-jsdos-script';
const JSDOS_STYLE_ID = 'makestudio-jsdos-style';

interface DosInstanceLike {
  run: (bundleUrl: string) => Promise<unknown>;
  stop: () => Promise<unknown>;
}

interface EmulatorsUiLike {
  dos: (element: HTMLElement, options?: Record<string, unknown>) => DosInstanceLike;
}

declare global {
  interface Window {
    Dos?: unknown;
    emulators?: { pathPrefix?: string };
    emulatorsUi?: EmulatorsUiLike;
  }
}

function ensureStylesheet(): void {
  if (document.getElementById(JSDOS_STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = JSDOS_STYLE_ID;
  link.rel = 'stylesheet';
  link.href = JSDOS_BASE + 'js-dos.css';
  document.head.appendChild(link);
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.emulatorsUi) {
      resolve();
      return;
    }
    const existing = document.getElementById(JSDOS_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('js-dos load failed')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = JSDOS_SCRIPT_ID;
    script.src = JSDOS_BASE + 'js-dos.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('js-dos load failed'));
    document.body.appendChild(script);
  });
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DoomEasterEgg({ open, onClose }: Props): React.ReactElement | null {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const dosRef = React.useRef<DosInstanceLike | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = React.useState<string>('');

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, onClose]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    setErrorMsg('');

    ensureStylesheet();

    const log = (...args: unknown[]): void => {
      // eslint-disable-next-line no-console
      console.log('[doom]', ...args);
    };

    const bundleUrl = new URL(JSDOS_BASE + 'doom.jsdos', window.location.href).toString();
    const wdosboxBase = new URL(JSDOS_BASE, window.location.href).toString();

    loadScript()
      .then(() => {
        if (cancelled) return;
        const container = containerRef.current;
        if (!window.emulatorsUi || !container) {
          throw new Error('emulatorsUi não inicializou');
        }
        // Onde wdosbox.js / wdosbox.wasm vão ser carregados.
        if (window.emulators) window.emulators.pathPrefix = wdosboxBase;
        log('pathPrefix=', wdosboxBase, 'bundleUrl=', bundleUrl);

        // API low-level: window.emulatorsUi.dos(elem, opts) → DosInstance.
        // Bypassa o wrapper v7 (que retornava stub quebrado com style:'none')
        // e o v8 (que mudou a assinatura pra url em options).
        const instance = window.emulatorsUi.dos(container, {
          emulatorFunction: 'dosboxWorker',
          // keyboardInputDiv: div que recebe tabIndex=0 + keydown listener.
          // Sem isso, o player wrapper passaria um div separado interno; aqui
          // mandamos pro próprio container pra que o teclado físico funcione
          // sem precisar criar layout próprio. NÃO setar keyboardDiv (esse é
          // pro software keyboard mobile e cobriria o canvas se for o mesmo).
          layersOptions: {
            keyboardInputDiv: container,
            fullscreenElement: container,
          },
        });
        dosRef.current = instance;

        return instance
          .run(bundleUrl)
          .then(() => {
            if (cancelled) {
              try { instance.stop?.(); } catch { /* ignore */ }
              return;
            }
            log('dosbox started');
            // Foca o container pra capturar teclado imediatamente — sem
            // precisar do user clicar primeiro.
            try { container.focus(); } catch { /* ignore */ }
            // Bind: clicar em qualquer ponto do container re-foca (caso o
            // foco se perca pra outro elemento).
            const refocus = (): void => { try { container.focus(); } catch { /* */ } };
            container.addEventListener('click', refocus);
            container.addEventListener('mousedown', refocus);
            setStatus('ready');
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            const msg = err instanceof Error ? err.message : String(err);
            log('run() failed:', msg, err);
            setErrorMsg(msg);
            setStatus('error');
          });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        log('script/init failed:', msg, err);
        setErrorMsg(msg);
        setStatus('error');
      });

    return () => {
      cancelled = true;
      const dos = dosRef.current;
      dosRef.current = null;
      if (dos?.stop) {
        try {
          const r = dos.stop();
          if (r && typeof (r as Promise<unknown>).then === 'function') {
            (r as Promise<unknown>).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col bg-black"
      role="dialog"
      aria-modal="true"
      aria-label="Doom"
    >
      <div className="flex items-center justify-between px-4 py-2 text-[11.5px] uppercase tracking-[0.18em] text-[#9b6a3a]">
        <span>RIP AND TEAR — esc para sair</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-[#9b6a3a]/40 px-2 py-0.5 text-[#c08a4f] hover:bg-[#9b6a3a]/15"
        >
          fechar
        </button>
      </div>
      <div className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {status === 'loading' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[#c08a4f]">
            <span className="animate-pulse text-sm">carregando knee-deep in the dead…</span>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center text-center text-sm text-red-400">
            <div>
              <div>falha ao carregar o doom</div>
              <div className="mt-1 text-[11px] opacity-70">{errorMsg}</div>
              <div className="mt-2 text-[10px] opacity-60">
                Abra DevTools (Ctrl+Shift+I) → Console pra ver detalhes em [doom].
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
