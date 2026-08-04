// 单个提交的详情：元信息 + 完整提交信息 + 改动文件清单，点文件就地看该提交的差异。
// 自己拉数据（/git/show、/git/diff?rev=），外部只给 root/hash 和一个操作菜单。
import { useEffect, useState } from 'react'
import { Dropdown, Spin, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { api } from '../api'
import { useI18n } from '../i18n'
import DiffView from '../DiffView'
import { absTime, type RawRef } from './graph'
import { BackIcon, CloseIcon, CopyIcon, MONO, MoreIcon, RefBadge } from './parts'
import { DiamondIcon } from '../icons'

interface ShowFile { path: string; orig?: string; status: string; adds: number; dels: number; binary: boolean }
interface ShowData {
  hash: string; short: string; parents: string[]
  author: string; email: string; date: string; when: string
  committer: string; commitDate: string
  refs: RawRef[]; subject: string; body: string
  files: ShowFile[]; adds: number; dels: number
}

const STATUS_COLOR: Record<string, string> = {
  A: 'var(--ok)', M: 'hsl(32,85%,55%)', D: 'hsl(0,70%,60%)',
  R: 'hsl(212,78%,60%)', C: 'hsl(212,78%,60%)', T: 'hsl(280,55%,66%)',
}

export default function CommitDetail({ root, hash, accent, menu, onClose, onPickParent }: {
  root: string; hash: string; accent: string
  menu: MenuProps
  onClose: () => void
  onPickParent?: (h: string) => void
}) {
  const { t, locale } = useI18n()
  const [data, setData] = useState<ShowData | null>(null)
  const [err, setErr] = useState('')
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let stop = false
    setData(null); setErr(''); setFile(null); setDiff('')
    api('GET', `/git/show?root=${encodeURIComponent(root)}&hash=${encodeURIComponent(hash)}`)
      .then((r) => { if (!stop) setData(r.data) })
      .catch((e) => { if (!stop) setErr(e.message) })
    return () => { stop = true }
  }, [root, hash])

  useEffect(() => {
    if (!file) { setDiff(''); return }
    let stop = false
    setDiffLoading(true)
    api('GET', `/git/diff?root=${encodeURIComponent(root)}&rev=${encodeURIComponent(hash)}&file=${encodeURIComponent(file)}`)
      .then((r) => { if (!stop) setDiff(r.data?.diff || '') })
      .catch((e) => { if (!stop) setDiff(`# ${e.message}`) })
      .finally(() => { if (!stop) setDiffLoading(false) })
    return () => { stop = true }
  }, [file, root, hash])

  const copySha = async () => {
    // 非安全上下文（http 直连）没有 clipboard API，静默失败即可
    try {
      await navigator.clipboard.writeText(data?.hash || hash)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch { /* ignore */ }
  }

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px 9px 12px', borderBottom: '1px solid var(--border-subtle)', flex: '0 0 auto' }}>
      {file
        ? <button type="button" className="tt-file-close" onClick={() => setFile(null)} title={t('git.detail.backToFiles')} aria-label={t('git.detail.backToFiles')}><BackIcon /></button>
        : <span style={{ color: accent, display: 'inline-flex', flex: '0 0 auto' }}><DiamondIcon size={12} /></span>}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: 'var(--text-bright)' }}
        title={file || data?.subject}>
        {file || data?.subject || t('git.detail.loading')}
      </span>
      <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
        <button type="button" className="tt-file-close" title={t('common.more')} aria-label={t('common.more')}><MoreIcon /></button>
      </Dropdown>
      <button type="button" className="tt-file-close" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}><CloseIcon /></button>
    </div>
  )

  if (file) {
    return (
      <>
        {head}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {diffLoading ? <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}><Spin /></div>
            : diff.trim() ? <DiffView text={diff} />
              : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-dimmer)', fontSize: 13 }}>{t('git.binaryDiff')}</div>}
        </div>
      </>
    )
  }

  return (
    <>
      {head}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {err && <div style={{ color: '#f85149', fontSize: 12, padding: '10px 12px' }}>{t('git.loadFailed', { message: err })}</div>}
        {!data && !err && <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}><Spin size="small" /></div>}
        {data && (
          <>
            {/* 元信息块 */}
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ fontSize: 13.5, color: 'var(--text-bright)', lineHeight: 1.45, fontWeight: 500 }}>{data.subject}</div>
              {!!data.refs.length && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{data.refs.map((r) => <RefBadge key={r.kind + r.name} r={r} />)}</div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-dim)' }}>
                <Tooltip title={copied ? t('common.copied') : t('git.detail.copySha')}>
                  <button type="button" onClick={copySha}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: MONO, fontSize: 11.5, color: accent, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 5, padding: '1px 6px', cursor: 'pointer' }}>
                    {data.short}<span style={{ opacity: .6, display: 'inline-flex' }}><CopyIcon /></span>
                  </button>
                </Tooltip>
                <span>{data.author}</span>
                <span style={{ color: 'var(--text-dimmer)' }}>{absTime(data.date, locale)}</span>
              </div>
              {data.parents.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-dimmer)', flexWrap: 'wrap' }}>
                  <span>{t('git.detail.parents')}</span>
                  {data.parents.map((p) => (
                    <button key={p} type="button" onClick={() => onPickParent?.(p)}
                      style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--text-dim)', background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: 5, padding: '0 5px', cursor: onPickParent ? 'pointer' : 'default' }}>
                      {p.slice(0, 7)}
                    </button>
                  ))}
                  {data.parents.length > 1 && <span style={{ color: 'var(--text-dimmer)' }}>· {t('git.detail.mergeNote')}</span>}
                </div>
              )}
            </div>

            {/* 提交信息正文 */}
            {!!data.body.trim() && (
              <pre style={{ margin: 0, padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {data.body.trim()}
              </pre>
            )}

            {/* 文件清单 */}
            <div style={{ padding: '7px 12px 4px', fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 8, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600 }}>
              <span>{t('git.detail.files')}</span>
              <span style={{ color: 'var(--text-dimmer)', fontWeight: 500 }}>{data.files.length}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, textTransform: 'none', letterSpacing: 0 }}>
                <span style={{ color: 'var(--ok)' }}>+{data.adds}</span> <span style={{ color: 'hsl(0,72%,62%)' }}>−{data.dels}</span>
              </span>
            </div>
            {!data.files.length && (
              <div style={{ padding: '6px 12px 12px', fontSize: 12, color: 'var(--text-dimmer)' }}>{t('git.detail.noFiles')}</div>
            )}
            {data.files.map((f) => (
              <div key={f.path} className="cc-filerow" onClick={() => setFile(f.path)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', cursor: 'pointer', fontSize: 12.5 }}>
                <span style={{ width: 13, flex: '0 0 auto', textAlign: 'center', fontFamily: MONO, fontWeight: 700, fontSize: 11.5, color: STATUS_COLOR[f.status] || 'var(--text-dim)' }}>{f.status}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-bright)' }} title={f.orig ? `${f.orig} → ${f.path}` : f.path}>
                  {f.orig && <span style={{ color: 'var(--text-dimmer)' }}>{f.orig.split('/').pop()} → </span>}
                  {f.path.split('/').pop()}
                  {f.path.includes('/') && <span style={{ color: 'var(--text-dimmer)', fontSize: 11, marginLeft: 6 }}>{f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
                </span>
                <span style={{ flex: '0 0 auto', fontFamily: MONO, fontSize: 11 }}>
                  {f.binary ? <span style={{ color: 'var(--text-dimmer)' }}>bin</span>
                    : <><span style={{ color: 'var(--ok)' }}>+{f.adds}</span> <span style={{ color: 'hsl(0,72%,62%)' }}>−{f.dels}</span></>}
                </span>
              </div>
            ))}
            <div style={{ height: 12 }} />
          </>
        )}
      </div>
    </>
  )
}
