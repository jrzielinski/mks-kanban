import { useEffect } from 'react'
import { useAuthStore } from '@/store/auth'
import api from '@/lib/api'

export const useAuthCheck = () => {
  const { token, setUser, logout } = useAuthStore()

  useEffect(() => {
    const checkAuth = async () => {
      if (!token) return

      try {
        const response = await api.get('/auth/me')
        setUser(response.data)
      } catch (error: any) {
        // Only logout if the token is definitively rejected (401)
        // Ignore transient errors like rate limiting (429), network issues, etc.
        if (error?.response?.status === 401) {
          logout()
        }
      }
    }

    checkAuth()
  }, [token, setUser, logout])
}