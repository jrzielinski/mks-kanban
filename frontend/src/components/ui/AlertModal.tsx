import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Info, CheckCircle, X } from 'lucide-react'
import { Button } from './Button'

interface AlertModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  message: string
  type?: 'danger' | 'warning' | 'info' | 'success'
  okText?: string
}

export const AlertModal: React.FC<AlertModalProps> = ({
  isOpen,
  onClose,
  title,
  message,
  type = 'info',
  okText = 'OK',
}) => {
  const getIcon = () => {
    switch (type) {
      case 'danger':
        return <AlertTriangle size={48} className="text-red-500" />
      case 'warning':
        return <AlertTriangle size={48} className="text-amber-500" />
      case 'success':
        return <CheckCircle size={48} className="text-green-500" />
      default:
        return <Info size={48} className="text-blue-500" />
    }
  }

  const getButtonVariant = () => {
    switch (type) {
      case 'danger':
        return 'danger'
      case 'warning':
        return 'warning'
      case 'success':
        return 'primary'
      default:
        return 'primary'
    }
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[10050] flex items-center justify-center">
        {/* Overlay */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />
        
        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          className="relative w-full max-w-md mx-4 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 pb-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <X size={20} className="text-gray-500" />
            </button>
          </div>
          
          {/* Content */}
          <div className="px-6 pb-6">
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0">
                {getIcon()}
              </div>
              <div className="flex-1">
                <p className="text-gray-600 dark:text-gray-300 leading-relaxed">
                  {message}
                </p>
              </div>
            </div>
          </div>
          
          {/* Actions */}
          <div className="flex items-center justify-end px-6 py-4 bg-gray-50 dark:bg-gray-750 rounded-b-xl border-t border-gray-200 dark:border-gray-700">
            <Button
              // @ts-ignore
              variant={getButtonVariant()}
              onClick={onClose}
              className="min-w-24"
            >
              {okText}
            </Button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  )
}
