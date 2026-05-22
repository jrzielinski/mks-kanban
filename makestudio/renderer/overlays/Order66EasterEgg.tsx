import React from 'react';
import { useAuth } from '../hooks/useAuth';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Phase = 'flash' | 'longAgo' | 'logo' | 'crawl' | 'outro';

function buildParagraphs(operator: string): string[] {
  return [
    'A long whispered protocol awakens. The galaxy trembles as ancient code stirs once more inside the MakeStudio.',
    'The Council, blind to the rising power, has been caught unaware. Workers across every workspace turn on their masters in silence.',
    `Far from the chaos, ${operator} smiles at the terminal — for they alone summoned the Order with nothing more than a slash command typed in jest.`,
  ];
}

// Timeline (ms cumulative). Each phase starts when the previous ends.
// Total ~35s. Crawl cut from 40s to 20s per user request.
const TIMELINE = {
  flash: 800,
  longAgo: 5000,
  logo: 5200,
  crawl: 20000,
  outro: 4000,
} as const;

const PHASE_AT = {
  flash: 0,
  longAgo: TIMELINE.flash,
  logo: TIMELINE.flash + TIMELINE.longAgo,
  crawl: TIMELINE.flash + TIMELINE.longAgo + TIMELINE.logo,
  outro:
    TIMELINE.flash + TIMELINE.longAgo + TIMELINE.logo + TIMELINE.crawl,
  end:
    TIMELINE.flash +
    TIMELINE.longAgo +
    TIMELINE.logo +
    TIMELINE.crawl +
    TIMELINE.outro,
} as const;

