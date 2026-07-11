import { StatusBar } from 'expo-status-bar'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { ApiClient, ApiError } from './src/api'
import { deviceLocale, makeT, normalizeLocale, type Locale } from './src/i18n'
import { mergePreferences, DEFAULT_PREFERENCES } from './src/preferences'
import { registerForPush } from './src/notifications'
import {
  clearBackendLocalData,
  getBackends,
  getLastBackend,
  getLastTab,
  getScopedJson,
  normalizeBackendUrl,
  rememberBackend,
  setLastBackend,
  setLastTab,
  setScopedJson,
} from './src/storage'
import type { BackendProfile, Preferences, PushRegistrationState, SessionInfo, TabKey } from './src/types'

type T = ReturnType<typeof makeT>

const tabs: TabKey[] = ['sessions', 'preferences', 'settings']

function palette(theme: Preferences['theme']) {
  const dark = theme !== 'light'
  return {
    dark,
    bg: dark ? '#0d1117' : '#f6f8fa',
    panel: dark ? '#161b22' : '#ffffff',
    panel2: dark ? '#0f141b' : '#eef2f7',
    text: dark ? '#f0f6fc' : '#1f2328',
    dim: dark ? '#8b949e' : '#656d76',
    border: dark ? '#30363d' : '#d0d7de',
    accent: '#2f81f7',
    danger: '#f85149',
    success: '#3fb950',
    input: dark ? '#0d1117' : '#ffffff',
  }
}

function errorText(t: T, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_CODE') return t('error.badCode')
    if (error.code === 'BAD_PASSWORD') return t('error.badPassword')
    if (error.code === 'LOCKED') return t('error.locked')
    if (error.code === 'UNAUTHORIZED') return t('error.unauthorized')
  }
  if (error instanceof Error && error.message === 'INVALID_URL') return t('connect.invalidAddress')
  return error instanceof Error ? error.message : t('common.error')
}

function asDate(value: unknown): string {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n) || n <= 0) return ''
  const millis = n > 1_000_000_000_000 ? n : n * 1000
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(millis))
}

function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
}: {
  label: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  disabled?: boolean
}) {
  const variantStyle = {
    primary: styles.button_primary,
    secondary: styles.button_secondary,
    danger: styles.button_danger,
    ghost: styles.button_ghost,
  }[variant]
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variantStyle,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, variant === 'secondary' || variant === 'ghost' ? styles.buttonTextDark : null]}>
        {label}
      </Text>
    </Pressable>
  )
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  multiline,
}: {
  label: string
  value: string
  onChangeText: (value: string) => void
  placeholder?: string
  secureTextEntry?: boolean
  multiline?: boolean
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#8b949e"
        secureTextEntry={secureTextEntry}
        style={[styles.input, multiline && styles.textarea]}
        value={value}
      />
    </View>
  )
}

