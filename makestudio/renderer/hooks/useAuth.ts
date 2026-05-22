import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { authApi, subscribe } from '../ipc/client';
import * as CH from '@shared/channels';
import type { AuthStatusDTO } from '@shared/types';

/**
 * Hook único pra estado de auth. Combina `useQuery` (snapshot inicial)
 * com subscribe ao broadcast `EVT_AUTH_CHANGED` (re-fetch quando o
 * main publica login/logout/refresh).
 *
 * Use no App.tsx pra gate de rotas e em pages que mostrem dados do user
 * (AccountPage, header avatar, etc).
 */
export function useAuth(): {
  data: AuthStatusDTO | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const qc = useQueryClient();
  const q = useQuery<AuthStatusDTO>({
    queryKey: ['auth', 'status'],
    queryFn: () => authApi.status(),
    staleTime: 30_000,
  });

  useEffect(() => {
    return subscribe<AuthStatusDTO>(CH.EVT_AUTH_CHANGED, (next) => {
      qc.setQueryData(['auth', 'status'], next);
    });
  }, [qc]);

  return { data: q.data, isLoading: q.isLoading, isError: q.isError };
}
