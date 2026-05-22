/**
 * OnboardingWizard — 4-step first-run wizard.
 *
 * Steps:
 *   1. Bem-vindo — branding + tagline
 *   2. Provider — onde está o modelo
 *   3. Tema — aparência
 *   4. Pasta de trabalho — trusted folder setup
 *
 * Completion is persisted in localStorage so it only shows once.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Sparkles, Cpu, Palette, FolderOpen, ChevronRight, Check } from 'lucide-react';

const STORAGE_KEY = 'makestudio:onboardingCompleted';

export function useOnboardingCompleted(): [boolean, () => void] {
  const [done, setDone] = React.useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return true; // fail-safe: don't block the app
    }
  });

  const complete = React.useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch { /* */ }
    setDone(true);
  }, []);

  return [done, complete];
}

const STEPS = [
  {
    id: 'welcome',
    icon: Sparkles,
    title: 'Bem-vindo ao MakeStudio',
    description:
      'Seu agente de código completo. Converse, planeie, refatore e monitore — tudo num só lugar.',
    cta: 'Começar',
  },
  {
    id: 'provider',
    icon: Cpu,
    title: 'Configure seu modelo',
    description:
      'Conecte um provedor de LLM — Claude, OpenAI, Gemini ou qualquer servidor local. Você pode trocar depois em Integrações → Provedores.',
    cta: 'Configurar provedores',
    path: '/integrations/providers',
    skip: true,
  },
  {
    id: 'theme',
    icon: Palette,
    title: 'Escolha a aparência',
    description:
      'Selecione o tema que combina com você. Pode trocar quando quiser em Ajustes → Aparência.',
    cta: 'Ir para Aparência',
    path: '/settings/appearance',
    skip: true,
  },
  {
    id: 'folder',
    icon: FolderOpen,
    title: 'Pasta de trabalho',
    description:
      'Adicione as pastas em que você quer trabalhar. O agente verá arquivos apenas nestas pastas de confiança.',
    cta: 'Configurar pastas',
    path: '/settings/security',
    skip: true,
  },
] as const;

interface Props {
  onComplete: () => void;
}

export function OnboardingWizard({ onComplete }: Props): React.ReactElement {
  const navigate = useNavigate();
  const [step, setStep] = React.useState(0);
  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  const handleCta = (): void => {
    if (isLast) {
      onComplete();
      return;
    }
    if ('path' in current && current.path) {
      navigate(current.path);
      onComplete();
      return;
    }
    setStep((s) => s + 1);
  };

  const handleSkip = (): void => {
    if (isLast) {
      onComplete();
    } else {
      setStep((s) => s + 1);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />

      {/* Card */}
      <div className="relative flex w-full max-w-lg flex-col rounded-2xl border border-border-subtle bg-surface-1 p-8 shadow-2xl">

        {/* Step dots */}
        <div className="mb-8 flex justify-center gap-2" role="tablist" aria-label="Progresso">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === step}
              aria-label={`Passo ${i + 1}`}
              onClick={() => setStep(i)}
              className={clsx(
                'h-1.5 rounded-full transition-all',
                i === step ? 'w-6 bg-primary' : 'w-1.5 bg-surface-3 hover:bg-dim',
              )}
            />
          ))}
        </div>

        {/* Icon */}
        <div className="mb-5 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Icon size={32} strokeWidth={1.5} />
          </div>
        </div>

        {/* Text */}
        <h2
          id="onboarding-title"
          className="mb-3 text-center text-[20px] font-semibold tracking-tight text-text"
        >
          {current.title}
        </h2>
        <p className="mb-8 text-center text-[13px] leading-relaxed text-text-soft">
          {current.description}
        </p>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleCta}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-[13px] font-semibold text-surface-0 hover:bg-primary-soft"
          >
            {isLast ? <Check size={14} /> : <ChevronRight size={14} />}
            {isLast ? 'Concluir' : current.cta}
          </button>
          {'skip' in current && current.skip && !isLast && (
            <button
              type="button"
              onClick={handleSkip}
              className="w-full rounded-lg px-5 py-2.5 text-[12px] text-dim hover:text-text"
            >
              Pular
            </button>
          )}
          {isLast && (
            <button
              type="button"
              onClick={onComplete}
              className="w-full rounded-lg px-5 py-2.5 text-[12px] text-dim hover:text-text"
            >
              Fechar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
