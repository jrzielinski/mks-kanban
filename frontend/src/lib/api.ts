import axios, { AxiosError } from 'axios'
import toast from 'react-hot-toast'
import i18n from './i18n'
import identityApi from './identityApi'
import { useAuthStore } from '@/store/auth'

function getTenantIdFromDomain(): string {
  const hostname = window.location.hostname
  const parts = hostname.split('.')
  const subdomain = parts[0]

  if (subdomain === 'zielinski' || subdomain === 'app' || subdomain === 'api' || subdomain === 'www') {
    return 'staff'
  }

  if (subdomain === 'localhost' || subdomain.includes(':')) {
    return 'staff'
  }

  if (parts.length >= 2) {
    return subdomain
  }

  return 'staff'
}

const resolveBaseURL = (): string => {
  // @ts-ignore
  if (import.meta.env.DEV) return '/api/v1'
  // @ts-ignore
  return import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api/v1` : '/api/v1'
}

export const api = axios.create({
  baseURL: resolveBaseURL(),
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.request.use(
  (config) => {
    // Cai pro localStorage quando o store em memória ainda não foi semeado.
    // No embed (Electron), o desktop-token é injetado no localStorage ANTES
    // dos fetches, mas o seedAuth (que popula o store) é async — sem este
    // fallback o 1º fetch sai sem token → 404 / "Nenhum board".
    const token = useAuthStore.getState().token || localStorage.getItem('token')

    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }

    const tenantId = getTenantIdFromDomain()
    config.headers['X-Tenant-ID'] = tenantId

    if (!config.params) {
      config.params = {}
    }

    return config
  },
  (error) => Promise.reject(error)
)

let isRefreshing = false
let failedQueue: any[] = []

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach(prom => {
    if (error) prom.reject(error)
    else prom.resolve(token)
  })
  failedQueue = []
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as any
    const skipToast = originalRequest?._skipToast || false

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then(token => {
          originalRequest.headers['Authorization'] = 'Bearer ' + token
          return api(originalRequest)
        }).catch(err => Promise.reject(err))
      }

      originalRequest._retry = true
      isRefreshing = true

      const refreshToken = localStorage.getItem('refreshToken')

      if (refreshToken) {
        try {
          const response = await identityApi.post('/auth/refresh', {}, {
            headers: { Authorization: `Bearer ${refreshToken}` },
          })

          const { token: newToken, refreshToken: newRefreshToken } = response.data
          localStorage.setItem('refreshToken', newRefreshToken)
          useAuthStore.setState({ token: newToken })
          api.defaults.headers.common['Authorization'] = 'Bearer ' + newToken

          processQueue(null, newToken)
          return api(originalRequest)
        } catch (refreshError) {
          processQueue(refreshError, null)
          localStorage.removeItem('refreshToken')
          localStorage.removeItem('analytics-session')
          localStorage.removeItem('auth-storage')

          window.location.href = '/login'
          toast.error(i18n.t('apiErrors.sessionExpired'))
          return Promise.reject(refreshError)
        } finally {
          isRefreshing = false
        }
      } else {
        localStorage.removeItem('analytics-session')
        localStorage.removeItem('auth-storage')
        window.location.href = '/login'
        toast.error(i18n.t('apiErrors.sessionExpired'))
      }
    } else if (error.response?.status === 403) {
      if (!skipToast) toast.error(i18n.t('apiErrors.accessDenied'))
    } else if (error.response && error.response.status >= 500) {
      if (!skipToast) toast.error(i18n.t('apiErrors.serverError'))
    } else if (error.code === 'ECONNABORTED') {
      if (!skipToast) toast.error(i18n.t('apiErrors.requestTimeout'))
    } else if (!error.response) {
      if (!skipToast) toast.error(i18n.t('apiErrors.networkError'))
    }

    return Promise.reject(error)
  }
)

export default api
