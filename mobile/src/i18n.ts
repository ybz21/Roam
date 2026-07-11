export type Locale = 'zh-CN' | 'en-US'

type Messages = Record<string, string>

const zh: Messages = {
  'app.name': 'Roam',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.confirm': '确认',
  'common.delete': '删除',
  'common.edit': '编辑',
  'common.empty': '暂无数据',
  'common.error': '出错了',
  'common.loading': '加载中',
  'common.refresh': '刷新',
  'common.retry': '重试',
  'common.save': '保存',
  'common.saved': '已保存',
  'common.saving': '保存中',
  'common.switch': '切换',
  'connect.addBackend': '添加后端',
  'connect.backendAddress': '后端地址',
  'connect.backendHelp': '填写 Roam 后端地址。首次连接成功后会自动记住，下次启动直接使用。',
  'connect.connect': '连接',
  'connect.invalidAddress': '请输入有效的 http 或 https 地址',
  'connect.placeholder': 'http://192.168.1.10:13579',
  'connect.savedBackends': '已保存后端',
  'connect.title': '连接 Roam 后端',
  'connect.unreachable': '无法连接后端',
  'error.badCode': '动态码不正确',
  'error.badPassword': '密码不正确',
  'error.locked': '登录已锁定，请稍后再试',
  'error.unauthorized': '登录已失效',
  'login.code': '动态码',
  'login.codePlaceholder': '6 位动态码',
  'login.login': '登录',
  'login.password': '访问密码',
  'login.passwordRequired': '请输入访问密码',
  'login.title': '登录',
  'nav.preferences': '偏好',
  'nav.sessions': '会话',
  'nav.settings': '设置',
  'notifications.denied': '通知权限未开启',
  'notifications.missingProject': '未配置 EAS projectId，暂不能注册 Expo Push Token',
  'notifications.ready': '推送已注册',
  'notifications.register': '注册推送',
  'notifications.unavailable': '推送不可用',
  'prefs.key': '键',
  'prefs.browserQuality': '浏览器画质',
  'prefs.claudeCommand': 'Claude 启动命令',
  'prefs.codexCommand': 'Codex 启动命令',
  'prefs.locale': '语言',
  'prefs.quickCommands': '快捷命令',
  'prefs.quickCommandsHelp': '每行一条，保存后同步到当前后端。',
  'prefs.reload': '重新同步',
  'prefs.synced': '偏好已同步',
  'prefs.theme': '主题',
  'prefs.theme.dark': '深色',
  'prefs.theme.light': '浅色',
  'prefs.title': '用户偏好',
  'prefs.value': '值',
  'sessions.activity': '活跃',
  'sessions.capture': '预览',
  'sessions.captureEmpty': '当前没有可显示的输出',
  'sessions.closeConfirm': '确定关闭这个会话？',
  'sessions.created': '创建',
  'sessions.create': '新建会话',
  'sessions.dir': '工作目录',
  'sessions.dirPlaceholder': '留空使用后端默认目录',
  'sessions.empty': '当前后端没有会话',
  'sessions.name': '会话名',
  'sessions.namePlaceholder': '例如 roam-agent',
  'sessions.nameRequired': '请输入会话名',
  'sessions.nativeHint': '这是原生会话视图，不嵌入 Web 终端或 xterm。',
  'sessions.rename': '重命名',
  'sessions.renamed': '已重命名',
  'sessions.title': '会话',
  'settings.backend': '当前后端',
  'settings.clearLocal': '清除此后端本地数据',
  'settings.clearLocalConfirm': '只会清除当前后端在本机保存的 Cookie 和缓存，不影响其他后端。',
  'settings.logout': '退出登录',
  'settings.notifications': '推送通知',
  'settings.switchBackend': '切换后端',
  'settings.title': '设置',
  'settings.version': '版本',
}

