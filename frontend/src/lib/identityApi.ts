import axios from 'axios'

const resolveBaseURL = (): string => {
  // @ts-ignore — VITE env var é substituído em build; no desktop fallback pra origin
  const base = import.meta.env.VITE_IDENTITY_URL ?? window.location.origin
  return `${base}/api/v1`
}

const identityApi = axios.create({
  baseURL: resolveBaseURL(),
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})

export default identityApi
export { identityApi }
