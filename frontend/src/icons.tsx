// 全站通用图标（设计系统 §2「箭头等符号用 SVG 图标，不要 → ← ⌃ 这类文字符号」）。
//
// 之前按钮上散着三套东西：文字符号（✕ × ▾ ▸ ← ↑ ↓ ✓ ○ ◁ ▭ ■ ⚠）、emoji（🔄 📎 🤖 👤 📢）、
// 以及各文件自画的 SVG。前两类在手机字体上会跟标点混作一团、粗细跟不上线性图标，
// 而且同一个动作在不同页面长得不一样——关闭在 Dock 是 ✕、在浏览器标签是 ×、在文件页签又是另一个。
//
// 这里是唯一的出处：24×24 viewBox、stroke=currentColor、1.8 线宽、圆头圆角，
// 与 file-icons.tsx / git/parts.tsx 既有图标同款，颜色一律继承父级（不写死）。
import type { ReactNode } from 'react'

type P = { size?: number }

const line = (d: ReactNode, size: number, sw = 1.8) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
)
const solid = (d: ReactNode, size: number) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>{d}</svg>
)

// ── 基础动作 ──
export const CloseIcon = ({ size = 14 }: P) => line(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>, size, 2)
export const CheckIcon = ({ size = 14 }: P) => line(<path d="m5 12.5 4.5 4.5L19 7" />, size, 2.2)
export const PlusIcon = ({ size = 14 }: P) => line(<path d="M12 5v14M5 12h14" />, size, 2.2)
export const CopyIcon = ({ size = 13 }: P) => line(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5.5A2.5 2.5 0 0 0 12.5 4H6a2 2 0 0 0-2 2v6.5A2.5 2.5 0 0 0 6.5 15" /></>, size)
export const RefreshIcon = ({ size = 14 }: P) => line(
  <><path d="M21 12a9 9 0 0 1-15 6.7" /><path d="M3 12A9 9 0 0 1 18 5.3" /><path d="M18 2v4h-4" /><path d="M6 22v-4h4" /></>, size)
export const MoreIcon = ({ size = 15 }: P) => solid(
  <><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></>, size)
export const PaperclipIcon = ({ size = 15 }: P) => line(
  <path d="M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3 3 0 0 1 4.3 4.3l-7.7 7.7a1.5 1.5 0 0 1-2.1-2.1l7-7" />, size)
/** 继续 / 恢复：原来写作 ▶ */
export const PlayIcon = ({ size = 12 }: P) => solid(<path d="M8 5.5v13l11-6.5Z" />, size)
export const StopIcon = ({ size = 12 }: P) => solid(<rect x="6" y="6" width="12" height="12" rx="2" />, size)

// ── 方向 ──
export const ChevronLeft = ({ size = 15 }: P) => line(<path d="m15 18-6-6 6-6" />, size, 2)
export const ChevronRight = ({ size = 15 }: P) => line(<path d="m9 18 6-6-6-6" />, size, 2)
export const ChevronDown = ({ size = 13 }: P) => line(<path d="m6 9 6 6 6-6" />, size, 2.2)
export const ChevronUp = ({ size = 13 }: P) => line(<path d="m6 15 6-6 6 6" />, size, 2.2)
/** 展开箭头：收起时朝右，展开时转 90°——同一枚图标转过去，比 ▸/▾ 两个字符稳定 */
export const Disclosure = ({ open, size = 12 }: P & { open: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden
    style={{ transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }}><path d="m9 18 6-6-6-6" /></svg>
)
export const ArrowUp = ({ size = 12 }: P) => line(<><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></>, size, 2.2)
export const ArrowDown = ({ size = 12 }: P) => line(<><path d="M12 5v14" /><path d="m6 13 6 6 6-6" /></>, size, 2.2)
/** 回车键：原来写作 ⏎ */
export const EnterIcon = ({ size = 16 }: P) => line(<><path d="M20 5v6a3 3 0 0 1-3 3H4.5" /><path d="m9 9-5 5 5 5" /></>, size, 2)
export const ArrowToBottom = ({ size = 13 }: P) => line(<><path d="M12 4v10" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>, size, 2)
/** 外链 / 在别处打开：原来写作 ↗ */
export const OpenInIcon = ({ size = 13 }: P) => line(<><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>, size)

// ── 状态 ──
export const WarnIcon = ({ size = 14 }: P) => line(
  <><path d="M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4" /><path d="M12 17h.01" /></>, size)
export const InfoIcon = ({ size = 14 }: P) => line(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>, size)
export const QuestionIcon = ({ size = 14 }: P) => line(
  <><circle cx="12" cy="12" r="9" /><path d="M9.4 9.2A2.7 2.7 0 0 1 14.6 10c0 1.8-2.6 2.3-2.6 4" /><path d="M12 17.5h.01" /></>, size)
export const BlockIcon = ({ size = 14 }: P) => line(<><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.5h.01" /></>, size)
export const TargetIcon = ({ size = 14 }: P) => line(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" /></>, size)
export const MegaphoneIcon = ({ size = 14 }: P) => line(
  <><path d="M4 10v4a1 1 0 0 0 1 1h3l7 4V5L8 9H5a1 1 0 0 0-1 1Z" /><path d="M18.5 9a4 4 0 0 1 0 6" /></>, size)
export const FlagIcon = ({ size = 13 }: P) => line(<><path d="M5 21V4" /><path d="M5 4.5h11l-2 4 2 4H5" /></>, size)
export const StarIcon = ({ size = 14, filled }: P & { filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
    strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8Z" /></svg>
)
export const CloudIcon = ({ size = 13 }: P) => line(<path d="M6.5 18a4.5 4.5 0 0 1-.4-9 6 6 0 0 1 11.6 1.4A3.8 3.8 0 0 1 17.5 18Z" />, size)
export const LinkIcon = ({ size = 13 }: P) => line(
  <><path d="M10 13a4 4 0 0 0 6 .5l2.5-2.5a4 4 0 0 0-5.7-5.7L11.5 6.7" /><path d="M14 11a4 4 0 0 0-6-.5L5.5 13a4 4 0 0 0 5.7 5.7l1.3-1.3" /></>, size)

// ── 领域物件 ──
/** 蜂群：原来写作 ⬡（六边形字符），在多数字体里比正文小半档还带自己的边距 */
/** 外部 / 在别处占着：原来写作 ⧉ */
export const WindowsIcon = ({ size = 12 }: P) => line(<><rect x="3" y="6" width="12" height="12" rx="2" /><path d="M9 6V4.5a1.5 1.5 0 0 1 1.5-1.5H19.5A1.5 1.5 0 0 1 21 4.5V13.5a1.5 1.5 0 0 1-1.5 1.5H18" /></>, size)
/** 回复某条：原来写作 ⤷ */
export const ReplyIcon = ({ size = 12 }: P) => line(<><path d="M7 5v5a3 3 0 0 0 3 3h8" /><path d="m14 9 4 4-4 4" /></>, size)
export const SwarmIcon = ({ size = 13 }: P) => line(<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6Z" />, size)
/** 合入 / 已并到主干：原来写作 ⇥ */
export const MergeIcon = ({ size = 13 }: P) => line(
  <><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M6 8.2v7.6" /><path d="M8.2 6h3.3a4 4 0 0 1 4 4v.3" /><path d="M8.2 18h3.3a4 4 0 0 0 4-4v-.3" /></>, size)
/** 已推送到远端：原来写作 ⇡ */
export const PushIcon = ({ size = 13 }: P) => line(<><path d="M12 20V8" /><path d="m7 13 5-5 5 5" /><path d="M6 4h12" /></>, size)
export const BotIcon = ({ size = 14 }: P) => line(
  <><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4.5V8" /><circle cx="12" cy="3.4" r="1.2" /><path d="M9 13h.01" /><path d="M15 13h.01" /></>, size)
export const UserIcon = ({ size = 14 }: P) => line(<><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>, size)
export const ClockIcon = ({ size = 13 }: P) => line(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.2 2" /></>, size)
export const CircleIcon = ({ size = 13 }: P) => line(<circle cx="12" cy="12" r="8" />, size)
export const DotIcon = ({ size = 13 }: P) => solid(<circle cx="12" cy="12" r="4.5" />, size)
/** 指挥/领队：原来写作 ◆ */
export const DiamondIcon = ({ size = 13 }: P) => solid(<path d="m12 3.5 8.5 8.5-8.5 8.5L3.5 12Z" />, size)

// ── Agent 工具调用的类型图标（原来一列 emoji：📖 ✏️ 📓 🔍 🤖 🌐 ❓ ⚙）──
export const TerminalIcon = ({ size = 13 }: P) => line(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>, size)
export const ReadIcon = ({ size = 13 }: P) => line(
  <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5Z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5Z" /></>, size)
export const PencilIcon = ({ size = 13 }: P) => line(<><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5Z" /><path d="m14.5 5.5 3 3" /></>, size)
export const NotebookIcon = ({ size = 13 }: P) => line(<><rect x="5" y="3" width="15" height="18" rx="2" /><path d="M9 3v18" /><path d="M13 8h3" /><path d="M13 12h3" /></>, size)
export const SearchIcon = ({ size = 13 }: P) => line(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>, size)
// 搜索结果里区分「这是个文件夹/项目」还是「这是个文件」。按类型细分的文件图标在
// file-icons.tsx，那是文件列表的活；这里只要一个中性的通用件。
export const PlugIcon = ({ size = 13 }: P) => line(
  <><path d="M9 3v5" /><path d="M15 3v5" /><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0Z" /><path d="M12 17v4" /></>, size)
export const FolderIcon = ({ size = 13 }: P) => line(
  <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h3.6l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" />, size)
export const FileTextIcon = ({ size = 13 }: P) => line(
  <><path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5Z" /><path d="M13.5 3.5v5h5" /><path d="M9 13h6" /><path d="M9 16.5h4" /></>, size)
export const ImageIcon = ({ size = 13 }: P) => line(<><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="m4 17 5-5 4 4 3-2.5 4 3.5" /></>, size)
export const GlobeIcon = ({ size = 13 }: P) => line(<><circle cx="12" cy="12" r="9" /><path d="M3.3 9h17.4" /><path d="M3.3 15h17.4" /><path d="M12 3a15 15 0 0 1 0 18" /><path d="M12 3a15 15 0 0 0 0 18" /></>, size)
export const GearIcon = ({ size = 13 }: P) => line(
  <><circle cx="12" cy="12" r="3" /><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1v-.3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1Z" /></>, size)
export const ChecklistIcon = ({ size = 13 }: P) => line(<><path d="m3 6 2 2 3-3" /><path d="m3 14 2 2 3-3" /><path d="M12 7h9" /><path d="M12 15h9" /></>, size)
export const KeyboardIcon = ({ size = 13 }: P) => line(
  <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M7 10h.01" /><path d="M11 10h.01" /><path d="M15 10h.01" /><path d="M8 14h8" /></>, size)
export const HomeIcon = ({ size = 13 }: P) => line(<><path d="M3.5 11.5 12 4.5l8.5 7" /><path d="M6 10v9.5h12V10" /></>, size)
export const MoonIcon = ({ size = 13 }: P) => line(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />, size)
export const SunIcon = ({ size = 13 }: P) => line(
  <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2" /><path d="M12 19.5v2" /><path d="M2.5 12h2" /><path d="M19.5 12h2" /><path d="m5.3 5.3 1.4 1.4" /><path d="m17.3 17.3 1.4 1.4" /><path d="m18.7 5.3-1.4 1.4" /><path d="m6.7 17.3-1.4 1.4" /></>, size)

// ── 手机遥控（PhoneView）：安卓/iOS 的系统键，原来用 ○ ◉ ◁ ▭ 四个字符凑 ──
// 镜像两页页头用（设计 17）：标签数字钮的方框、设备芯片的机身、应用启动器的九宫格
export const TabsIcon = ({ size = 18 }: P) => line(<rect x="3" y="3" width="18" height="18" rx="3" />, size, 1.7)
export const DeviceIcon = ({ size = 13 }: P) => line(
  <><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18.5h2" /></>, size)
export const AppsIcon = ({ size = 16 }: P) => line(
  <><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></>, size, 1.7)

export const PhoneHomeIcon = ({ size = 16 }: P) => line(<circle cx="12" cy="12" r="8" />, size, 2)
export const PhoneBackIcon = ({ size = 16 }: P) => line(<path d="M15 5 7 12l8 7Z" />, size, 2)
export const PhoneRecentsIcon = ({ size = 16 }: P) => line(<rect x="5" y="6" width="14" height="12" rx="2" />, size, 2)
export const PhoneAssistIcon = ({ size = 16 }: P) => line(
  <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></>, size, 2)
export const PowerIcon = ({ size = 16 }: P) => line(<><path d="M12 3.5v8" /><path d="M17.7 6.8a8 8 0 1 1-11.4 0" /></>, size, 2)

// ── 镜像页（BrowserView / PhoneView）的工具条 ──
// 这三枚原来是就地画在组件里的一次性 SVG（旋转那枚还是 Material 的实心件，
// 线宽/填充都跟旁边的线性图标对不上），按「新图标默认加在 icons.tsx」收进来。
/** 旋转画面 90°：设备框 + 绕角的回转箭头，明显区别于刷新的整环箭头 */
export const RotateScreenIcon = ({ size = 15 }: P) => line(
  <><rect x="3" y="7.5" width="11" height="13.5" rx="1.8" /><path d="M9.5 3.5h6.5A4.5 4.5 0 0 1 20.5 8v4" /><path d="m12 6 2.6-2.5L12 1" /></>, size)
/** 开发者工具：尖括号，取代文字按钮「调试」 */
export const CodeIcon = ({ size = 15 }: P) => line(<><path d="m8 8-4.5 4L8 16" /><path d="m16 8 4.5 4L16 16" /><path d="m13.5 5-3 14" /></>, size)
/** 启动应用：方框里一个向右的箭头 */
export const AppLaunchIcon = ({ size = 13 }: P) => line(
  <><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M9 12h6" /><path d="m12.5 9 3 3-3 3" /></>, size)

/** 图例色块：原来写作 ■（实心方块字符），高度和基线跟着字体走 */
export const Swatch = ({ color, size = 9 }: { color: string; size?: number }) => (
  <span aria-hidden style={{
    display: 'inline-block', width: size, height: size, borderRadius: 2,
    background: color, flex: '0 0 auto',
  }} />
)