const en: Messages = {
  'app.name': 'Roam',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.empty': 'No data',
  'common.error': 'Something went wrong',
  'common.loading': 'Loading',
  'common.refresh': 'Refresh',
  'common.retry': 'Retry',
  'common.save': 'Save',
  'common.saved': 'Saved',
  'common.saving': 'Saving',
  'common.switch': 'Switch',
  'connect.addBackend': 'Add backend',
  'connect.backendAddress': 'Backend address',
  'connect.backendHelp': 'Enter the Roam backend address. After the first successful connection it is remembered for the next launch.',
  'connect.connect': 'Connect',
  'connect.invalidAddress': 'Enter a valid http or https address',
  'connect.placeholder': 'http://192.168.1.10:13579',
  'connect.savedBackends': 'Saved backends',
  'connect.title': 'Connect to Roam',
  'connect.unreachable': 'Backend is unreachable',
  'error.badCode': 'Invalid verification code',
  'error.badPassword': 'Invalid password',
  'error.locked': 'Login is locked. Try again later',
  'error.unauthorized': 'Login expired',
  'login.code': 'Verification code',
  'login.codePlaceholder': '6-digit code',
  'login.login': 'Log in',
  'login.password': 'Access password',
  'login.passwordRequired': 'Enter the access password',
  'login.title': 'Log in',
  'nav.preferences': 'Preferences',
  'nav.sessions': 'Sessions',
  'nav.settings': 'Settings',
  'notifications.denied': 'Notifications are not allowed',
  'notifications.missingProject': 'EAS projectId is not configured, so Expo push token registration is disabled',
  'notifications.ready': 'Push is registered',
  'notifications.register': 'Register push',
  'notifications.unavailable': 'Push is unavailable',
  'prefs.key': 'Key',
  'prefs.browserQuality': 'Browser quality',
  'prefs.claudeCommand': 'Claude command',
  'prefs.codexCommand': 'Codex command',
  'prefs.locale': 'Locale',
  'prefs.quickCommands': 'Quick commands',
  'prefs.quickCommandsHelp': 'One command per line. Saving syncs to the current backend.',
  'prefs.reload': 'Sync again',
  'prefs.synced': 'Preferences synced',
  'prefs.theme': 'Theme',
  'prefs.theme.dark': 'Dark',
  'prefs.theme.light': 'Light',
  'prefs.title': 'User preferences',
  'prefs.value': 'Value',
  'sessions.activity': 'Activity',
  'sessions.capture': 'Preview',
  'sessions.captureEmpty': 'There is no output to show',
  'sessions.closeConfirm': 'Close this session?',
  'sessions.created': 'Created',
  'sessions.create': 'New session',
  'sessions.dir': 'Working directory',
  'sessions.dirPlaceholder': 'Leave empty to use the backend default',
  'sessions.empty': 'This backend has no sessions',
  'sessions.name': 'Session name',
  'sessions.namePlaceholder': 'For example roam-agent',
  'sessions.nameRequired': 'Enter a session name',
  'sessions.nativeHint': 'This is a native session view. It does not embed Web terminal or xterm.',
  'sessions.rename': 'Rename',
  'sessions.renamed': 'Renamed',
  'sessions.title': 'Sessions',
  'settings.backend': 'Current backend',
  'settings.clearLocal': 'Clear local data for this backend',
  'settings.clearLocalConfirm': 'This only clears the cookie and cache saved on this device for the current backend.',
  'settings.logout': 'Log out',
  'settings.notifications': 'Push notifications',
  'settings.switchBackend': 'Switch backend',
  'settings.title': 'Settings',
  'settings.version': 'Version',
}

const dictionaries: Record<Locale, Messages> = {
  'zh-CN': zh,
  'en-US': en,
}

export function normalizeLocale(locale?: string | null): Locale {
  const lower = (locale || '').toLowerCase()
  if (lower === 'zh' || lower === 'zh-cn' || lower.startsWith('zh-hans')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return 'zh-CN'
}

export function deviceLocale(): Locale {
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    return 'zh-CN'
  }
}

export function makeT(locale: Locale) {
  const dict = dictionaries[locale]
  return (key: string, vars?: Record<string, string | number>) => {
    let value = dict[key] || zh[key] || key
    if (vars) {
      for (const [name, replacement] of Object.entries(vars)) {
        value = value.replaceAll(`{${name}}`, String(replacement))
      }
    }
    return value
  }
}