export default function App() {
  const initialLocale = useMemo(() => deviceLocale(), [])
  const [booting, setBooting] = useState(true)
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const [preferences, setPreferencesState] = useState<Preferences>({ ...DEFAULT_PREFERENCES, locale: initialLocale })
  const [backend, setBackend] = useState<string | null>(null)
  const [client, setClient] = useState<ApiClient | null>(null)
  const [authed, setAuthed] = useState(false)
  const [tab, setTab] = useState<TabKey>('sessions')
  const [backends, setBackends] = useState<BackendProfile[]>([])
  const [pushState, setPushState] = useState<PushRegistrationState>({ status: 'idle' })

  const t = useMemo(() => makeT(locale), [locale])
  const colors = useMemo(() => palette(preferences.theme), [preferences.theme])

  const unauthorize = useCallback(() => {
    setAuthed(false)
  }, [])

  const attachBackend = useCallback(async (origin: string) => {
    const api = new ApiClient(origin, unauthorize)
    setBackend(origin)
    setClient(api)
    await setLastBackend(origin)
    const lastTab = await getLastTab(origin)
    setTab(lastTab)
    return api
  }, [unauthorize])

  const loadPreferences = useCallback(async (api: ApiClient) => {
    const cached = await getScopedJson<Partial<Preferences>>(api.origin, 'preferencesCache', {})
    let prefs = mergePreferences(cached, initialLocale)
    try {
      const remote = await api.getPreferences()
      prefs = mergePreferences(remote, prefs.locale)
      await setScopedJson(api.origin, 'preferencesCache', prefs)
    } catch {}
    setPreferencesState(prefs)
    setLocale(normalizeLocale(prefs.locale))
    return prefs
  }, [initialLocale])

  const refreshBackends = useCallback(async () => {
    setBackends(await getBackends())
  }, [])

  useEffect(() => {
    let stop = false
    async function boot() {
      await refreshBackends()
      const last = await getLastBackend()
      if (!last || stop) {
        setBooting(false)
        return
      }
      const api = await attachBackend(last)
      try {
        await api.me()
        await loadPreferences(api)
        if (!stop) setAuthed(true)
      } catch {
        if (!stop) setAuthed(false)
      } finally {
        if (!stop) setBooting(false)
      }
    }
    boot()
    return () => { stop = true }
  }, [attachBackend, loadPreferences, refreshBackends])

  const updatePreferences = useCallback(async (next: Preferences) => {
    setPreferencesState(next)
    setLocale(next.locale)
    if (!client) return
    await setScopedJson(client.origin, 'preferencesCache', next)
    await client.setPreferences(next)
  }, [client])

  const connect = useCallback(async (raw: string) => {
    const origin = normalizeBackendUrl(raw)
    const api = await attachBackend(origin)
    await api.pubConfig()
    await rememberBackend(origin)
    await refreshBackends()
    setAuthed(false)
  }, [attachBackend, refreshBackends])

  const login = useCallback(async (password: string, code: string) => {
    if (!client) return
    await client.login(password, code)
    await rememberBackend(client.origin)
    await refreshBackends()
    await loadPreferences(client)
    setAuthed(true)
    const state = await registerForPush(client)
    setPushState(state)
  }, [client, loadPreferences, refreshBackends])

  const switchBackend = useCallback(() => {
    setBackend(null)
    setClient(null)
    setAuthed(false)
  }, [])

  const logout = useCallback(async () => {
    if (!client) return
    await client.logout()
    setAuthed(false)
  }, [client])

  if (booting) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]}>
        <StatusBar style={colors.dark ? 'light' : 'dark'} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.muted, { color: colors.dim }]}>{t('common.loading')}</Text>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar style={colors.dark ? 'light' : 'dark'} />
      <View style={[styles.app, { backgroundColor: colors.bg }]}>
        {!backend || !client ? (
          <ConnectScreen backends={backends} colors={colors} onConnect={connect} t={t} />
        ) : !authed ? (
          <LoginScreen client={client} colors={colors} onLogin={login} onSwitchBackend={switchBackend} t={t} />
        ) : (
          <MainShell
            backend={backend}
            client={client}
            colors={colors}
            onClearLocal={async () => {
              await clearBackendLocalData(backend)
              setAuthed(false)
            }}
            onLogout={logout}
            onRegisterPush={async () => setPushState(await registerForPush(client))}
            onSwitchBackend={switchBackend}
            preferences={preferences}
            pushState={pushState}
            setPreferences={updatePreferences}
            setTab={async (next) => {
              setTab(next)
              await setLastTab(backend, next)
            }}
            t={t}
            tab={tab}
          />
        )}
      </View>
    </SafeAreaView>
  )
}

