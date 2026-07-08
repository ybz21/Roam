// PDF 展示：iframe 内嵌后端 raw（浏览器原生 PDF 阅读器）。
import { PreviewShell } from './PreviewShell'
import { useI18n } from '../i18n'

export function PdfView({ path, rawUrl, name, inline, truncated }: {
  path: string
  rawUrl: string
  name: string
  inline?: boolean
  truncated?: boolean
}) {
  const { t } = useI18n()
  return (
    <PreviewShell path={path} title={t('file.pdfPreview')} inline={inline} truncated={truncated}>
      <iframe title={name} src={rawUrl} style={{ width: '100%', height: '100%', border: 0, background: '#fff' }} />
    </PreviewShell>
  )
}
