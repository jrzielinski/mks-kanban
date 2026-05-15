import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { Mail, Lock, Eye, EyeOff, User as UserIcon, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/store/auth';

const schema = z.object({
  firstName: z.string().min(1, 'Informe seu nome'),
  lastName: z.string().optional(),
  email: z.string().email('E-mail inválido'),
  password: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres'),
});

type RegisterForm = z.infer<typeof schema>;

export const Register: React.FC = () => {
  const navigate = useNavigate();
  const { register: registerUser } = useAuthStore();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterForm>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: RegisterForm) => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      await registerUser({
        email: data.email,
        password: data.password,
        firstName: data.firstName,
        lastName: data.lastName ?? '',
      });
      navigate('/login', { state: { message: 'Conta criada! Faça login para continuar.' } });
    } catch {
      // toast handled by the store
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#040a18]">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat scale-105 opacity-60"
        style={{ backgroundImage: "url('/world_background.jpg')" }}
      />
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,8,20,0.65)_0%,rgba(0,8,20,0.88)_60%,rgba(0,8,20,0.98)_100%)]" />

      <div className="relative flex min-h-screen items-center justify-center px-6 py-10">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full max-w-[420px]"
        >
          <Link
            to="/login"
            className="mb-6 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-400/70 hover:text-cyan-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Voltar
          </Link>

          <h1 className="text-3xl font-bold tracking-tight text-white">Criar conta</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Configure seu workspace local em segundos.
          </p>

          <form className="mt-8 space-y-5" onSubmit={handleSubmit(onSubmit)}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                id="firstName"
                label="Nome"
                icon={<UserIcon className="h-4 w-4 text-slate-500" />}
                error={errors.firstName?.message}
                input={
                  <input
                    id="firstName"
                    type="text"
                    autoComplete="given-name"
                    className={inputClass}
                    placeholder="Jose"
                    {...register('firstName')}
                  />
                }
              />
              <Field
                id="lastName"
                label="Sobrenome"
                icon={<UserIcon className="h-4 w-4 text-slate-500" />}
                error={errors.lastName?.message}
                input={
                  <input
                    id="lastName"
                    type="text"
                    autoComplete="family-name"
                    className={inputClass}
                    placeholder="(opcional)"
                    {...register('lastName')}
                  />
                }
              />
            </div>

            <Field
              id="email"
              label="E-mail"
              icon={<Mail className="h-4 w-4 text-slate-500" />}
              error={errors.email?.message}
              input={
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  className={inputClass}
                  placeholder="voce@exemplo.com"
                  {...register('email')}
                />
              }
            />

            <Field
              id="password"
              label="Senha"
              icon={<Lock className="h-4 w-4 text-slate-500" />}
              error={errors.password?.message}
              input={
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    className={`${inputClass} pr-11`}
                    placeholder="••••••••"
                    {...register('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-500 transition hover:text-slate-300"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              }
            />

            <Button
              type="submit"
              className="w-full rounded-xl bg-[linear-gradient(135deg,#22d3ee_0%,#2563eb_100%)] py-3.5 text-sm font-bold text-white shadow-[0_8px_32px_rgba(34,211,238,0.22)] transition-all hover:brightness-110"
              size="lg"
              loading={isLoading}
            >
              {isLoading ? 'Criando…' : 'Criar conta'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-400">
            Já tem conta?{' '}
            <Link to="/login" className="font-semibold text-cyan-400 hover:text-cyan-200">
              Entrar
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
};

// ── tiny field helper to keep the form readable ───────────────────────────

const inputClass =
  'w-full rounded-xl border border-white/10 bg-white/[0.06] py-3 pl-10 pr-4 text-sm text-white placeholder:text-slate-600 transition-all focus:border-cyan-500/60 focus:bg-white/10 focus:outline-none focus:ring-0';

const Field: React.FC<{
  id: string;
  label: string;
  icon: React.ReactNode;
  error?: string;
  input: React.ReactNode;
}> = ({ id, label, icon, error, input }) => (
  <div className="space-y-1.5">
    <label htmlFor={id} className="block text-sm font-medium text-slate-300">
      {label}
    </label>
    <div className="relative">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center pl-3.5">
        {icon}
      </div>
      {input}
    </div>
    {error && <p className="text-xs text-rose-400">{error}</p>}
  </div>
);

export default Register;
