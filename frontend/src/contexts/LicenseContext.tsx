import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';

// Types
export interface LicenseFeatures {
  flows: boolean;
  whatsapp: boolean;
  ai: boolean;
  bankReconciliation: boolean;
  customNodes: boolean;
  apiAccess: boolean;
  sso: boolean;
  multiTenant: boolean;
}

export interface LicenseLimits {
  maxUsers: number;
  maxFlows: number;
  maxExecutionsPerMonth: number;
  maxWhatsappNumbers: number;
  maxStorageGB: number;
  maxApiCallsPerDay: number;
}

export interface LicenseConfig {
  planType: string;
  customerName: string;
  expiresAt: string;
  daysUntilExpiration: number;
  features: LicenseFeatures;
  limits: LicenseLimits;
}

export interface LicenseStatus {
  isValid: boolean;
  planType: string;
  expiresAt?: string;
  daysUntilExpiration?: number;
}

interface LicenseContextValue {
  isLoading: boolean;
  isLicenseValid: boolean;
  config: LicenseConfig | null;
  status: LicenseStatus | null;
  error: string | null;

  // Helper methods
  hasFeature: (featureName: keyof LicenseFeatures) => boolean;
  getLimit: (limitName: keyof LicenseLimits) => number;
  isFeatureEnabled: (featureName: keyof LicenseFeatures) => boolean;
  checkLimit: (limitName: keyof LicenseLimits, currentUsage: number) => boolean;

  // Refetch
  refetch: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue | undefined>(undefined);

interface LicenseProviderProps {
  children: ReactNode;
}

export const LicenseProvider: React.FC<LicenseProviderProps> = ({
  children,
}) => {
  // @ts-ignore
  const { t } = useTranslation('flow-builder');
  const [isLoading, setIsLoading] = useState(true);
  const [config, setConfig] = useState<LicenseConfig | null>(null);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchLicenseInfo = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Fetch config and status in parallel
      const [configRes, statusRes] = await Promise.all([
        axios.get('/api/v1/licensing/config'),
        axios.get('/api/v1/licensing/status'),
      ]);

      if (configRes.data.success) {
        setConfig(configRes.data.config);
      } else {
        setConfig(null);
        setError(configRes.data.message || 'License not configured');
      }

      if (statusRes.data.success) {
        setStatus({
          isValid: statusRes.data.isValid,
          planType: statusRes.data.planType,
          expiresAt: statusRes.data.expiresAt,
          daysUntilExpiration: statusRes.data.daysUntilExpiration,
        });
      }
    } catch (err: any) {
      console.error('Failed to fetch license info:', err);
      setError(err.response?.data?.message || 'Failed to fetch license info');
      setConfig(null);
      setStatus(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLicenseInfo();

    // Refetch every 5 minutes
    const interval = setInterval(fetchLicenseInfo, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  const hasFeature = (featureName: keyof LicenseFeatures): boolean => {
    if (!config) return false;
    return config.features[featureName] === true;
  };

  const isFeatureEnabled = (featureName: keyof LicenseFeatures): boolean => {
    return hasFeature(featureName);
  };

  const getLimit = (limitName: keyof LicenseLimits): number => {
    if (!config) return 0;
    return config.limits[limitName] || 0;
  };

  const checkLimit = (limitName: keyof LicenseLimits, currentUsage: number): boolean => {
    const limit = getLimit(limitName);

    // -1 means unlimited
    if (limit === -1) return true;

    return currentUsage < limit;
  };

  const value: LicenseContextValue = {
    isLoading,
    isLicenseValid: status?.isValid || false,
    config,
    status,
    error,
    hasFeature,
    getLimit,
    isFeatureEnabled,
    checkLimit,
    refetch: fetchLicenseInfo,
  };

  return (
    <LicenseContext.Provider value={value}>
      {children}
    </LicenseContext.Provider>
  );
};

/**
 * Hook to access license information
 *
 * @example
 * ```tsx
 * const { isLicenseValid, hasFeature, getLimit } = useLicense();
 *
 * if (!hasFeature('ai')) {
 *   return <UpgradePrompt feature="AI" />;
 * }
 *
 * const maxFlows = getLimit('maxFlows');
 * if (currentFlows >= maxFlows) {
 *   return <LimitReached limit="flows" />;
 * }
 * ```
 */
export const useLicense = (): LicenseContextValue => {
  const context = useContext(LicenseContext);

  if (!context) {
    throw new Error('useLicense must be used within a LicenseProvider');
  }

  return context;
};

/**
 * HOC to protect routes/components that require a feature
 *
 * @example
 * ```tsx
 * export default withFeature('ai')(AIChat);
 * ```
 */
export function withFeature<P extends object>(
  featureName: keyof LicenseFeatures,
  fallback?: React.ComponentType<P>
) {
  return (Component: React.ComponentType<P>) => {
    const WrappedComponent: React.FC<P> = (props) => {
      const { hasFeature, isLoading } = useLicense();

      if (isLoading) {
        return (
          <div className="flex items-center justify-center h-screen">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              {/* @ts-ignore */}
              <p className="text-gray-600">{t('nodes.licenseContext.tsx.verificandoLicenca')}</p>
            </div>
          </div>
        );
      }

      if (!hasFeature(featureName)) {
        if (fallback) {
          const FallbackComponent = fallback;
          return <FallbackComponent {...props} />;
        }

        return (
          <div className="flex items-center justify-center h-screen">
            <div className="text-center max-w-md p-8 bg-white rounded-lg shadow-lg">
              <div className="text-6xl mb-4">🔒</div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                Recurso não disponível
              </h2>
              <p className="text-gray-600 mb-4">
                O recurso "<strong>{featureName}</strong>" não está disponível no seu plano atual.
              </p>
              <button
                onClick={() => window.location.href = '/settings/license'}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition"
              >
                Fazer upgrade
              </button>
            </div>
          </div>
        );
      }

      return <Component {...props} />;
    };

    WrappedComponent.displayName = `withFeature(${featureName})(${
      Component.displayName || Component.name || 'Component'
    })`;

    return WrappedComponent;
  };
}
