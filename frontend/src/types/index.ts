export interface User {
  id: string | number
  email: string
  firstName: string | null
  lastName: string | null
  provider: string
  photo?: FileType | null
  role?: Role | null
  status?: Status
  specialization?: string | null
  department?: string | null
  professionalId?: string | null
  tenantId: string // TENANT ISOLATION: Todo usuário pertence a um tenant
  createdAt: string
  updatedAt: string
}

export interface FileType {
  id: string
  path: string
}

export interface Role {
  id: number
  name: string
}

export interface Status {
  id: number
  name: string
}

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export interface MessageAttachment {
  id?: string
  filename?: string
  mimetype?: string
  url?: string
  path?: string
  size?: number
  thumbnail?: string
}

export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  tokens?: number
  cost?: number
  metadata?: Record<string, any>
  attachments?: MessageAttachment[]
  createdAt: string
  updatedAt: string
}

export interface ChatSession {
  id: string
  title: string
  description?: string
  userId: string
  promptId?: string | null
  metadata?: Record<string, any>
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface Contact {
  id: string
  name?: string
  phone: string
  metadata?: Record<string, any>
  createdAt: string
  updatedAt: string
}

export interface Prompt {
  id: string
  name: string
  description?: string
  content: string
  variables?: string[]
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface ApiConfig {
  id: string
  name: string
  apiKey: string
  model: string
  maxTokens: number
  temperature: number
  monthlyLimit?: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface PhoneService {
  id: string
  phoneNumber: string
  serviceName: string
  description?: string
  requiresPreRegistration: boolean
  requiresAuthentication: boolean
  promptId?: string
  prompt?: Prompt
  apiConfigId?: string
  apiConfig?: ApiConfig
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface UserPhonePermission {
  id: string
  userId: number
  phoneServiceId: string
  contactPhone: string
  isAuthenticated: boolean
  authenticatedAt?: string
  expiresAt?: string
  createdAt: string
  updatedAt: string
  user?: User
  phoneService?: PhoneService
}

export interface AuthCode {
  id: string
  userId: number
  phoneServiceId: string
  code: string
  expiresAt: string
  usedAt?: string
  createdAt: string
  user?: User
  phoneService?: PhoneService
}

export interface EmailTemplate {
  id: string
  name: string
  subject: string
  htmlContent: string
  variables: string[]
  isActive: boolean
  createdAt: string
  updatedAt: string
}

// API Request/Response types
export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  password: string
  firstName: string
  lastName: string
}

export interface LoginResponse {
  token: string
  refreshToken: string
  tokenExpires: number
  user: User
}

export interface ChatRequest {
  message: string
  sessionId?: string
  promptId?: string
  sessionTitle?: string
  variables?: Record<string, any>
}

export interface ChatResponse {
  message: string
  session: ChatSession
  userMessage: Message
  assistantMessage: Message
  tokensUsed: number
  cost: number
}

// Store types
export interface AuthStore {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  login: (credentials: LoginRequest) => Promise<void>
  register: (data: RegisterRequest) => Promise<void>
  logout: () => void | Promise<void>
  setUser: (user: User) => void
}

export interface ChatStore {
  sessions: ChatSession[]
  activeSessionId: string | null
  messages: Record<string, Message[]>
  addSession: (session: ChatSession) => void
  setActiveSession: (sessionId: string | null) => void
  addMessage: (sessionId: string, message: Message) => void
  clearMessages: (sessionId: string) => void
  clearAllSessions: () => void
}

// Medical Triage Types
export enum UserRole {
  ADMIN = 'admin',
  DOCTOR = 'doctor',
  NURSE = 'nurse',
}

export enum ManchesterColor {
  RED = 'RED',
  ORANGE = 'ORANGE',
  YELLOW = 'YELLOW',
  GREEN = 'GREEN',
  BLUE = 'BLUE',
}

export enum TriageStatus {
  AWAITING_CARE = 'AWAITING_CARE',
  CALLED = 'CALLED',
  IN_CARE = 'IN_CARE',
  ATTENDED = 'ATTENDED',
  TRANSFERRED = 'TRANSFERRED',
  WITHDRAWAL = 'WITHDRAWAL',
  DISCHARGE = 'DISCHARGE',
  HOSPITALIZED = 'HOSPITALIZED',
  DEATH = 'DEATH',
}

export interface Patient {
  id: string
  name: string
  cpf: string
  birthDate: string
  phone?: string
  address?: string
  emergencyContact?: string
  medicalHistory?: string
  allergies?: string
  medications?: string
  createdAt: string
  updatedAt: string
}

export interface VitalSigns {
  id: string
  patientId: string
  temperature?: number
  heartRate?: number
  bloodPressure?: string
  respiratoryRate?: number
  oxygenSaturation?: number
  weight?: number
  height?: number
  painLevel?: number
  collectedBy: string
  collectedAt: string
  createdAt: string
}

export interface TriageSession {
  id: string
  patientId: string
  patient?: Patient
  chiefComplaint: string
  symptoms?: string
  manchesterColor?: ManchesterColor
  status: TriageStatus
  priority: number
  estimatedWaitTime?: number
  attendedBy?: string
  vitalSigns?: VitalSigns[]
  createdAt: string
  updatedAt: string
}

export interface MedicalChatMessage {
  id: string
  type: 'user' | 'bot' | 'system'
  content: string
  timestamp: Date
  attachments?: MessageAttachment[]
  contextData?: {
    patientId?: string
    sessionId?: string
    actionButtons?: ChatAction[]
    inlineComponents?: React.ComponentType[]
  }
}

export interface ChatAction {
  id: string
  label: string
  type: 'primary' | 'secondary' | 'danger'
  action: () => void
  disabled?: boolean
}

export interface NurseChatMessage {
  id: string
  type: 'user' | 'bot' | 'emergency'
  content: string
  timestamp: Date
  isGuidedFlow?: boolean
  quickActions?: SimpleAction[]
}

export interface SimpleAction {
  label: string
  icon?: string
  color: 'green' | 'yellow' | 'orange' | 'red'
  action: () => void
}

export interface AdminDashboardStats {
  totalSessions: number
  activeSessions: number
  completedSessions: number
  emergencyCases: number
  averageWaitTime: number
  staffOnline: number
}

export interface MedicalStaffDto {
  id: string
  name: string
  email: string
  role: UserRole
  specialization?: string
  isOnline: boolean
  currentPatientId?: string
  departmentId?: string
  createdAt: string
}

// Department types
export interface Department {
  id: string
  name: string
  description?: string
  icon?: string
  color?: string
  active: boolean
  sortOrder: number
  tenantId: string
  createdAt: string
  updatedAt: string
}

// UI types
export interface NavigationItem {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  current?: boolean
  badge?: string | number
}