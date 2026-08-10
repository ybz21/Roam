// ── 登录 ──
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../../api'
import { svg } from '../nav-icons'
import { useI18n } from '../../i18n'
import { Button, Card, Checkbox, Form, Input, Spin, App as AntApp } from 'antd'

const PW_KEY = 'ttmux_pw' // 「记住密码」本地存储键
export default function Login({ onOk }: { onOk: () => void }) {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [totp, setTotp] = useState(false) // 是否开启两步验证
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null) // 首次是否需设置口令
  const saved = (() => { try { return localStorage.getItem(PW_KEY) || '' } catch { return '' } })()

  // 问后端是否要动态码 / 是否需首次设置口令（公开端点）
  useEffect(() => {
    api('GET', '/pubconfig')
      .then((r) => { setTotp(!!r?.data?.totp); setNeedsSetup(!!r?.data?.needsSetup) })
      .catch(() => setNeedsSetup(false))
  }, [])

  const Brand = (
    <div style={{ textAlign: 'center', marginBottom: 18 }}>
      <img src="/logo-mark.svg" width={64} height={64} alt="Roam" />
      <div style={{
        fontSize: 30, fontWeight: 800, letterSpacing: 1, marginTop: 12,
        background: 'var(--brand-grad)',
        WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
      }}>Roam</div>
      <div style={{ color: 'var(--text-dimmer)', fontSize: 12, marginTop: 4, letterSpacing: 0.5 }}>{t('auth.tagline')}</div>
    </div>
  )

  const shell = (children: ReactNode) => (
    <div style={{ height: '100dvh', display: 'grid', placeItems: 'center', padding: 16, background: 'var(--bg-base)' }}>
      <Card style={{ width: 'min(360px,92vw)' }}>{Brand}{children}</Card>
    </div>
  )

  // 加载中：pubconfig 未回来前不闪现登录表单
  if (needsSetup === null) return shell(<div style={{ textAlign: 'center', padding: 12 }}><Spin /></div>)

  // 首次：必须先设置口令，成功即已登录
  if (needsSetup) {
    return shell(
      <Form
        layout="vertical"
        onFinish={async (v) => {
          setLoading(true)
          try {
            await api('POST', '/setup', { password: v.password })
            onOk()
          } catch (e: any) {
            message.error(/WEAK_PASSWORD/.test(e.message) ? t('auth.passwordMin') : t('auth.setupFailed'))
          } finally { setLoading(false) }
        }}
      >
        <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>{t('auth.setupHint')}</div>
        <Form.Item name="password" rules={[{ required: true, min: 6, message: t('auth.passwordMin') }]}>
          <Input.Password size="large" placeholder={t('auth.setupPassword')} autoFocus />
        </Form.Item>
        <Form.Item name="confirm" dependencies={['password']} rules={[
          { required: true, message: t('auth.confirmRequired') },
          ({ getFieldValue }) => ({ validator(_, value) { if (!value || getFieldValue('password') === value) return Promise.resolve(); return Promise.reject(new Error(t('auth.passwordMismatch'))) } }),
        ]}>
          <Input.Password size="large" placeholder={t('auth.setupConfirm')} />
        </Form.Item>
        <Button type="primary" size="large" block htmlType="submit" loading={loading}>{t('auth.setupSubmit')}</Button>
      </Form>
    )
  }

  return shell(
    <Form
      initialValues={{ password: saved, remember: !!saved }}
      onFinish={async (v) => {
        setLoading(true)
        try {
          await api('POST', '/login', { password: v.password, code: (v.code || '').trim() })
          try { v.remember ? localStorage.setItem(PW_KEY, v.password) : localStorage.removeItem(PW_KEY) } catch {}
          onOk()
        }
        catch (e: any) {
          message.error(/BAD_CODE/.test(e.message) ? t('auth.badCode') : /LOCKED/.test(e.message) ? t('auth.locked') : t('auth.loginFailed'))
        } finally { setLoading(false) }
      }}
    >
      <Form.Item name="password" rules={[{ required: true, message: t('auth.passwordRequired') }]}>
        <Input.Password size="large" placeholder={t('auth.password')} autoFocus={!saved} />
      </Form.Item>
      {totp && (
        <Form.Item name="code" rules={[{ required: true, message: t('auth.codeRequired') }]}>
          <Input size="large" placeholder={t('auth.codePlaceholder')} inputMode="numeric" maxLength={6} autoFocus={!!saved} />
        </Form.Item>
      )}
      <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 12 }}>
        <Checkbox>{t('auth.rememberPassword')}</Checkbox>
      </Form.Item>
      <Button type="primary" size="large" block htmlType="submit" loading={loading}>{t('auth.login')}</Button>
    </Form>
  )
}

// ── 概览（仪表盘）──
// 蜂群状态 → 颜色/中文
// 概览页已重构为「项目为主」的独立组件（Overview.tsx，08 设计 P6）。
