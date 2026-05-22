import axios, { AxiosInstance } from 'axios';
import { loadConfig, saveConfig } from '../config/config';
import { LoginResponse } from '../types';

let apiClient: AxiosInstance | null = null;

export function getApiClient(): AxiosInstance {
  if (apiClient) return apiClient;

  const config = loadConfig();
  const baseURL = config?.serverUrl || 'https://api.zielinski.dev.br';

  apiClient = axios.create({
    baseURL: `${baseURL}/api/v1`,
    timeout: 30_000,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // Add auth interceptor
  apiClient.interceptors.request.use((reqConfig) => {
    const currentConfig = loadConfig();
    if (currentConfig?.token) {
      reqConfig.headers.Authorization = `Bearer ${currentConfig.token}`;
    }
    return reqConfig;
  });

  return apiClient;
}

export async function login(
  email: string,
  password: string,
  serverUrl: string,
): Promise<LoginResponse> {
  const client = axios.create({
    baseURL: `${serverUrl}/api/v1`,
    timeout: 30_000,
  });

  const response = await client.post('/auth/email/login', { email, password });
  const data = response.data;

  saveConfig({
    serverUrl,
    token: data.token,
    refreshToken: data.refreshToken,
    userId: data.user?.id,
    tenantId: data.user?.tenantId,
    email: data.user?.email,
    sessionId: data.sessionId,
  });

  return data;
}

export async function refreshAuthToken(): Promise<boolean> {
  const config = loadConfig();
  if (!config?.refreshToken || !config?.serverUrl) return false;

  try {
    const client = axios.create({
      baseURL: `${config.serverUrl}/api/v1`,
      timeout: 30_000,
    });

    const response = await client.post('/auth/refresh', {}, {
      headers: { Authorization: `Bearer ${config.refreshToken}` },
    });

    saveConfig({
      ...config,
      token: response.data.token,
      refreshToken: response.data.refreshToken,
    });

    return true;
  } catch {
    return false;
  }
}
