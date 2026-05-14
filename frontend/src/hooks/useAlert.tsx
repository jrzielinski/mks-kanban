import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertModal } from '@/components/ui/AlertModal';

interface AlertOptions {
  title?: string;
  message: string;
  type?: 'danger' | 'warning' | 'info' | 'success';
  okText?: string;
}

interface AlertContextType {
  showAlert: (options: AlertOptions | string) => Promise<void>;
  showSuccess: (message: string, title?: string) => Promise<void>;
  showError: (message: string, title?: string) => Promise<void>;
  showWarning: (message: string, title?: string) => Promise<void>;
  showInfo: (message: string, title?: string) => Promise<void>;
}

const AlertContext = createContext<AlertContextType | undefined>(undefined);

export const AlertProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { t } = useTranslation('common');
  const [isOpen, setIsOpen] = useState(false);
  const [alertOptions, setAlertOptions] = useState<AlertOptions>({
    title: t('useAlert.defaults.alert'),
    message: '',
    type: 'info',
    okText: t('useAlert.defaults.ok'),
  });
  const [resolvePromise, setResolvePromise] = useState<(() => void) | null>(null);

  const showAlert = useCallback((options: AlertOptions | string): Promise<void> => {
    return new Promise((resolve) => {
      const opts = typeof options === 'string' 
        ? { message: options, title: t('useAlert.defaults.notification'), type: 'info' as const }
        : options;
      
      setAlertOptions({
        title: opts.title || t('useAlert.defaults.notification'),
        message: opts.message,
        type: opts.type || 'info',
        okText: opts.okText || t('useAlert.defaults.ok'),
      });
      setIsOpen(true);
      setResolvePromise(() => resolve);
    });
  }, []);

  const showSuccess = useCallback((message: string, title?: string) => {
    return showAlert({
      title: title || t('useAlert.titles.success'),
      message,
      type: 'success',
      okText: t('useAlert.defaults.ok'),
    });
  }, [showAlert, t]);

  const showError = useCallback((message: string, title?: string) => {
    return showAlert({
      title: title || t('useAlert.titles.error'),
      message,
      type: 'danger',
      okText: t('useAlert.defaults.ok'),
    });
  }, [showAlert, t]);

  const showWarning = useCallback((message: string, title?: string) => {
    return showAlert({
      title: title || t('useAlert.titles.warning'),
      message,
      type: 'warning',
      okText: t('useAlert.defaults.ok'),
    });
  }, [showAlert, t]);

  const showInfo = useCallback((message: string, title?: string) => {
    return showAlert({
      title: title || t('useAlert.titles.info'),
      message,
      type: 'info',
      okText: t('useAlert.defaults.ok'),
    });
  }, [showAlert, t]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    if (resolvePromise) {
      resolvePromise();
      setResolvePromise(null);
    }
  }, [resolvePromise]);

  return (
    <AlertContext.Provider value={{ showAlert, showSuccess, showError, showWarning, showInfo }}>
      {children}
      <AlertModal
        isOpen={isOpen}
        onClose={handleClose}
        title={alertOptions.title || t('useAlert.defaults.alert')}
        message={alertOptions.message}
        type={alertOptions.type}
        okText={alertOptions.okText}
      />
    </AlertContext.Provider>
  );
};

export const useAlert = (): AlertContextType => {
  const context = useContext(AlertContext);
  if (!context) {
    throw new Error('useAlert must be used within AlertProvider');
  }
  return context;
};
