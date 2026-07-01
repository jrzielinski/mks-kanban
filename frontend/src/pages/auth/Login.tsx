import React, { useState, useEffect } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Mail, Lock, Eye, EyeOff, CheckCircle, LayoutGrid, Zap, Users, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useAuthStore } from '@/store/auth'
import { LoginRequest } from '@/types'
import { useTenant } from '@/hooks/useTenant'

type LoginForm = { email: string; password: string }

export const Login: React.FC = () => {
  const loginSchema = z.object({
    email: z.string().email('E-mail inválido'),
    password: z.string().min(6, 'A senha deve ter ao menos 6 caracteres'),
  })
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  const { login } = useAuthStore()

  const tenantInfo = useTenant()
  const [tenantLogo, setTenantLogo] = useState<string | null>(null)

  // Fetch tenant logo
  useEffect(() => {
    const fetchTenantLogo = async () => {
      try {
        if (tenantInfo.tenantId && tenantInfo.tenantId !== 'staff') {
          const response = await fetch(`/api/v1/public/tenants/${tenantInfo.tenantId}/logo`)
          if (response.ok) {
            const data = await response.json()
            if (data.logo_base64) {
              const logoBase64 = data.logo_base64.startsWith('data:image/')
                ? data.logo_base64
                : `data:image/png;base64,${data.logo_base64}`
              setTenantLogo(logoBase64)
            }
          }
        }
      } catch (error) {
        console.error('Erro ao buscar logo do tenant:', error)
      }
    }
    fetchTenantLogo()
  }, [tenantInfo.tenantId])

  useEffect(() => {
    if (location.state?.message) {
      setSuccessMessage(location.state.message)
      setTimeout(() => setSuccessMessage(''), 5000)
    }
  }, [location.state])

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) })

  const onSubmit = async (data: LoginForm) => {
    if (isLoading) return
    setIsLoading(true)
    try {
      await login(data as LoginRequest)
      navigate('/dashboard')
    } catch (error) {
      // Error is handled by the store
    } finally {
      setIsLoading(false)
    }
  }

  // Auto-fill from Electron .env if available
  useEffect(() => {
    const loadEnvCreds = async () => {
      try {
        const w = window as any
        if (w.kanbanDesktop?.getEnvCreds) {
          const creds = await w.kanbanDesktop.getEnvCreds()
          if (creds?.email && creds?.password) {
            setValue('email', creds.email)
            setValue('password', creds.password)
          }
        }
      } catch {}
    }
    loadEnvCreds()
  }, [setValue])

  const fillDevCredentials = () => {
    setValue('email', 'admin@zielinski.dev.br')
    setValue('password', 'password@123')
  }

  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

  const features = [
    { icon: LayoutGrid, title: 'Quadros & colunas', desc: 'Do backlog ao done num fluxo visual, com limite de WIP.' },
    { icon: Zap, title: 'Automações', desc: 'Regras que movem cards, notificam e disparam ações sozinhas.' },
    { icon: Users, title: 'Colaboração', desc: 'Time no mesmo quadro, em tempo real, com histórico de cada card.' },
  ]

  // Tema Claude (papel cream + coral). Contraste alto — nada de texto claro no cream.
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#FAF9F5] text-[#28241F]">
      <div className="pointer-events-none absolute -top-32 -right-24 h-96 w-96 rounded-full bg-[#C15F3C]/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -left-24 h-[28rem] w-[28rem] rounded-full bg-[#E0A458]/10 blur-3xl" />

      <div className="relative flex min-h-screen flex-col lg:flex-row">

        {/* LEFT — branding Kanban */}
        <div className="flex flex-col justify-between border-b border-[#E9E3D6] p-8 sm:p-12 lg:w-[55%] lg:border-b-0 lg:border-r xl:p-16">
          {/* self-start: filho direto de flex-col estica na largura (align stretch)
              e deforma o logo; trava a proporção. */}
          <img
            src="/makestudiologo.png"
            alt="MakeStudio"
            className="h-9 w-auto self-start"
            style={{ height: 36, width: 'auto' }}
          />

          <div className="my-10 lg:my-0">
            <div className="mb-6 flex items-center gap-2">
              <div className="h-px w-8 bg-[#C15F3C]" />
              <span className="text-xs font-semibold uppercase tracking-[0.25em] text-[#C15F3C]">
                Kanban · Fluxo · Automação
              </span>
            </div>

            <h1 className="text-[2.6rem] font-bold leading-[1.08] tracking-tight text-[#28241F] sm:text-[3.2rem] xl:text-[3.6rem]">
              Seu trabalho,<br />
              organizado em{' '}
              <span className="bg-[linear-gradient(90deg,#C15F3C_0%,#DA7756_100%)] bg-clip-text text-transparent">
                Kanban
              </span>.
            </h1>

            <p className="mt-5 max-w-md text-base leading-7 text-[#5C564C]">
              Planeje, acompanhe e automatize suas tarefas em quadros visuais — do backlog ao done, sem perder o fio.
            </p>

            <div className="mt-10 grid max-w-lg gap-3 sm:grid-cols-3">
              {features.map(({ icon: Icon, title, desc }) => (
                <div key={title} className="rounded-2xl border border-[#E9E3D6] bg-[#F4F1E9] p-4">
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-[#C15F3C]/12 text-[#C15F3C]">
                    <Icon className="h-4 w-4" />
                  </div>
                  <p className="text-sm font-semibold text-[#28241F]">{title}</p>
                  <p className="mt-1 text-xs leading-5 text-[#8A8276]">{desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="hidden lg:block">
            <div className="inline-flex items-center gap-2.5 rounded-full border border-[#E9E3D6] bg-white/60 px-4 py-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4F9D69] opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#4F9D69]" />
              </span>
              <span className="text-xs font-medium text-[#5C564C]">Quadros online · sincronizados</span>
            </div>
          </div>
        </div>

        {/* RIGHT — login form (direto) */}
        <div className="flex w-full items-center justify-center px-6 py-10 sm:px-10 lg:w-[45%]">
          <div className="w-full max-w-[380px]">
            {tenantLogo && (
              <div className="mb-6 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm">
                <img src={tenantLogo} alt="Logo" className="max-h-10 max-w-10 object-contain" />
              </div>
            )}

            <h2 className="text-3xl font-bold tracking-tight text-[#28241F]">Entrar</h2>
            <p className="mt-2 text-sm leading-6 text-[#8A8276]">Acesse seus quadros Kanban.</p>

            {isLocalhost && (
              <button
                onClick={fillDevCredentials}
                type="button"
                className="mt-5 inline-flex items-center gap-2 rounded-lg border border-[#E0A458]/40 bg-[#E0A458]/10 px-4 py-2 text-xs font-semibold text-[#9A6A1F] transition hover:bg-[#E0A458]/20"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Preencher credenciais de dev
              </button>
            )}

            {successMessage && (
              <div className="mt-5 flex items-center rounded-xl border border-[#4F9D69]/30 bg-[#4F9D69]/10 px-4 py-3">
                <CheckCircle size={15} className="mr-2 flex-shrink-0 text-[#4F9D69]" />
                <span className="text-sm text-[#3F7D54]">{successMessage}</span>
              </div>
            )}

            <form className="mt-7 space-y-5" onSubmit={handleSubmit(onSubmit)}>
              {(errors.email || errors.password) && (
                <div className="rounded-xl border border-[#C5524B]/30 bg-[#C5524B]/10 px-4 py-3 text-sm text-[#A33F39]">
                  {errors.email?.message || errors.password?.message}
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="email" className="block text-sm font-medium text-[#5C564C]">E-mail</label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                    <Mail className="h-4 w-4 text-[#A79E8E]" />
                  </div>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    className="w-full rounded-xl border border-[#D9D1C0] bg-white py-3 pl-10 pr-4 text-sm text-[#28241F] placeholder:text-[#A79E8E] transition-all focus:border-[#C15F3C] focus:outline-none focus:ring-0"
                    placeholder="voce@empresa.com.br"
                    {...register('email')}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="password" className="block text-sm font-medium text-[#5C564C]">Senha</label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                    <Lock className="h-4 w-4 text-[#A79E8E]" />
                  </div>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    className="w-full rounded-xl border border-[#D9D1C0] bg-white py-3 pl-10 pr-11 text-sm text-[#28241F] placeholder:text-[#A79E8E] transition-all focus:border-[#C15F3C] focus:outline-none focus:ring-0"
                    placeholder="••••••••"
                    {...register('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-[#A79E8E] transition hover:text-[#5C564C]"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between pt-0.5">
                <label htmlFor="remember-me" className="flex cursor-pointer items-center gap-2 text-sm text-[#8A8276]">
                  <input id="remember-me" name="remember-me" type="checkbox" className="h-3.5 w-3.5 rounded border-[#D9D1C0] text-[#C15F3C] focus:ring-0" />
                  Lembrar de mim
                </label>
                <Link to="/forgot-password" className="text-sm font-medium text-[#C15F3C] transition hover:text-[#DA7756]">
                  Esqueci a senha
                </Link>
              </div>

              <Button
                type="submit"
                className="w-full rounded-xl bg-[linear-gradient(135deg,#C15F3C_0%,#DA7756_100%)] py-3.5 text-sm font-bold text-white shadow-[0_8px_24px_rgba(193,95,60,0.28)] transition-all hover:brightness-105 focus:outline-none"
                size="lg"
                loading={isLoading}
              >
                {isLoading ? 'Entrando…' : 'Entrar'}
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-[#8A8276]">
              Não tem conta?{' '}
              <Link to="/register" className="font-semibold text-[#C15F3C] transition hover:text-[#DA7756]">
                Criar conta
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
