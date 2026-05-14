import React, { createContext, useContext, useState, ReactNode } from 'react'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { AlertModal } from '@/components/ui/AlertModal'

interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  type?: 'danger' | 'warning' | 'info' | 'success'
  typeToConfirm?: string
}

interface AlertOptions {
  title: string
  message: string
  okText?: string
  type?: 'danger' | 'warning' | 'info' | 'success'
}

interface ConfirmContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  alert: (options: AlertOptions) => Promise<void>
}

const ConfirmContext = createContext<ConfirmContextType | undefined>(undefined)

export const ConfirmProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false)
  const [isAlertOpen, setIsAlertOpen] = useState(false)
  const [confirmOptions, setConfirmOptions] = useState<ConfirmOptions | null>(null)
  const [alertOptions, setAlertOptions] = useState<AlertOptions | null>(null)
  // @ts-ignore
  const [loading, setLoading] = useState(false)
  const [confirmResolver, setConfirmResolver] = useState<((value: boolean) => void) | null>(null)
  const [alertResolver, setAlertResolver] = useState<(() => void) | null>(null)

  const confirm = (options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmOptions(options)
      setConfirmResolver(() => resolve)
      setIsConfirmOpen(true)
      setLoading(false)
    })
  }

  const alert = (options: AlertOptions): Promise<void> => {
    return new Promise((resolve) => {
      setAlertOptions(options)
      setAlertResolver(() => resolve)
      setIsAlertOpen(true)
    })
  }

  const handleConfirm = async () => {
    setLoading(true)
    
    // Pequeno delay para mostrar o loading
    await new Promise(resolve => setTimeout(resolve, 300))
    
    setIsConfirmOpen(false)
    setLoading(false)
    
    if (confirmResolver) {
      confirmResolver(true)
      setConfirmResolver(null)
    }
  }

  const handleCancel = () => {
    setIsConfirmOpen(false)
    setLoading(false)
    
    if (confirmResolver) {
      confirmResolver(false)
      setConfirmResolver(null)
    }
  }

  const handleAlertClose = () => {
    setIsAlertOpen(false)
    
    if (alertResolver) {
      alertResolver()
      setAlertResolver(null)
    }
  }

  return (
    <ConfirmContext.Provider value={{ confirm, alert }}>
      {children}
      {confirmOptions && (
        <ConfirmModal
          isOpen={isConfirmOpen}
          onClose={handleCancel}
          onConfirm={handleConfirm}
          title={confirmOptions.title}
          message={confirmOptions.message}
          confirmText={confirmOptions.confirmText}
          cancelText={confirmOptions.cancelText}
          // @ts-ignore
          variant={confirmOptions.type}
          typeToConfirm={confirmOptions.typeToConfirm}
        />
      )}
      {alertOptions && (
        <AlertModal
          isOpen={isAlertOpen}
          onClose={handleAlertClose}
          title={alertOptions.title}
          message={alertOptions.message}
          okText={alertOptions.okText}
          type={alertOptions.type}
        />
      )}
    </ConfirmContext.Provider>
  )
}

export const useConfirm = () => {
  const context = useContext(ConfirmContext)
  if (!context) {
    throw new Error('useConfirm must be used within a ConfirmProvider')
  }
  return context
}