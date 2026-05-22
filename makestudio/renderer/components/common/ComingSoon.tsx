import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CheckCircle2, Sparkles } from 'lucide-react';

interface Props {
  title: string;
  description: string;
  phase: number;
  features?: string[];
  quickLinks?: Array<{ label: string; to: string }>;
}

export function ComingSoon({
  title,
  description,
  phase,
  features,
  quickLinks,
}: Props): React.ReactElement {
  const isMvp = phase >= 1 && phase <= 4;

  return (
    <div className="relative flex h-full w-full items-start justify-center overflow-y-auto p-10 pt-16">
      <div className="w-full max-w-3xl">
        {/* Phase ribbon */}
        <div className="mb-5 flex items-center gap-2">
          <span
            className="chip !py-1 font-mono"
            style={{
              color: 'var(--color-primary-soft)',
              borderColor: 'rgba(215,119,87,0.25)',
              background: 'rgba(215,119,87,0.06)',
            }}
          >
            <Sparkles size={11} strokeWidth={2.2} />
            Fase {phase} · {isMvp ? 'MVP' : 'Pós-MVP'}
          </span>
          <span className="chip">em construção</span>
        </div>

        {/* Title + description */}
        <h1 className="mb-3 text-[40px] font-semibold leading-[1.1] tracking-tight text-text">
          {title}
        </h1>
        <p className="mb-10 max-w-2xl text-[15px] leading-relaxed text-dim-soft">
          {description}
        </p>

        {/* Features card with gradient border */}
        {features && features.length > 0 && (
          <div className="card-gradient mb-8 p-6 shadow-card">
            <div className="mb-4 flex items-center gap-2">
              <span className="h-px flex-1 bg-gradient-to-r from-border-soft to-transparent" />
              <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-dim">
                recursos previstos
              </span>
              <span className="h-px flex-1 bg-gradient-to-l from-border-soft to-transparent" />
            </div>
            <ul className="grid gap-3 sm:grid-cols-1">
              {features.map((f) => (
                <li key={f} className="flex items-start gap-3 text-[13.5px] leading-relaxed text-text-soft">
                  <CheckCircle2
                    size={15}
                    strokeWidth={2}
                    className="mt-0.5 shrink-0 text-primary/70"
                  />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Quick links */}
        {quickLinks && quickLinks.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {quickLinks.map((q) => (
              <Link
                key={q.to}
                to={q.to}
                className="group inline-flex items-center gap-2 rounded-md border border-border-subtle bg-surface-1/80 px-3.5 py-2 text-[13px] font-medium text-text-soft transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-surface-2 hover:text-text hover:shadow-elev"
              >
                <span>{q.label}</span>
                <ArrowUpRight
                  size={14}
                  strokeWidth={2}
                  className="text-dim transition-colors group-hover:text-primary"
                />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
