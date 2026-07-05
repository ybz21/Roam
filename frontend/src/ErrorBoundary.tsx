// 错误边界：兜住子树渲染时抛出的错误（尤其是 React.lazy 懒加载 chunk 失败——
// 自签证书未受信任/网络问题会让按需拉取的 Monaco/Mermaid/Office chunk 加载失败，
// 若不兜住会让整个应用白屏崩溃）。改为就地显示「加载失败·重试」，其余界面照常可用。
import { Component, Fragment, type ReactNode } from 'react'
import { Button } from 'antd'
import { useI18n } from './i18n'

function Fallback({ retry, error }: { retry: () => void; error: Error }) {
  const { t } = useI18n()
  const msg = /Loading chunk|dynamically imported module|Failed to fetch|import\(\)/i.test(error.message)
    ? t('error.chunkFailed')
    : (error.message || t('error.generic'))
  return (
    <div style={{ padding: 20, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ color: '#d29922' }}>⚠ {msg}</div>
      <Button size="small" onClick={retry}>{t('error.retry')}</Button>
    </div>
  )
}

export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; nonce: number }
> {
  state = { error: null as Error | null, nonce: 0 }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  retry = () => this.setState((s) => ({ error: null, nonce: s.nonce + 1 }))
  render() {
    if (this.state.error) return <Fallback retry={this.retry} error={this.state.error} />
    // nonce 变化 → 子树(含 lazy)整体重挂载，重新尝试加载 chunk
    return <Fragment key={this.state.nonce}>{this.props.children}</Fragment>
  }
}
