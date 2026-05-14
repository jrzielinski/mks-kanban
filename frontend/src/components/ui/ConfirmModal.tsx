import React from 'react';
import { useTranslation } from 'react-i18next';
import { XMarkIcon, ExclamationTriangleIcon, TrashIcon, InformationCircleIcon } from '@heroicons/react/24/outline';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onCancel?: () => void;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  details?: React.ReactNode;
  /** When set, shows a text input and the confirm button stays disabled until the user types this exact value */
  typeToConfirm?: string;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  // @ts-ignore
  onCancel,
  title,
  message,
  confirmText,
  cancelText,
  variant = 'warning',
  details,
  typeToConfirm,
}) => {
  const { t } = useTranslation('common');
  const resolvedConfirmText = confirmText ?? t('confirmModal.confirm');
  const resolvedCancelText = cancelText ?? t('actions.cancel');
  const [typedValue, setTypedValue] = React.useState('');

  React.useEffect(() => {
    if (isOpen) setTypedValue('');
  }, [isOpen]);

  const canConfirm = !typeToConfirm || typedValue === typeToConfirm;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm();
  };

  const handleCancel = () => {
    onClose();
  };

  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      icon: TrashIcon,
      iconBg: 'bg-red-100 dark:bg-red-900/20',
      iconColor: 'text-red-600 dark:text-red-400',
      confirmBtn: 'bg-red-600 hover:bg-red-700',
    },
    warning: {
      icon: ExclamationTriangleIcon,
      iconBg: 'bg-yellow-100 dark:bg-yellow-900/20',
      iconColor: 'text-yellow-600 dark:text-yellow-400',
      confirmBtn: 'bg-yellow-600 hover:bg-yellow-700',
    },
    info: {
      icon: InformationCircleIcon,
      iconBg: 'bg-blue-100 dark:bg-blue-900/20',
      iconColor: 'text-blue-600 dark:text-blue-400',
      confirmBtn: 'bg-blue-600 hover:bg-blue-700',
    }
  };

  const config = variantStyles[variant];
  const Icon = config.icon;

  // Prevent keyboard events from bubbling to global handlers
  const handleKeyboardEvent = (e: React.KeyboardEvent) => {
    e.stopPropagation();
  };

  return (
    <div className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/50">
      <div
        className="mx-4 w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-gray-800"
        onKeyDown={handleKeyboardEvent}
        onKeyUp={handleKeyboardEvent}
      >
        <div className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <div className={`w-12 h-12 ${config.iconBg} rounded-full flex items-center justify-center`}>
                  <Icon className={`w-6 h-6 ${config.iconColor}`} />
                </div>
              </div>
              <div className="ml-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {title || t('confirmModal.defaultTitle')}
                </h3>
              </div>
            </div>

            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              <XMarkIcon className="w-5 h-5" />
            </button>
          </div>

          {/* Message */}
          <p className="text-gray-700 dark:text-gray-300 mb-4">
            {message}
          </p>

          {/* Details (optional) */}
          {details && (
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-6">
              {details}
            </div>
          )}

          {/* Type-to-confirm input */}
          {typeToConfirm && (
            <div className="mb-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                {t('confirmModal.typeToConfirmPrefix')} <span className="font-semibold text-gray-900 dark:text-white">"{typeToConfirm}"</span> {t('confirmModal.typeToConfirmSuffix')}
              </p>
              <input
                type="text"
                value={typedValue}
                onChange={(e) => setTypedValue(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && canConfirm) handleConfirm(); }}
                placeholder={typeToConfirm}
                autoFocus
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:border-red-400 focus:ring-1 focus:ring-red-400/30"
              />
            </div>
          )}

          {/* Buttons */}
          <div className="flex space-x-3">
            <button
              onClick={handleCancel}
              className="flex-1 px-4 py-2 bg-gray-600 text-white rounded-lg font-medium hover:bg-gray-700 transition-colors"
            >
              {resolvedCancelText}
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className={`flex-1 px-4 py-2 ${config.confirmBtn} text-white rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {resolvedConfirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
