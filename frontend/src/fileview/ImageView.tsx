// 图片展示：居中自适应，直接走后端 raw。
export function ImageView({ rawUrl, name }: { rawUrl: string; name: string }) {
  return (
    <div style={{ height: '100%', textAlign: 'center', background: 'var(--bg-base)', borderRadius: 8, padding: 12, display: 'grid', placeItems: 'center' }}>
      <img src={rawUrl} alt={name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
    </div>
  )
}
