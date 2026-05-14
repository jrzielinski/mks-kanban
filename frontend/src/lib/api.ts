import axios, { AxiosError } from 'axios'
import toast from 'react-hot-toast'
import i18n from './i18n'
// Função para extrair tenantId do domínio - 100% compatível com TenantMiddleware backend
function getTenantIdFromDomain(): string {
  const hostname = window.location.hostname
  const parts = hostname.split('.')
  const subdomain = parts[0]

  // Default tenant for main domain
  if (subdomain === 'zielinski' || subdomain === 'app' || subdomain === 'api' || subdomain === 'www') {
    return 'staff'
  }

  // Development environment
  if (subdomain === 'localhost' || subdomain.includes(':')) {
    return 'staff'
  }

  // Use subdomain as tenant ID (ex: cliente1.zielinski.dev.br -> cliente1)
  if (parts.length >= 2) {
    return subdomain
  }

  return 'staff' // Fallback para casos não esperados
}

const resolveBaseURL = (): string => {
  // In dev mode, always use relative URL so Vite proxy handles CORS
  // @ts-ignore
  if (import.meta.env.DEV) return '/api/v1'
  // In production, use env var or default
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

// Request interceptor to add auth token and tenant isolation
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token')

    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }

    // 🏢 TENANT ISOLATION: Adicionar tenantId automaticamente (100% compatível com backend)
    const tenantId = getTenantIdFromDomain()

    // O backend usa principalmente o header X-Tenant-ID
    config.headers['X-Tenant-ID'] = tenantId

    // Note: Can't manually set Host header due to browser security restrictions
    // The backend will use req.headers.host automatically from the request

    // Adicionar tenantId nos parâmetros apenas se explicitamente necessário
    if (!config.params) {
      config.params = {}
    }

    // Não adicionar tenantId no body automaticamente para evitar conflitos
    // O backend extrai via decorator @TenantId() do request, não do body

    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Flag to prevent multiple refresh attempts
let isRefreshing = false;
let failedQueue: any[] = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });

  failedQueue = [];
};

// Response interceptor for error handling with auto-refresh
api.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as any;
    const skipToast = originalRequest?._skipToast || false;

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise(function(resolve, reject) {
          failedQueue.push({ resolve, reject });
        }).then(token => {
          originalRequest.headers['Authorization'] = 'Bearer ' + token;
          return api(originalRequest);
        }).catch(err => {
          return Promise.reject(err);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = localStorage.getItem('refreshToken');

      if (refreshToken) {
        try {
          const response = await axios.post(`${api.defaults.baseURL}/auth/refresh`, {}, {
            headers: {
              Authorization: `Bearer ${refreshToken}`
            }
          });

          const { token: newToken, refreshToken: newRefreshToken } = response.data;
          localStorage.setItem('token', newToken);
          localStorage.setItem('refreshToken', newRefreshToken);
          api.defaults.headers.common['Authorization'] = 'Bearer ' + newToken;

          processQueue(null, newToken);

          return api(originalRequest);
        } catch (refreshError) {
          processQueue(refreshError, null);
          localStorage.removeItem('token');
          localStorage.removeItem('refreshToken');
          localStorage.removeItem('user');
          localStorage.removeItem('analytics-session');
          localStorage.removeItem('auth-storage'); // Reset Zustand persist so isAuthenticated becomes false

          window.location.href = '/login';
          toast.error(i18n.t('apiErrors.sessionExpired'));
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      } else {
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        localStorage.removeItem('analytics-session');
        localStorage.removeItem('auth-storage'); // Reset Zustand persist so isAuthenticated becomes false
        window.location.href = '/login';
        toast.error(i18n.t('apiErrors.sessionExpired'));
      }
    } else if (error.response?.status === 403) {
      if (!skipToast) toast.error(i18n.t('apiErrors.accessDenied'));
    } else if (error.response && error.response.status >= 500) {
      if (!skipToast) toast.error(i18n.t('apiErrors.serverError'));
    } else if (error.code === 'ECONNABORTED') {
      if (!skipToast) toast.error(i18n.t('apiErrors.requestTimeout'));
    } else if (!error.response) {
      if (!skipToast) toast.error(i18n.t('apiErrors.networkError'));
    }

    return Promise.reject(error);
  }
)

export default api
