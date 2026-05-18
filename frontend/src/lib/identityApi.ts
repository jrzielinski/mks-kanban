import axios from 'axios'

const resolveBaseURL = (): string => {
  // @ts-ignore
  const base = import.meta.env.VITE_IDENTITY_URL ?? 'http://localhost:3030'
  return `${base}/api/v1`
}

export const identityApi = axios.create({
  baseURL: resolveBaseURL(),
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})

export default identityApi
