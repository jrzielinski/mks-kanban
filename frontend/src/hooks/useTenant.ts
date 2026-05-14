import { useState, useEffect } from 'react'

export interface TenantInfo {
  tenantId: string
  subdomain: string
  domain: string
  isProduction: boolean
}

/**
 * Hook para extrair informações do tenant baseado no domínio
 * Exemplos:
 * - cliente1.zielinski.dev.br -> tenant: cliente1
 * - cop.zielinski.dev.br -> tenant: cop
 * - localhost:3000 -> tenant: default (desenvolvimento)
 */
export const useTenant = (): TenantInfo => {
  const [tenantInfo, setTenantInfo] = useState<TenantInfo>(() => {
    return extractTenantFromDomain()
  })

  useEffect(() => {
    // Atualizar se o domínio mudar (raro, mas possível em SPAs)
    const newTenantInfo = extractTenantFromDomain()
    if (newTenantInfo.tenantId !== tenantInfo.tenantId) {
      setTenantInfo(newTenantInfo)
    }
  }, [])

  return tenantInfo
}

function extractTenantFromDomain(): TenantInfo {
  const hostname = window.location.hostname
  // @ts-ignore
  const protocol = window.location.protocol
  const port = window.location.port
  const parts = hostname.split('.')
  const subdomain = parts[0]

  // Default tenant for main domain - EXATAMENTE como backend
  if (subdomain === 'lumina' || subdomain === 'app' || subdomain === 'api') {
    return {
      tenantId: 'staff',
      subdomain,
      domain: parts.slice(1).join('.'),
      isProduction: true
    }
  }

  // Development environment - EXATAMENTE como backend
  if (subdomain === 'localhost' || subdomain.includes(':')) {
    // No frontend não temos acesso ao header X-Tenant-ID aqui, 
    // mas o api.ts vai enviar o correto
    return {
      tenantId: 'staff', // fallback para desenvolvimento
      subdomain: 'localhost',
      domain: hostname + (port ? `:${port}` : ''),
      isProduction: false
    }
  }

  // Use subdomain as tenant ID - EXATAMENTE como backend
  if (parts.length >= 2) {
    // cliente1.zielinski.dev.br -> tenantId: cliente1
    // OU even cliente1.localhost -> tenantId: cliente1
    const mainDomain = parts.slice(1).join('.')

    return {
      tenantId: subdomain,
      subdomain,
      domain: mainDomain,
      isProduction: parts.length >= 3
    }
  }

  // Fallback para casos não esperados
  return {
    tenantId: 'staff', // Mesmo fallback do backend
    subdomain: '',
    domain: hostname,
    isProduction: false
  }
}

export default useTenant