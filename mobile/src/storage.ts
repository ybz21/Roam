import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type { BackendProfile, TabKey } from './types'

const BACKENDS_KEY = 'roam.mobile.backends'
const LAST_BACKEND_KEY = 'roam.mobile.lastBackend'

function encodeKey(value: string): string {
  return Array.from(value)
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
}

export function backendScope(origin: string): string {
  return encodeKey(origin)
}

export function normalizeBackendUrl(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('INVALID_URL')
  }
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export async function getBackends(): Promise<BackendProfile[]> {
  const raw = await AsyncStorage.getItem(BACKENDS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function rememberBackend(origin: string): Promise<void> {
  const backends = await getBackends()
  const now = Date.now()
  const next = [
    { origin, label: origin, lastUsedAt: now },
    ...backends.filter((item) => item.origin !== origin),
  ].slice(0, 12)
  await AsyncStorage.multiSet([
    [BACKENDS_KEY, JSON.stringify(next)],
    [LAST_BACKEND_KEY, origin],
  ])
}

export async function getLastBackend(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_BACKEND_KEY)
}

export async function setLastBackend(origin: string): Promise<void> {
  await AsyncStorage.setItem(LAST_BACKEND_KEY, origin)
}

function scopedKey(origin: string, key: string): string {
  return `roam.mobile.${backendScope(origin)}.${key}`
}

function cookieKey(origin: string): string {
  return `roam.mobile.cookie.${backendScope(origin)}`
}

export async function getScopedJson<T>(origin: string, key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(scopedKey(origin, key))
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function setScopedJson(origin: string, key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(scopedKey(origin, key), JSON.stringify(value))
}

export async function getLastTab(origin: string): Promise<TabKey> {
  const tab = await AsyncStorage.getItem(scopedKey(origin, 'lastTab'))
  return tab === 'preferences' || tab === 'settings' || tab === 'sessions' ? tab : 'sessions'
}

export async function setLastTab(origin: string, tab: TabKey): Promise<void> {
  await AsyncStorage.setItem(scopedKey(origin, 'lastTab'), tab)
}

export async function getCookie(origin: string): Promise<string | null> {
  return SecureStore.getItemAsync(cookieKey(origin))
}

export async function setCookie(origin: string, cookie: string): Promise<void> {
  await SecureStore.setItemAsync(cookieKey(origin), cookie, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  })
}

export async function deleteCookie(origin: string): Promise<void> {
  await SecureStore.deleteItemAsync(cookieKey(origin))
}

export async function clearBackendLocalData(origin: string): Promise<void> {
  const scope = `roam.mobile.${backendScope(origin)}.`
  const keys = await AsyncStorage.getAllKeys()
  const scopedKeys = keys.filter((key) => key.startsWith(scope))
  await AsyncStorage.multiRemove(scopedKeys)
  await deleteCookie(origin)
}

export async function getDeviceId(origin: string): Promise<string> {
  const key = scopedKey(origin, 'deviceId')
  const existing = await AsyncStorage.getItem(key)
  if (existing) return existing
  const id = `rn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  await AsyncStorage.setItem(key, id)
  return id
}