function ConnectScreen({
  backends,
  colors,
  onConnect,
  t,
}: {
  backends: BackendProfile[]
  colors: ReturnType<typeof palette>
  onConnect: (raw: string) => Promise<void>
  t: T
}) {
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (raw = address) => {
    setLoading(true)
    setError('')
    try {
      await onConnect(raw)
    } catch (err) {
      setError(errorText(t, err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={[styles.hero, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.brand, { color: colors.text }]}>{t('app.name')}</Text>
        <Text style={[styles.title, { color: colors.text }]}>{t('connect.title')}</Text>
        <Text style={[styles.help, { color: colors.dim }]}>{t('connect.backendHelp')}</Text>
        <Field
          label={t('connect.backendAddress')}
          onChangeText={setAddress}
          placeholder={t('connect.placeholder')}
          value={address}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button disabled={loading} label={loading ? t('common.loading') : t('connect.connect')} onPress={() => submit()} />
      </View>
      {backends.length ? (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('connect.savedBackends')}</Text>
          {backends.map((item) => (
            <Pressable
              key={item.origin}
              onPress={() => submit(item.origin)}
              style={({ pressed }) => [
                styles.rowCard,
                { borderColor: colors.border, backgroundColor: colors.panel },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.rowTitle, { color: colors.text }]}>{item.origin}</Text>
              <Text style={[styles.rowMeta, { color: colors.dim }]}>{t('common.switch')}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  )
}

function LoginScreen({
  client,
  colors,
  onLogin,
  onSwitchBackend,
  t,
}: {
  client: ApiClient
  colors: ReturnType<typeof palette>
  onLogin: (password: string, code: string) => Promise<void>
  onSwitchBackend: () => void
  t: T
}) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [totp, setTotp] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    client.pubConfig().then((res) => setTotp(!!res.data?.totp)).catch(() => {})
  }, [client])

  const submit = async () => {
    if (!password) {
      setError(t('login.passwordRequired'))
      return
    }
    setLoading(true)
    setError('')
    try {
      await onLogin(password, code.trim())
    } catch (err) {
      setError(errorText(t, err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={[styles.hero, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.brand, { color: colors.text }]}>{t('app.name')}</Text>
        <Text style={[styles.title, { color: colors.text }]}>{t('login.title')}</Text>
        <Text style={[styles.help, { color: colors.dim }]}>{client.origin}</Text>
        <Field label={t('login.password')} onChangeText={setPassword} secureTextEntry value={password} />
        {totp ? (
          <Field
            label={t('login.code')}
            onChangeText={setCode}
            placeholder={t('login.codePlaceholder')}
            value={code}
          />
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button disabled={loading} label={loading ? t('common.loading') : t('login.login')} onPress={submit} />
        <View style={styles.inlineActions}>
          <Button label={t('settings.switchBackend')} onPress={onSwitchBackend} variant="secondary" />
        </View>
      </View>
    </ScrollView>
  )
}

function MainShell({
  backend,
  client,
  colors,
  onClearLocal,
  onLogout,
  onRegisterPush,
  onSwitchBackend,
  preferences,
  pushState,
  setPreferences,
  setTab,
  t,
  tab,
}: {
  backend: string
  client: ApiClient
  colors: ReturnType<typeof palette>
  onClearLocal: () => Promise<void>
  onLogout: () => Promise<void>
  onRegisterPush: () => Promise<void>
  onSwitchBackend: () => void
  preferences: Preferences
  pushState: PushRegistrationState
  setPreferences: (next: Preferences) => Promise<void>
  setTab: (tab: TabKey) => Promise<void>
  t: T
  tab: TabKey
}) {
  return (
    <View style={styles.shell}>
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.panel }]}>
        <View>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t(`nav.${tab}`)}</Text>
          <Text numberOfLines={1} style={[styles.headerSubtitle, { color: colors.dim }]}>{backend}</Text>
        </View>
      </View>
      <View style={styles.content}>
        {tab === 'sessions' ? <SessionsScreen client={client} colors={colors} t={t} /> : null}
        {tab === 'preferences' ? (
          <PreferencesScreen colors={colors} preferences={preferences} setPreferences={setPreferences} t={t} />
        ) : null}
        {tab === 'settings' ? (
          <SettingsScreen
            backend={backend}
            colors={colors}
            onClearLocal={onClearLocal}
            onLogout={onLogout}
            onRegisterPush={onRegisterPush}
            onSwitchBackend={onSwitchBackend}
            pushState={pushState}
            t={t}
          />
        ) : null}
      </View>
      <View style={[styles.tabbar, { borderTopColor: colors.border, backgroundColor: colors.panel }]}>
        {tabs.map((key) => {
          const active = key === tab
          return (
            <Pressable key={key} onPress={() => setTab(key)} style={styles.tabItem}>
              <Text style={[styles.tabText, { color: active ? colors.accent : colors.dim }]}>{t(`nav.${key}`)}</Text>
              <View style={[styles.tabIndicator, active && { backgroundColor: colors.accent }]} />
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

function SessionsScreen({ client, colors, t }: { client: ApiClient; colors: ReturnType<typeof palette>; t: T }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [selected, setSelected] = useState<SessionInfo | null>(null)
  const [capture, setCapture] = useState('')
  const [captureLoading, setCaptureLoading] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [nextName, setNextName] = useState('')

  const load = useCallback(async () => {
    const list = await client.sessions()
    setSessions(Array.isArray(list) ? list : [])
  }, [client])

  useEffect(() => {
    load().catch(() => {})
    const id = setInterval(() => load().catch(() => {}), 5000)
    return () => clearInterval(id)
  }, [load])

  const refresh = async () => {
    setRefreshing(true)
    try { await load() } finally { setRefreshing(false) }
  }

  const create = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      await client.createSession(name.trim(), dir.trim())
      setName('')
      setDir('')
      setCreateOpen(false)
      await load()
    } catch (err) {
      Alert.alert(t('common.error'), errorText(t, err))
    } finally {
      setCreating(false)
    }
  }

  const showCapture = async (session: SessionInfo) => {
    setSelected(session)
    setCapture('')
    setCaptureLoading(true)
    try {
      const text = await client.captureSession(session.name, 80)
      setCapture(text.trim() || t('sessions.captureEmpty'))
    } catch (err) {
      setCapture(errorText(t, err))
    } finally {
      setCaptureLoading(false)
    }
  }

  const closeSession = (session: SessionInfo) => {
    Alert.alert(t('common.confirm'), t('sessions.closeConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await client.deleteSession(session.name)
            if (selected?.name === session.name) setSelected(null)
            await load()
          } catch (err) {
            Alert.alert(t('common.error'), errorText(t, err))
          }
        },
      },
    ])
  }

  const rename = async () => {
    if (!selected || !nextName.trim()) return
    try {
      await client.renameSession(selected.name, nextName.trim())
      setRenameOpen(false)
      setSelected(null)
      await load()
    } catch (err) {
      Alert.alert(t('common.error'), errorText(t, err))
    }
  }

  return (
    <View style={styles.fill}>
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.name}
        ListHeaderComponent={(
          <View style={styles.listHeader}>
            <Text style={[styles.help, { color: colors.dim }]}>{t('sessions.nativeHint')}</Text>
            <Button label={t('sessions.create')} onPress={() => setCreateOpen(true)} />
          </View>
        )}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors.dim }]}>{t('sessions.empty')}</Text>}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
        renderItem={({ item }) => (
          <View style={[styles.sessionCard, { borderColor: colors.border, backgroundColor: colors.panel }]}>
            <Text style={[styles.rowTitle, { color: colors.text }]}>{item.name}</Text>
            <Text style={[styles.rowMeta, { color: colors.dim }]}>
              {t('sessions.created')}: {asDate(item.created) || t('common.empty')}  {t('sessions.activity')}: {asDate(item.last_activity) || t('common.empty')}
            </Text>
            <View style={styles.cardActions}>
              <Button label={t('sessions.capture')} onPress={() => showCapture(item)} variant="secondary" />
              <Button label={t('common.delete')} onPress={() => closeSession(item)} variant="danger" />
            </View>
          </View>
        )}
      />
      <Modal animationType="slide" transparent visible={createOpen} onRequestClose={() => setCreateOpen(false)}>
        <ModalCard colors={colors} title={t('sessions.create')}>
          <Field label={t('sessions.name')} onChangeText={setName} placeholder={t('sessions.namePlaceholder')} value={name} />
          <Field label={t('sessions.dir')} onChangeText={setDir} placeholder={t('sessions.dirPlaceholder')} value={dir} />
          <View style={styles.modalActions}>
            <Button label={t('common.cancel')} onPress={() => setCreateOpen(false)} variant="secondary" />
            <Button disabled={creating} label={creating ? t('common.saving') : t('common.save')} onPress={create} />
          </View>
        </ModalCard>
      </Modal>
      <Modal animationType="slide" visible={!!selected} onRequestClose={() => setSelected(null)}>
        <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]}>
          <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.panel }]}>
            <View style={styles.headerRow}>
              <View style={styles.headerMain}>
                <Text style={[styles.headerTitle, { color: colors.text }]}>{selected?.name}</Text>
                <Text style={[styles.headerSubtitle, { color: colors.dim }]}>{t('sessions.capture')}</Text>
              </View>
              <Button label={t('common.close')} onPress={() => setSelected(null)} variant="secondary" />
            </View>
          </View>
          <ScrollView contentContainerStyle={styles.detail}>
            {captureLoading ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={[styles.captureText, { color: colors.text, backgroundColor: colors.panel2 }]}>
                {capture}
              </Text>
            )}
            <View style={styles.cardActions}>
              <Button
                label={t('sessions.rename')}
                onPress={() => {
                  setNextName(selected?.name || '')
                  setRenameOpen(true)
                }}
                variant="secondary"
              />
              {selected ? <Button label={t('common.delete')} onPress={() => closeSession(selected)} variant="danger" /> : null}
            </View>
          </ScrollView>
          <Modal animationType="fade" transparent visible={renameOpen} onRequestClose={() => setRenameOpen(false)}>
            <ModalCard colors={colors} title={t('sessions.rename')}>
              <Field label={t('sessions.name')} onChangeText={setNextName} value={nextName} />
              <View style={styles.modalActions}>
                <Button label={t('common.cancel')} onPress={() => setRenameOpen(false)} variant="secondary" />
                <Button label={t('common.save')} onPress={rename} />
              </View>
            </ModalCard>
          </Modal>
        </SafeAreaView>
      </Modal>
    </View>
  )
}

