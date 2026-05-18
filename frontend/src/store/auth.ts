import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import identityApi from '@/lib/identityApi'
import i18n from '@/lib/i18n'
import { User, AuthStore, LoginRequest, RegisterRequest } from '@/types'
import toast from 'react-hot-toast'

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: async (credentials: LoginRequest) => {
        try {
          const response = await identityApi.post('/auth/email/login', credentials)
          const { token, refreshToken, user } = response.data

          // token lives in zustand memory only — never persisted to localStorage
          localStorage.setItem('refreshToken', refreshToken)

          set({
            user,
            token,
            isAuthenticated: true,
          })

          toast.success(i18n.t('authStore.toasts.welcomeBack', {
            name: user.firstName || user.email,
          }))
        } catch (error: any) {
          if (error.response?.status === 403) {
            const errors = error.response.data?.errors
            const emailError = errors?.email || ''
            if (emailError === 'accountBanned') {
              toast.error(i18n.t('authStore.toasts.accountBanned'))
            } else if (emailError.startsWith('accountLocked:')) {
              const minutes = emailError.split(':')[1]
              toast.error(i18n.t('authStore.toasts.accountLocked', { minutes }))
            } else {
              toast.error(i18n.t('authStore.toasts.accessDenied'))
            }
          } else if (error.response?.status === 422) {
            const errors = error.response.data?.errors
            if (errors?.email === 'notFound') {
              toast.error(i18n.t('authStore.toasts.emailNotFound'))
            } else if (errors?.password === 'incorrectPassword') {
              toast.error(i18n.t('authStore.toasts.incorrectPassword'))
            } else {
              toast.error(i18n.t('authStore.toasts.invalidLoginData'))
            }
          } else {
            const message = error.response?.data?.message || i18n.t('authStore.toasts.loginError')
            toast.error(message)
          }
          throw error
        }
      },

      register: async (data: RegisterRequest) => {
        try {
          await identityApi.post('/auth/email/register', data)
          toast.success(i18n.t('authStore.toasts.registerSuccess'))
        } catch (error: any) {
          if (error.response?.status === 422) {
            const errors = error.response.data?.errors
            if (errors?.email === 'emailAlreadyExists') {
              toast.error(i18n.t('authStore.toasts.emailAlreadyExists'))
            } else {
              toast.error(i18n.t('authStore.toasts.invalidRegisterData'))
            }
          } else {
            const message = error.response?.data?.message || i18n.t('authStore.toasts.registerError')
            toast.error(message)
          }
          throw error
        }
      },

      logout: async () => {
        const { token } = get()
        try {
          await identityApi.post('/auth/logout', {}, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          })
        } catch {
          // ignore — local state is cleared regardless
        }

        localStorage.removeItem('refreshToken')
        localStorage.removeItem('analytics-session')

        set({
          user: null,
          token: null,
          isAuthenticated: false,
        })

        toast.success(i18n.t('authStore.toasts.logoutSuccess'))
      },

      setUser: (user: User) => {
        set({ user })
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        // token is NOT persisted — memory only (XSS mitigation)
      }),
      onRehydrateStorage: () => (state) => {
        // null out any stale token that may have been written by an older build
        if (state) state.token = null
      },
    }
  )
)
