import { useAuthStore } from '@/store/auth';

export interface KanbanAuthUser {
  id?: string | number;
  email?: string;
  firstName?: string;
  lastName?: string;
  tenantId?: string;
  [key: string]: unknown;
}

export interface AuthSession {
  token: string;
  refreshToken?: string;
  user: KanbanAuthUser;
}

export function seedAuth(auth: AuthSession): void {
  try {
    localStorage.setItem('token', auth.token);
    if (auth.refreshToken) localStorage.setItem('refreshToken', auth.refreshToken);
    localStorage.setItem('user', JSON.stringify(auth.user));
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({
        state: { user: auth.user, token: auth.token, isAuthenticated: true },
        version: 0,
      }),
    );
    useAuthStore.setState({
      user: auth.user as never,
      token: auth.token,
      isAuthenticated: true,
    });
  } catch {
    // localStorage unavailable (sandboxed context)
  }
}