function PreferencesScreen({
  colors,
  preferences,
  setPreferences,
  t,
}: {
  colors: ReturnType<typeof palette>
  preferences: Preferences
  setPreferences: (next: Preferences) => Promise<void>
  t: T
}) {
  const [saving, setSaving] = useState(false)
  const [quickCommands, setQuickCommands] = useState(preferences.quickCommands.join('\n'))

  useEffect(() => {
    setQuickCommands(preferences.quickCommands.join('\n'))
  }, [preferences.quickCommands])

  const save = async (partial: Partial<Preferences>) => {
    setSaving(true)
    try {
      await setPreferences({ ...preferences, ...partial })
    } catch (err) {
      Alert.alert(t('common.error'), errorText(t, err))
    } finally {
      setSaving(false)
    }
  }

  const rows = [
    ['theme', preferences.theme],
    ['locale', preferences.locale],
    ['claudeCommand', preferences.claudeCommand],
    ['codexCommand', preferences.codexCommand],
    ['browserQuality', preferences.browserQuality],
  ]

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('prefs.theme')}</Text>
        <View style={styles.segment}>
          <Button label={t('prefs.theme.dark')} onPress={() => save({ theme: 'dark' })} variant={preferences.theme === 'dark' ? 'primary' : 'secondary'} />
          <Button label={t('prefs.theme.light')} onPress={() => save({ theme: 'light' })} variant={preferences.theme === 'light' ? 'primary' : 'secondary'} />
        </View>
      </View>
      <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('prefs.locale')}</Text>
        <View style={styles.segment}>
          <Button label="zh-CN" onPress={() => save({ locale: 'zh-CN' })} variant={preferences.locale === 'zh-CN' ? 'primary' : 'secondary'} />
          <Button label="en-US" onPress={() => save({ locale: 'en-US' })} variant={preferences.locale === 'en-US' ? 'primary' : 'secondary'} />
        </View>
      </View>
      <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Field
          label={t('prefs.quickCommands')}
          multiline
          onChangeText={setQuickCommands}
          value={quickCommands}
        />
        <Text style={[styles.help, { color: colors.dim }]}>{t('prefs.quickCommandsHelp')}</Text>
        <Button
          disabled={saving}
          label={saving ? t('common.saving') : t('common.save')}
          onPress={() => save({ quickCommands: quickCommands.split('\n').map((s) => s.trim()).filter(Boolean) })}
        />
      </View>
      <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('prefs.synced')}</Text>
        {rows.map(([key, value]) => (
          <View key={key} style={styles.prefRow}>
            <Text style={[styles.prefKey, { color: colors.dim }]}>{t(`prefs.${key}`)}</Text>
            <Text style={[styles.prefValue, { color: colors.text }]}>{value}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function SettingsScreen({
  backend,
  colors,
  onClearLocal,
  onLogout,
  onRegisterPush,
  onSwitchBackend,
  pushState,
  t,
}: {
  backend: string
  colors: ReturnType<typeof palette>
  onClearLocal: () => Promise<void>
  onLogout: () => Promise<void>
  onRegisterPush: () => Promise<void>
  onSwitchBackend: () => void
  pushState: PushRegistrationState
  t: T
}) {
  const pushLabel = pushState.status === 'ready'
    ? t('notifications.ready')
    : pushState.status === 'denied'
      ? t('notifications.denied')
      : pushState.status === 'missingProject'
        ? t('notifications.missingProject')
        : pushState.status === 'unavailable'
          ? t('notifications.unavailable')
          : pushState.error || t('common.empty')

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.backend')}</Text>
        <Text style={[styles.help, { color: colors.dim }]}>{backend}</Text>
        <View style={styles.cardActions}>
          <Button label={t('settings.switchBackend')} onPress={onSwitchBackend} variant="secondary" />
          <Button label={t('settings.logout')} onPress={() => onLogout().catch(() => {})} variant="danger" />
        </View>
      </View>
      <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.notifications')}</Text>
        <Text style={[styles.help, { color: colors.dim }]}>{pushLabel}</Text>
        <Button label={t('notifications.register')} onPress={() => onRegisterPush().catch(() => {})} />
      </View>
      <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('settings.clearLocal')}</Text>
        <Text style={[styles.help, { color: colors.dim }]}>{t('settings.clearLocalConfirm')}</Text>
        <Button
          label={t('settings.clearLocal')}
          onPress={() => {
            Alert.alert(t('common.confirm'), t('settings.clearLocalConfirm'), [
              { text: t('common.cancel'), style: 'cancel' },
              { text: t('common.confirm'), style: 'destructive', onPress: () => onClearLocal().catch(() => {}) },
            ])
          }}
          variant="danger"
        />
      </View>
    </ScrollView>
  )
}

function ModalCard({
  children,
  colors,
  title,
}: {
  children: ReactNode
  colors: ReturnType<typeof palette>
  title: string
}) {
  return (
    <View style={styles.modalBackdrop}>
      <View style={[styles.modalCard, { borderColor: colors.border, backgroundColor: colors.panel }]}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        {children}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  brand: { fontSize: 34, fontWeight: '800', letterSpacing: 0 },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  button_danger: { backgroundColor: '#da3633' },
  button_ghost: { backgroundColor: 'transparent' },
  button_primary: { backgroundColor: '#2f81f7' },
  button_secondary: { backgroundColor: '#eaeef2' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  buttonTextDark: { color: '#1f2328' },
  captureText: { borderRadius: 8, fontFamily: 'Courier', fontSize: 12, lineHeight: 18, padding: 12 },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  center: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center' },
  content: { flex: 1 },
  detail: { gap: 14, padding: 16 },
  empty: { fontSize: 15, padding: 24, textAlign: 'center' },
  error: { color: '#f85149', fontSize: 13, lineHeight: 18 },
  field: { gap: 6, marginBottom: 12 },
  fill: { flex: 1 },
  header: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 12 },
  headerMain: { flex: 1, minWidth: 0 },
  headerRow: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  headerSubtitle: { fontSize: 12, marginTop: 3 },
  headerTitle: { fontSize: 20, fontWeight: '800', letterSpacing: 0 },
  help: { fontSize: 13, lineHeight: 19 },
  hero: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, gap: 14, padding: 18 },
  inlineActions: { marginTop: 4 },
  input: {
    backgroundColor: '#ffffff',
    borderColor: '#d0d7de',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    color: '#1f2328',
    fontSize: 16,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  label: { color: '#8b949e', fontSize: 13, fontWeight: '700' },
  listHeader: { gap: 12, padding: 16 },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 8 },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.45)', flex: 1, justifyContent: 'flex-end', padding: 16 },
  modalCard: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, gap: 12, padding: 16 },
  muted: { fontSize: 14 },
  panel: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, gap: 12, padding: 16 },
  prefKey: { fontSize: 13, width: 130 },
  prefRow: { borderTopColor: '#30363d', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, paddingVertical: 9 },
  prefValue: { flex: 1, fontSize: 13 },
  pressed: { opacity: 0.75 },
  root: { flex: 1 },
  rowCard: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, marginTop: 10, padding: 14 },
  rowMeta: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  rowTitle: { fontSize: 17, fontWeight: '800', letterSpacing: 0 },
  screen: { gap: 16, padding: 16 },
  section: { marginTop: 18 },
  sectionTitle: { fontSize: 16, fontWeight: '800', letterSpacing: 0 },
  segment: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  sessionCard: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 16, marginVertical: 6, padding: 14 },
  shell: { flex: 1 },
  tabIndicator: { borderRadius: 99, height: 3, marginTop: 6, width: 28 },
  tabItem: { alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: 58 },
  tabText: { fontSize: 13, fontWeight: '800' },
  tabbar: { borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
  textarea: { minHeight: 120, textAlignVertical: 'top' },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: 0 },
})
