import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, EyeOff, Loader, ArrowRight } from 'lucide-react';
import clsx from 'clsx';
import { authApi } from '../ipc/client';
import logoIcon from '../assets/makestudioicon.png';

const DEFAULT_SERVER = 'https://api.zielinski.dev.br';

export function LoginPage(): React.ReactElement {
  const qc = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [serverUrl, setServerUrl] = React.useState(DEFAULT_SERVER);
  const [showPassword, setShowPassword] = React.useState(false);
  const [showServer, setShowServer] = React.useState(false);

  const loginMut = useMutation({
    mutationFn: () =>
      authApi.login({
        email: email.trim(),
        password,
        serverUrl: serverUrl.trim() || DEFAULT_SERVER,
      }),
    onSuccess: (res) => {
      if (res.ok && res.status?.authenticated) {
        qc.setQueryData(['auth', 'status'], res.status);
        qc.invalidateQueries({ queryKey: ['auth'] });
      }
    },
  });

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!email.trim() || !password || loginMut.isPending) return;
    loginMut.mutate();
  };

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSubmit = validEmail && password.length > 0 && !loginMut.isPending;

  // Reset mutation state when user edits — keeps the error display fresh.
  const resetIfErrored = (): void => {
    if (loginMut.isError || (loginMut.data && !loginMut.data.ok)) {
      loginMut.reset();
    }
  };

  const errorMsg =
    loginMut.data && !loginMut.data.ok
      ? loginMut.data.error
      : loginMut.error
        ? `Falha de IPC: ${(loginMut.error as Error).message ?? String(loginMut.error)}`
        : null;

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-surface-0 px-6">
      {/* Subtle ambient glow — claude.ai-esque depth without being noisy */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute left-1/2 top-[-20%] h-[520px] w-[680px] -translate-x-1/2 rounded-full bg-primary/[0.06] blur-3xl" />
        <div className="absolute bottom-[-30%] left-1/2 h-[420px] w-[560px] -translate-x-1/2 rounded-full bg-primary/[0.04] blur-3xl" />
      </div>

      <main className="relative z-10 flex w-full max-w-[380px] flex-col">
        {/* Brand mark */}
        <div className="mb-10 flex flex-col items-center">
          <img
            src={logoIcon}
            alt=""
            className="mb-5 h-10 w-10 rounded-lg shadow-card"
            draggable={false}
          />
          <h1 className="font-serif text-[28px] font-normal leading-tight tracking-tight text-text">
            Bem-vindo de volta
          </h1>
          <p className="mt-2 text-[13px] text-dim">
            Entre na sua conta MakeStudio pra continuar.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <FieldShell label="Email">
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                resetIfErrored();
              }}
              autoComplete="email"
              placeholder="voce@dominio.com"
              spellCheck={false}
              className="w-full bg-transparent px-4 py-3 text-[14px] text-text placeholder:text-dim/60 focus:outline-none"
            />
          </FieldShell>

          <FieldShell label="Senha">
            <div className="relative flex w-full items-center">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  resetIfErrored();
                }}
                autoComplete="current-password"
                placeholder="Sua senha"
                className="w-full bg-transparent px-4 py-3 text-[14px] text-text placeholder:text-dim/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                className="mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded text-dim transition-colors hover:bg-surface-2 hover:text-text-soft"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </FieldShell>

          {/* Submit */}
          <button
            type="submit"
            disabled={!canSubmit}
            className={clsx(
              'group mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[14px] font-medium transition-all',
              canSubmit
                ? 'bg-text text-surface-0 hover:opacity-90'
                : 'cursor-not-allowed bg-surface-3 text-dim',
            )}
          >
            {loginMut.isPending ? (
              <>
                <Loader size={14} className="animate-spin" />
                Autenticando…
              </>
            ) : (
              <>
                Entrar
                <ArrowRight
                  size={14}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              </>
            )}
          </button>

          {errorMsg && (
            <div
              role="alert"
              className="mt-1 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2.5 text-[12.5px] leading-relaxed text-danger"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </form>

        {/* Advanced server URL — claude.ai-esque text link */}
        <div className="mt-6 flex flex-col items-center gap-3 text-center text-[12px] text-dim">
          {!showServer ? (
            <button
              type="button"
              onClick={() => setShowServer(true)}
              className="text-dim transition-colors hover:text-text-soft"
            >
              Conectar a outro servidor
            </button>
          ) : (
            <div className="w-full">
              <label className="mb-1.5 block text-left text-[10.5px] font-medium uppercase tracking-[0.13em] text-dim/80">
                Servidor
              </label>
              <input
                type="url"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder={DEFAULT_SERVER}
                spellCheck={false}
                className="block w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 font-mono text-[12px] text-text-soft placeholder:text-dim/60 focus:border-primary/40 focus:bg-surface-1 focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-10 flex flex-col items-center gap-1 text-center">
          <p className="text-[11.5px] text-dim/80">
            Não tem conta? Acesse{' '}
            <span className="font-mono text-text-soft">
              {serverUrl.replace(/^https?:\/\//, '')}
            </span>{' '}
            pra criar.
          </p>
          <p className="text-[10.5px] text-dim/60">
            Alternativa CLI: <span className="font-mono">makestudio login</span>
          </p>
        </div>
      </main>
    </div>
  );
}

/**
 * Input shell — fixed border, focus-within ring, floating label aesthetic.
 * Pulls the field chrome out of the form so each input is uniform.
 */
function FieldShell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="group flex flex-col rounded-xl border border-border-subtle bg-surface-1 transition-colors focus-within:border-primary/40 focus-within:bg-surface-1 hover:border-border-soft">
      <span className="px-4 pt-2.5 text-[10.5px] font-medium uppercase tracking-[0.13em] text-dim/80">
        {label}
      </span>
      {children}
    </label>
  );
}
