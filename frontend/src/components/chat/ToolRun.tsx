// 运行组（设计 16）：一串相邻的同族工具调用共用一条左脊、一个组头。
//
// 三条硬规则，改这个文件时不要破坏：
//   ① 跑着的组永远展开；跑完且全成功的组默认折成一行。
//   ② 用户手动开合过的组，此后只听用户的——轮询回来的新数据不许把它收掉。
//   ③ 失败 / 被拒的那几条**提到组头下面单独列出**，不参与折叠。
//
// 组内不重画工具：每一条照旧交给 ToolView（同一张注册表），密度靠 .cc-run-body 里的
// 样式收敛（去掉每条自己的描边、外边距与终端底）。所以「面板」类工具（待办、任务、
// MCP、兜底卡）自动就是同一套结构，不需要各写一份。
import { memo, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { useLayout } from '../../layout'
import { ChecklistIcon, ChevronRight, GearIcon, PencilIcon, ReadIcon, TerminalIcon } from '../../icons'
import { CopyBtn, DenseProvider, DiffPane, RowSlot, ToolCard, shortPath, type Tone } from './tool-parts'
import { commandFromRaw, editParts, extractCommand, ToolView, toolStatus } from './tool-render'
import { runSummary, type Family, type Run, type ToolEntry } from './runs'

const FAM: Record<Family, { tone: Tone; icon: ReactNode; label: string }> = {
  term: { tone: 'ok', icon: <TerminalIcon />, label: 'chat.runTerm' },
  edit: { tone: 'warn', icon: <PencilIcon />, label: 'chat.runEdit' },
  read: { tone: 'accent', icon: <ReadIcon />, label: 'chat.runRead' },
  task: { tone: 'accent', icon: <ChecklistIcon />, label: 'chat.runTask' },
  other: { tone: 'neutral', icon: <GearIcon />, label: 'chat.runOther' },
}

const TONE_LINE: Record<Tone, string> = {
  accent: 'var(--accent)', ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', neutral: 'var(--border)',
}

const s = (v: any) => (v == null ? '' : String(v))

const parse = (input?: string): any => {
  const raw = s(input)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// 组内的显示单元：一条普通调用，或「同一个文件的连续几次 Edit」并成的一张 diff。
type Chunk =
  | { kind: 'one'; entry: ToolEntry }
  | { kind: 'edits'; path: string; entries: ToolEntry[] }

// 同路径、连续、且都成功的 Edit 才并——出错那条要保住自己的红条。
function chunksOf(run: Run): Chunk[] {
  if (run.family !== 'edit') return run.entries.map((entry) => ({ kind: 'one', entry } as Chunk))
  const out: Chunk[] = []
  for (const entry of run.entries) {
    const o = parse(entry.use.input)
    const p = editParts(s(entry.use.name), o)
    const ok = toolStatus(entry.result) === 'ok' && !!p?.path && !Array.isArray(o?.edits)
    const last = out[out.length - 1]
    if (ok && last && last.kind === 'edits' && last.path === p!.path) { last.entries.push(entry); continue }
    if (ok) { out.push({ kind: 'edits', path: p!.path, entries: [entry] }); continue }
    out.push({ kind: 'one', entry })
  }
  // 只有一次的「合并」没有意义，退回普通渲染
  return out.map((c) => (c.kind === 'edits' && c.entries.length < 2 ? { kind: 'one', entry: c.entries[0] } : c))
}

// 同一个文件被连着改了几处：一张卡，段间标「第 N 处」。
function MergedEdits({ path, entries }: { path: string; entries: ToolEntry[] }) {
  const { t } = useI18n()
  const { phone } = useLayout()
  const parts = entries.map((e) => editParts(s(e.use.name), parse(e.use.input))).filter(Boolean) as ReturnType<typeof editParts>[]
  return (
    <ToolCard icon={<PencilIcon />} label={t('chat.runEdit')} title={`${shortPath(path, phone ? 28 : 44)} ×${entries.length}`}
      path={path} tone="warn">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
        {parts.map((p, i) => (
          <div key={i}>
            <div className="cc-run-hunk">{t('chat.runHunk', { n: i + 1 })}</div>
            <DiffPane oldText={p!.oldText} newText={p!.newText} path={path}
              badge={p!.isNew ? t('chat.diffNew') : t('chat.diffEdit')} badgeTone={p!.isNew ? 'ok' : 'warn'} />
          </div>
        ))}
      </div>
    </ToolCard>
  )
}

function chunkKey(c: Chunk, i: number): string {
  return (c.kind === 'one' ? c.entry.use.id : c.entries[0].use.id) || `c${i}`
}

function ChunkView({ chunk }: { chunk: Chunk }) {
  if (chunk.kind === 'edits') return <MergedEdits path={chunk.path} entries={chunk.entries} />
  return <ToolView block={chunk.entry.use} result={chunk.entry.result} />
}

export const ToolRun = memo(function ToolRun({ run, isLast }: { run: Run; isLast?: boolean }) {
  const { t } = useI18n()
  // 断点只走 useLayout()（设计系统硬规则）。手风琴是**行为**不是样式，所以它进 JS；
  // 其余两端差异全在 CSS 的 data-size / pointer 上，这里一个都不判。
  const { phone } = useLayout()
  const fam = FAM[run.family] || FAM.other
  const sum = useMemo(() => runSummary(run), [run])

  // ② 用户开合优先：null = 还没表过态，按规则①③自动决定
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  // 跑的时候展开过的组，只要它还是最后一条就别急着收——正在看的东西突然塌下去很讨厌。
  // 一旦下面又来了新内容（不再是最后一条），说明视线已经走了，这时候收才不打扰。
  const wasLive = useRef(false)
  if (run.live) wasLive.current = true
  const auto = run.live || (wasLive.current && !!isLast)
  const open = userOpen ?? auto

  const chunks = useMemo(() => chunksOf(run), [run])
  // ③ 失败/被拒的条目永远在外面。收起时只画它们，展开时它们照原位排。
  const bad = useMemo(
    () => run.entries.filter((e) => { const st = toolStatus(e.result); return st === 'error' || st === 'denied' }),
    [run],
  )

  // 手机：同组同时只展开一条输出。初值指向第一条失败的——出错时人下一步一定是看为什么。
  const firstBad = chunks.findIndex((c) => c.kind === 'one' && toolStatus(c.entry.result) !== 'ok' && toolStatus(c.entry.result) !== 'running')
  const [openRow, setOpenRow] = useState<number>(firstBad)

  const copyAll = useMemo(() => {
    if (run.family !== 'term') return ''
    return run.entries.map((e) => extractCommand(parse(e.use.input)) || commandFromRaw(s(e.use.input))).filter(Boolean).join('\n')
  }, [run])

  const tone: Tone = run.errors ? 'danger' : run.denied ? 'warn' : fam.tone
  const toggle = () => setUserOpen(!open)

  // 组头写「几成功几失败」，不再另盖一枚状态徽标：失败那几条本来就展在下面，
  // 徽标会和行上的那枚一模一样地重复一次。
  const good = run.entries.length - run.errors - run.denied
  const counts = run.errors
    ? t('chat.runOkFail', { ok: good, fail: run.errors + run.denied })
    : run.denied ? t('chat.runOkDenied', { ok: good, denied: run.denied }) : ''

  return (
    <div className="cc-run" data-family={run.family} style={{ borderLeftColor: TONE_LINE[tone] }}>
      <div className={`cc-run-head${open ? ' is-open' : ''}`} role="button" tabIndex={0} aria-expanded={open}
        aria-label={`${t(fam.label)} ${run.entries.length}`}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}>
        <span className="cc-cmd-chev" style={{ transform: open ? 'rotate(90deg)' : 'none' }}><ChevronRight size={12} /></span>
        <span className="cc-run-ico" style={{ color: TONE_LINE[tone] }}>{fam.icon}</span>
        <span className="cc-run-name">{t(fam.label)}</span>
        <span className="cc-run-cnt">{run.family === 'edit' && sum.files === 1 ? `×${sum.count}` : sum.count}</span>
        <span className="cc-run-last" title={sum.last}
          style={counts ? { color: run.errors ? 'var(--danger)' : 'var(--warn)', fontFamily: 'inherit' } : undefined}>
          {counts || (open ? '' : sum.last || '')}
        </span>
        {!open && <Quant sum={sum} family={run.family} />}
        {run.live && <span className="cc-spin" />}
        {copyAll && <CopyBtn text={copyAll} title={t('chat.runCopyAll')} />}
      </div>
      {(open || bad.length > 0) && (
        <div className="cc-run-body">
          <DenseProvider>
            {open
              ? chunks.map((c, i) => (
                <RowSlot key={chunkKey(c, i)} ctl={phone ? { open: openRow === i, toggle: () => setOpenRow((v) => (v === i ? -1 : i)) } : undefined}>
                  <div data-msg-id={c.kind === 'one' ? c.entry.msgId : c.entries[0].msgId}>
                    <ChunkView chunk={c} />
                  </div>
                </RowSlot>
              ))
              : bad.map((e, i) => (
                <div key={e.use.id || i} data-msg-id={e.msgId}>
                  <ToolView block={e.use} result={e.result} />
                </div>
              ))}
          </DenseProvider>
        </div>
      )}
    </div>
  )
})

// 量感槽：右侧对齐成一列。数字被挤掉这一行就白排了，所以它 flex:0 0 auto。
function Quant({ sum, family }: { sum: ReturnType<typeof runSummary>; family: Family }) {
  const { t } = useI18n()
  if (family === 'term') return sum.lines ? <span className="cc-run-slot">{t('chat.outputLines', { count: sum.lines })}</span> : null
  if (family === 'edit') {
    return (
      <>
        {!!sum.files && sum.files > 1 && <span className="cc-run-slot">{t('chat.runFiles', { count: sum.files })}</span>}
        {!!sum.plus && <span className="cc-run-slot" style={{ color: 'var(--ok)' }}>+{sum.plus}</span>}
        {!!sum.minus && <span className="cc-run-slot" style={{ color: 'var(--danger)' }}>−{sum.minus}</span>}
      </>
    )
  }
  if (family === 'task' && sum.total) {
    return <span className="cc-run-slot">{t('chat.todoProgress', { done: sum.done || 0, total: sum.total })}</span>
  }
  return null
}
