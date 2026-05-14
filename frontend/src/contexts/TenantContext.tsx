import React, { createContext, useContext, useEffect, useState } from 'react'
import { TenantInfo, useTenant } from '@/hooks/useTenant'

interface TenantContextValue extends TenantInfo {
  // Método para forçar atualização se necessário
  refreshTenant: () => void
}

const TenantContext = createContext<TenantContextValue | undefined>(undefined)

export const useTenantContext = () => {
  const context = useContext(TenantContext)
  if (!context) {
    throw new Error('useTenantContext deve ser usado dentro de um TenantProvider')
  }
  return context
}

interface TenantProviderProps {
  children: React.ReactNode
}

export const TenantProvider: React.FC<TenantProviderProps> = ({ children }) => {
  const tenantInfo = useTenant()
  const [currentTenant, setCurrentTenant] = useState<TenantInfo>(tenantInfo)

  const refreshTenant = () => {
    const newTenantInfo = useTenant()
    setCurrentTenant(newTenantInfo)
  }

  useEffect(() => {
    // Atualizar contexto se tenant mudar
    if (tenantInfo.tenantId !== currentTenant.tenantId) {
      setCurrentTenant(tenantInfo)
    }
  }, [tenantInfo.tenantId])

  const value: TenantContextValue = {
    ...currentTenant,
    refreshTenant
  }

  return (
    <TenantContext.Provider value={value}>
      {children}
    </TenantContext.Provider>
  )
}

export default TenantProvider