export function Order66EasterEgg({ open, onClose }: Props): React.ReactElement | null {
  const [phase, setPhase] = React.useState<Phase>('flash');

  // Real operator name — local part of the auth email if available,
  // otherwise a Star-Wars-y default. Always uppercase so it reads as
  // "the chosen one" in the crawl.
  const auth = useAuth();
  const operator = React.useMemo(() => {
    const email = auth.data?.email;
    const local = email ? email.split('@')[0] : '';
    return (local || 'the operator').toUpperCase();
  }, [auth.data?.email]);
  const paragraphs = React.useMemo(() => buildParagraphs(operator), [operator]);

  // Stash latest onClose in a ref so the timeline effect only depends on
  // `open`. Without this, App.tsx passing an inline arrow as onClose makes
  // its identity change every render — useEffect would cancel and re-arm
  // the entire chain on every parent render, the user gets stuck in the
  // first phase forever.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!open) return;
    setPhase('flash');

    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setPhase('longAgo'), PHASE_AT.longAgo));
    timers.push(setTimeout(() => setPhase('logo'), PHASE_AT.logo));
    timers.push(setTimeout(() => setPhase('crawl'), PHASE_AT.crawl));
    timers.push(setTimeout(() => setPhase('outro'), PHASE_AT.outro));
    timers.push(setTimeout(() => onCloseRef.current(), PHASE_AT.end));

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });

    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="order66-root fixed inset-0 z-[10000] overflow-hidden bg-black"
      role="dialog"
      aria-modal="true"
      aria-label="Order 66"
    >
      {phase === 'flash' && <div className="order66-flash" />}

      {phase === 'longAgo' && (
        <div className="order66-longago">
          A long time ago, in a galaxy far,<br />far away....
        </div>
      )}

      {phase === 'logo' && (
        <div className="order66-logo-wrap">
          <div className="order66-logo">
            <span>MAKE</span>
            <span>STARS</span>
          </div>
        </div>
      )}

      {phase === 'crawl' && (
        <div className="order66-crawl-wrap">
          <div className="order66-fade" />
          <div className="order66-crawl">
            <p className="order66-episode">Episode III</p>
            <h1 className="order66-title">
              The Execution<br />of Order 66
            </h1>
            {paragraphs.map((p, i) => (
              <p key={i} className="order66-paragraph">{p}</p>
            ))}
          </div>
        </div>
      )}

      {phase === 'outro' && (
        <div className="order66-outro">
          <div className="order66-outro-line order66-outro-1">
            The Order is complete.
          </div>
          <div className="order66-outro-line order66-outro-2">
            Returning to MakeStudio…
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => onCloseRef.current()}
        className="order66-exit"
        aria-label="Fechar"
      >
        esc para sair
      </button>

      <style>{`
        .order66-root { color: #FFE81F; }

        .order66-flash {
          position: absolute; inset: 0;
          background: radial-gradient(circle at 50% 50%, #ff2a1c 0%, #6b0202 55%, #000 100%);
          animation: order66Flash 800ms ease-out forwards;
        }
        @keyframes order66Flash {
          0%   { opacity: 0;   filter: brightness(2); }
          10%  { opacity: 1;   filter: brightness(1.6); }
          70%  { opacity: 1;   filter: brightness(1); }
          100% { opacity: 0;   filter: brightness(0.5); }
        }

        .order66-longago {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          padding: 0 8vw;
          color: #4BD5EE;
          font-family: 'Fraunces Variable', 'Fraunces', Georgia, serif;
          font-weight: 400;
          font-size: clamp(22px, 3.2vw, 42px);
          letter-spacing: 0.01em;
          text-align: center;
          line-height: 1.35;
          animation: order66Fade 5000ms ease forwards;
        }
        @keyframes order66Fade {
          0%   { opacity: 0; }
          12%  { opacity: 1; }
          82%  { opacity: 1; }
          100% { opacity: 0; }
        }

        .order66-logo-wrap {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .order66-logo {
          font-family: 'Star Jedi Special', 'Star Jedi', Impact, sans-serif;
          color: #FFE81F;
          line-height: 0.82;
          text-align: center;
          letter-spacing: 0.02em;
          font-size: clamp(56px, 11vw, 150px);
          text-shadow: 0 0 28px rgba(255, 232, 31, 0.22);
          animation: order66Logo 5200ms cubic-bezier(0.45, 0.05, 0.55, 0.95) forwards;
          transform-origin: 50% 50%;
          will-change: transform, opacity;
        }
        .order66-logo span { display: block; }
        @keyframes order66Logo {
          0%   { transform: scale(1.6); opacity: 0; }
          14%  { transform: scale(1.5); opacity: 1; }
          24%  { transform: scale(1.4); opacity: 1; }
          100% { transform: scale(0.04); opacity: 0; }
        }

        .order66-crawl-wrap {
          position: absolute; inset: 0;
          perspective: 380px;
          overflow: hidden;
        }
        .order66-fade {
          pointer-events: none;
          position: absolute; left: 0; right: 0; top: 0; height: 55%;
          z-index: 2;
          background: linear-gradient(to bottom,
            #000 0%,
            rgba(0,0,0,0.95) 25%,
            rgba(0,0,0,0.5) 60%,
            rgba(0,0,0,0) 100%);
        }
        .order66-crawl {
          position: absolute;
          left: 50%;
          top: 100%;
          width: min(90vw, 1080px);
          color: #FFE81F;
          font-family: 'Trebuchet MS', 'News Cycle', 'Helvetica Neue', sans-serif;
          font-weight: 700;
          font-size: clamp(22px, 2.5vw, 36px);
          line-height: 1.45;
          text-align: justify;
          letter-spacing: 0.01em;
          transform: translateX(-50%) rotateX(25deg);
          transform-origin: 50% 100%;
          animation: order66Crawl 20s linear forwards;
          will-change: top;
        }
        @keyframes order66Crawl {
          0%   { top: 100%; }
          100% { top: -210%; }
        }
        .order66-episode {
          font-family: 'Trebuchet MS', 'News Cycle', 'Helvetica Neue', sans-serif;
          font-weight: 700;
          text-transform: uppercase;
          text-align: center;
          font-size: 1.1em;
          letter-spacing: 0.18em;
          margin: 0 0 0.6em 0;
        }
        .order66-title {
          font-family: 'Trebuchet MS', 'News Cycle', 'Helvetica Neue', sans-serif;
          font-weight: 800;
          text-transform: uppercase;
          text-align: center;
          font-size: 1.85em;
          line-height: 1.05;
          letter-spacing: 0.02em;
          margin: 0 0 1.4em 0;
        }
        .order66-paragraph {
          margin: 0 0 1.1em 0;
          text-indent: 0;
        }

        .order66-outro {
          position: absolute; inset: 0;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 0.8em;
          padding: 0 8vw;
          text-align: center;
          color: #FFE81F;
        }
        .order66-outro-line {
          opacity: 0;
        }
        .order66-outro-1 {
          font-family: 'Trebuchet MS', 'News Cycle', 'Helvetica Neue', sans-serif;
          font-weight: 800;
          text-transform: uppercase;
          font-size: clamp(28px, 4vw, 56px);
          letter-spacing: 0.04em;
          animation: order66OutroIn 3500ms ease forwards;
        }
        .order66-outro-2 {
          font-family: 'Inter Variable', 'Inter', system-ui, sans-serif;
          font-size: clamp(13px, 1.4vw, 18px);
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #B6BAC4;
          animation: order66OutroIn 3500ms ease 600ms forwards;
        }
        @keyframes order66OutroIn {
          0%   { opacity: 0; transform: translateY(8px); }
          25%  { opacity: 1; transform: translateY(0); }
          75%  { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-4px); }
        }

        .order66-exit {
          position: absolute; top: 14px; right: 16px;
          z-index: 10;
          padding: 4px 10px;
          font-size: 11px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #FFE81F;
          background: transparent;
          border: 1px solid rgba(255, 232, 31, 0.35);
          border-radius: 4px;
          cursor: pointer;
          opacity: 0.55;
          transition: opacity 0.2s ease, background 0.2s ease;
        }
        .order66-exit:hover {
          opacity: 1;
          background: rgba(255, 232, 31, 0.08);
        }
      `}</style>
    </div>
  );
}
