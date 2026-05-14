import React, { useState, useEffect, useRef } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion } from 'framer-motion'
import { Mail, Lock, Eye, EyeOff, CheckCircle, LogIn, Sparkles, ShieldCheck, Workflow, Rocket } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useAuthStore } from '@/store/auth'
import { LoginRequest } from '@/types'
import { useTenant } from '@/hooks/useTenant'
// import { useCustomLoginPages, PublicLoginPageData } from '@/hooks/useCustomLoginPages'
// import { LoginPageRenderer } from '@/components/custom-login/LoginPageRenderer'
type PublicLoginPageData = any // Temporary type

type LoginForm = { email: string; password: string }

export const Login: React.FC = () => {
  const { t } = useTranslation('common')
  const loginSchema = z.object({
    email: z.string().email(t('auth.login.validation.email')),
    password: z.string().min(6, t('auth.login.validation.password')),
  })
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')
  const [showSignIn, setShowSignIn] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { login } = useAuthStore()
  const signInSectionRef = useRef<HTMLDivElement | null>(null)

  // Custom login page detection - DISABLED
  const tenantInfo = useTenant()
  // const { fetchPublicPageByTenantId } = useCustomLoginPages()
  // @ts-ignore
  const [customLoginPage, setCustomLoginPage] = useState<PublicLoginPageData | null>(null)
  // @ts-ignore
  const [isLoadingCustomPage, setIsLoadingCustomPage] = useState(false) // Changed to false
  const [tenantLogo, setTenantLogo] = useState<string | null>(null)

  // Load custom login page for current tenant - DISABLED
  /*
  useEffect(() => {
    const loadCustomLoginPage = async () => {
      try {
        setIsLoadingCustomPage(true)

        // Only try to load custom page for non-staff tenants
        if (tenantInfo.tenantId && tenantInfo.tenantId !== 'staff') {
          const customPage = await fetchPublicPageByTenantId(tenantInfo.tenantId)
          setCustomLoginPage(customPage)
        }
      } catch (error) {
        console.error('Erro ao carregar página de login customizada:', error)
        setCustomLoginPage(null)
      } finally {
        setIsLoadingCustomPage(false)
      }
    }

    loadCustomLoginPage()
  }, [tenantInfo.tenantId])
  */

  // Fetch tenant logo
  useEffect(() => {
    const fetchTenantLogo = async () => {
      try {
        // Only fetch for non-staff tenants
        if (tenantInfo.tenantId && tenantInfo.tenantId !== 'staff') {
          const response = await fetch(`/api/v1/public/tenants/${tenantInfo.tenantId}/logo`)
          if (response.ok) {
            const data = await response.json()
            if (data.logo_base64) {
              // Add data:image prefix if not present
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
    // Check for success message from location state
    if (location.state?.message) {
      setSuccessMessage(location.state.message)
      // Clear the message after 5 seconds
      setTimeout(() => setSuccessMessage(''), 5000)
    }
  }, [location.state])

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema)
  })

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

  const fillDevCredentials = () => {
    setValue('email', 'admin@zielinski.dev.br')
    setValue('password', 'password@123')
  }

  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

  const focusSignIn = () => {
    setShowSignIn(true)
    signInSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Handle login from custom page
  // @ts-ignore
  const handleCustomLogin = async (email: string, password: string) => {
    setIsLoading(true)
    try {
      const loginData: LoginRequest = { email, password }
      await login(loginData)
      navigate('/dashboard')
    } catch (error) {
      console.error('Erro no login customizado:', error)
    } finally {
      setIsLoading(false)
    }
  }

  // Show loading while checking for custom page - DISABLED
  /*
  if (isLoadingCustomPage) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  // Render custom login page if available - DISABLED
  if (customLoginPage) {
    return (
      <div className="min-h-screen w-full">
        <LoginPageRenderer
          pageData={customLoginPage.page_data}
          customCSS={customLoginPage.custom_css}
          customJS={customLoginPage.custom_js}
          onLogin={handleCustomLogin}
          isPreview={false}
          className="w-full h-screen"
        />
      </div>
    )
  }
  */


  return (
    <div className="relative min-h-screen overflow-hidden">

      {/* ── FULL BLEED BACKGROUND ── */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat scale-105"
        style={{ backgroundImage: "url('/world_background.jpg')" }}
      />

      {/* Left: subtle dark veil so text is readable over the globe */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,8,20,0.55)_0%,rgba(0,8,20,0.30)_40%,rgba(0,8,20,0.88)_62%,rgba(0,8,20,0.98)_100%)]" />

      {/* Extra bottom vignette */}
      <div className="absolute bottom-0 left-0 right-0 h-48 bg-[linear-gradient(to_top,rgba(0,8,20,0.9),transparent)]" />

      {/* ── LAYOUT ── */}
      <div className="relative flex min-h-screen">

        {/* LEFT — branding over the world image */}
        <div className="hidden lg:flex lg:w-[55%] flex-col justify-between p-12 xl:p-16">

          {/* Logo top-left */}
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55 }}
          >
            <div className="inline-flex items-center gap-3">
              {tenantLogo && (
                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white/90 shadow-lg">
                  <img src={tenantLogo} alt="Logo" className="max-h-8 max-w-8 object-contain" />
                </div>
              )}
              <span className="text-[2rem] font-extrabold tracking-tight text-white drop-shadow-[0_1px_14px_rgba(0,0,0,0.72)] xl:text-[2.15rem]">
                MakeStudio
              </span>
            </div>
          </motion.div>

          {/* Center hero */}
          <motion.div
            initial={{ opacity: 0, x: -28 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1, duration: 0.7 }}
          >
            <div className="mb-6 flex items-center gap-2">
              <div className="h-px w-8 bg-cyan-400" />
              <span className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-300">
                {t('auth.login.heroTag')}
              </span>
            </div>

            <h2 className="text-[3.4rem] xl:text-[4rem] font-bold leading-[1.05] tracking-tight text-white">
              {t('auth.login.heroHeadline1')}<br />
              <span className="text-transparent bg-clip-text bg-[linear-gradient(90deg,#22d3ee_0%,#60a5fa_60%,#a78bfa_100%)]">
                {t('auth.login.heroHeadline2')}
              </span>
              <br />
              <span className="text-transparent bg-clip-text bg-[linear-gradient(90deg,#60a5fa_0%,#a78bfa_100%)]">
                {t('auth.login.heroHeadline3')}
              </span>
            </h2>

            <p className="mt-5 max-w-sm text-base leading-7 text-slate-300/85">
              {t('auth.login.heroSubtext')}
            </p>

            <div className="mt-10 flex items-center gap-6">
              {[
                { icon: ShieldCheck, label: t('auth.login.featureSecure') },
                { icon: Workflow,    label: t('auth.login.featureIntegrated') },
                { icon: Rocket,      label: t('auth.login.featureScalable') },
              ].map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center gap-2 text-slate-300">
                  <Icon className="h-4 w-4 text-cyan-400" />
                  <span className="text-sm font-medium">{label}</span>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Bottom status pill */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2.5 rounded-full border border-white/10 bg-black/35 px-4 py-2 backdrop-blur-md">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span className="text-xs font-medium text-slate-300">
                {t('auth.login.statusPill')}
              </span>
            </div>
          </motion.div>

        </div>

        {/* RIGHT — form, directly in the dark area, no floating card */}
        <div className="flex w-full items-center justify-center px-6 py-8 sm:px-10 lg:w-[45%]">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-[400px] lg:max-h-[calc(100vh-64px)] lg:overflow-y-auto lg:pr-1"
          >

            {/* Mobile logo */}
            <div className="mb-10 lg:hidden">
              <span className="text-xl font-bold text-white">MakeStudio</span>
            </div>

            {!showSignIn ? (
              <>
                <div className="mb-8">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-400/70">
                    {t('auth.login.getStartedTag')}
                  </p>
                  <h2 className="text-3xl font-bold tracking-tight text-white">{t('auth.login.getStartedHeadline')}</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    {t('auth.login.getStartedSubtext')}
                  </p>
                </div>

                <div className="mb-7 space-y-3">
                  <Link
                    to="/register"
                    className="flex w-full items-center justify-center rounded-xl bg-[linear-gradient(135deg,#22d3ee_0%,#2563eb_100%)] px-4 py-3.5 text-sm font-bold text-white shadow-[0_8px_32px_rgba(34,211,238,0.22)] transition-all hover:shadow-[0_12px_40px_rgba(34,211,238,0.35)] hover:brightness-110"
                  >
                    {t('auth.login.ctaRegister')}
                  </Link>
                  <button
                    type="button"
                    onClick={focusSignIn}
                    className="flex w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-white/[0.08]"
                  >
                    {t('auth.login.ctaAlreadyHave')}
                  </button>
                  <p className="text-center text-xs text-slate-500">{t('auth.login.noCardText')}</p>
                </div>

                <div className="mb-8 grid gap-3 sm:grid-cols-3">
                  {[
                    { icon: Rocket, label: t('auth.login.featureSetup') },
                    { icon: Sparkles, label: t('auth.login.featureAI') },
                    { icon: Workflow, label: t('auth.login.featureApis') },
                  ].map(({ icon: Icon, label }) => (
                    <div
                      key={label}
                      className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3 text-sm text-slate-300 backdrop-blur-sm"
                    >
                      <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-300">
                        <Icon className="h-4 w-4" />
                      </div>
                      <p className="leading-5">{label}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div ref={signInSectionRef} className="mt-8">
                <div className="mb-8">
                  <button
                    type="button"
                    onClick={() => setShowSignIn(false)}
                    className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-400/70 transition hover:text-cyan-300"
                  >
                    {t('auth.login.back')}
                  </button>
                  <div className="mb-2 flex items-center gap-2 text-slate-200">
                    <LogIn className="h-4 w-4 text-cyan-300" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-400/70">{t('auth.login.workspaceAccess')}</span>
                  </div>
                  <h2 className="text-3xl font-bold tracking-tight text-white">{t('auth.login.signInHeadline')}</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    {t('auth.login.signInSubtext')}
                  </p>
                </div>

                {isLocalhost && (
                  <motion.button
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    onClick={fillDevCredentials}
                    className="mb-6 inline-flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/8 px-4 py-2 text-xs font-semibold text-amber-300 transition hover:bg-amber-400/15"
                    type="button"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {t('auth.login.devFillBtn')}
                  </motion.button>
                )}

                {successMessage && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-5 flex items-center rounded-xl border border-emerald-400/20 bg-emerald-400/8 px-4 py-3"
                  >
                    <CheckCircle size={15} className="mr-2 flex-shrink-0 text-emerald-400" />
                    <span className="text-sm text-emerald-200">{successMessage}</span>
                  </motion.div>
                )}

                <form className="space-y-5" onSubmit={handleSubmit(onSubmit)}>
                  {(errors.email || errors.password) && (
                    <div className="rounded-xl border border-rose-400/20 bg-rose-400/8 px-4 py-3 text-sm text-rose-300">
                      {errors.email?.message || errors.password?.message}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label htmlFor="email" className="block text-sm font-medium text-slate-300">
                      {t('auth.login.emailLabel')}
                    </label>
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                        <Mail className="h-4 w-4 text-slate-500" />
                      </div>
                      <input
                        id="email"
                        type="email"
                        autoComplete="email"
                        className="w-full rounded-xl border border-white/10 bg-white/[0.06] py-3 pl-10 pr-4 text-sm text-white placeholder:text-slate-600 transition-all focus:border-cyan-500/60 focus:bg-white/10 focus:outline-none focus:ring-0"
                        placeholder={t('auth.login.emailPlaceholder')}
                        {...register('email')}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="password" className="block text-sm font-medium text-slate-300">
                      {t('auth.login.passwordLabel')}
                    </label>
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                        <Lock className="h-4 w-4 text-slate-500" />
                      </div>
                      <input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        className="w-full rounded-xl border border-white/10 bg-white/[0.06] py-3 pl-10 pr-11 text-sm text-white placeholder:text-slate-600 transition-all focus:border-cyan-500/60 focus:bg-white/10 focus:outline-none focus:ring-0"
                        placeholder="••••••••"
                        {...register('password')}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-500 transition hover:text-slate-300"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-0.5">
                    <label htmlFor="remember-me" className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
                      <input
                        id="remember-me"
                        name="remember-me"
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 text-cyan-500 focus:ring-0"
                      />
                      {t('auth.login.rememberMe')}
                    </label>
                    <Link to="/forgot-password" className="text-sm text-cyan-400 transition hover:text-cyan-200">
                      {t('auth.login.forgotPassword')}
                    </Link>
                  </div>

                  <Button
                    type="submit"
                    className="w-full rounded-xl bg-white/10 py-3.5 text-sm font-bold text-white shadow-[0_8px_24px_rgba(2,6,23,0.22)] transition-all hover:bg-white/15 hover:shadow-[0_12px_32px_rgba(2,6,23,0.3)] focus:outline-none"
                    size="lg"
                    loading={isLoading}
                  >
                    {isLoading ? t('auth.login.loadingText') : t('auth.login.signInBtn')}
                  </Button>
                </form>

                <p className="mt-6 text-center text-[11px] leading-5 text-slate-600">
                  {t('auth.login.termsPrefix')}{' '}
                  <a href="#" className="text-slate-500 hover:text-slate-300 transition">{t('auth.login.termsOfService')}</a>
                  {' '}{t('auth.login.termsAnd')}{' '}
                  <a href="#" className="text-slate-500 hover:text-slate-300 transition">{t('auth.login.privacyPolicy')}</a>.
                </p>
              </div>
            )}

          </motion.div>
        </div>
      </div>
    </div>
  )
}
