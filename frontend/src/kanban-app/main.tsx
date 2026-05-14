import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { ConfirmProvider } from '@/hooks/useConfirm';
import { AlertProvider } from '@/hooks/useAlert';
import { TenantProvider } from '@/contexts/TenantContext';
import { LicenseProvider } from '@/contexts/LicenseContext';
import { TutorialSettingsProvider } from '@/contexts/TutorialSettingsContext';
import { KanbanApp } from './KanbanApp';
import { setupOfflineInterceptors } from './setupOfflineInterceptors';
import { api } from '@/lib/api';
import '@/index.css';
import '@/lib/i18n';

// Phase 6 — offline resilience: cache GET /kanban/* and queue writes
setupOfflineInterceptors(api);

// Silence noisy ReactFlow / Recharts warnings (same filters the full app uses)
const originalWarn = console.warn;
console.warn = (...args) => {
  const message = args[0]?.toString() || '';
  if (message.includes('[React Flow]') && message.includes('nodeTypes')) return;
  if (message.includes('[React Flow]') && message.includes('edgeTypes')) return;
  if (message.includes('width(-1) and height(-1) of chart should be greater than 0')) return;
  originalWarn.apply(console, args);
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: (failureCount, error: any) => {
        if (error?.response?.status === 401) return false;
        if (error?.response?.status === 429) return false;
        return failureCount < 3;
      },
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
        </div>
      }
    >
      <QueryClientProvider client={queryClient}>
        <BrowserRouter
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true,
          }}
        >
          <TenantProvider>
            <LicenseProvider>
              <TutorialSettingsProvider>
                <AlertProvider>
                  <ConfirmProvider>
                    <KanbanApp />
                  </ConfirmProvider>
                </AlertProvider>
              </TutorialSettingsProvider>
            </LicenseProvider>
          </TenantProvider>
          <Toaster
            position="top-center"
            containerStyle={{ zIndex: 99999 }}
            toastOptions={{
              duration: 4000,
              style: {
                background: '#1f2937',
                color: '#f9fafb',
                borderRadius: '12px',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
              },
              success: { iconTheme: { primary: '#22c55e', secondary: '#f0fdf4' } },
              error: { iconTheme: { primary: '#ef4444', secondary: '#fef2f2' } },
            }}
          />
        </BrowserRouter>
      </QueryClientProvider>
    </Suspense>
  </React.StrictMode>,
);
