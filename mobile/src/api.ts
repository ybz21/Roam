import { Platform } from 'react-native'
import { deleteCookie, getCookie, setCookie } from './storage'
import type { Preferences, SessionInfo } from './types'

export class ApiError extends Error {
  status: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function extractSessionCookie(header: string | null): string | null {
  if (!header) return null
  const match = header.match(/ttmux_session=([^;,]+)/)
  return match ? `ttmux_session=${match[1]}` : null
}

function normalizeApiPath(path: string): string {
  return path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`
}

export class ApiClient {
  origin: string
  onUnauthorized?: () => void

  constructor(origin: string, onUnauthorized?: () => void) {
    this.origin = origin
    this.onUnauthorized = onUnauthorized
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const cookie = await getCookie(this.origin)
    if (cookie) headers.Cookie = cookie

    const response = await fetch(`${this.origin}${normalizeApiPath(path)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const setCookieHeader = response.headers.get('set-cookie') || response.headers.get('Set-Cookie')
    const nextCookie = extractSessionCookie(setCookieHeader)
    if (nextCookie) await setCookie(this.origin, nextCookie)

    if (response.status === 401) {
      this.onUnauthorized?.()
      throw new ApiError(401, 'UNAUTHORIZED', 'UNAUTHORIZED')
    }

    const contentType = response.headers.get('content-type') || ''
    const data = contentType.includes('json') ? await response.json().catch(() => null) : await response.text()
    if (!response.ok) {
      const err = data?.error || {}
      throw new ApiError(response.status, err.message || err.code || `HTTP ${response.status}`, err.code)
    }
    return data as T
  }

  pubConfig() {
    return this.request<{ data: { totp: boolean } }>('GET', '/pubconfig')
  }

  me() {
    return this.request<{ data: { authed: boolean; browserHome?: string } }>('GET', '/me')
  }

  async login(password: string, code: string) {
    await this.request<{ data: string }>('POST', '/login', { password, code })
  }

  async logout() {
    try {
      await this.request<{ data: string }>('POST', '/logout')
    } finally {
      await deleteCookie(this.origin)
    }
  }

  sessions() {
    return this.request<SessionInfo[]>('GET', '/sessions')
  }

  createSession(name: string, dir: string) {
    return this.request<{ name: string; data: string }>('POST', '/sessions', { name, dir })
  }

  renameSession(currentName: string, nextName: string) {
    return this.request<{ data: { name: string } }>('PATCH', `/sessions/${encodeURIComponent(currentName)}`, {
      name: nextName,
    })
  }

  deleteSession(name: string) {
    return this.request<{ data: string }>('DELETE', `/sessions/${encodeURIComponent(name)}`)
  }

  async captureSession(name: string, lines = 80): Promise<string> {
    const res = await this.request<{ data: string }>(
      'GET',
      `/sessions/${encodeURIComponent(name)}/capture?lines=${lines}`,
    )
    return res.data || ''
  }

  async getPreferences(): Promise<Preferences> {
    const res = await this.request<{ data: Partial<Preferences> }>('GET', '/preferences')
    return res.data as Preferences
  }

  setPreferences(preferences: Preferences) {
    return this.request<{ data: { ok: boolean } }>('PUT', '/preferences', preferences)
  }

  registerMobileDevice(body: {
    id: string
    expoPushToken?: string
    nativePushToken?: string
    appVersion?: string
  }) {
    return this.request<{ data: { ok: boolean } }>('POST', '/mobile/devices', {
      ...body,
      platform: Platform.OS,
    })
  }
}
