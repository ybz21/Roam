# Claude Code Required Project Instructions

This repository is Roam / ttmux. Before editing code, read:

- [AGENTS.md](AGENTS.md) for shared coding-agent rules.
- [docs/development/i18n.md](docs/development/i18n.md) for the mandatory internationalization standard.
- [docs/development/ui-design-system.md](docs/development/ui-design-system.md) before touching any Web UI.

Internationalization is required for all user-facing product UI. Do not add new hardcoded Chinese or English UI copy in React components, fallback HTML, or user-visible backend responses unless the i18n standard explicitly allows it.

## Web UI 硬规则

改前端时以下几条是强制的，细节与踩坑清单见上面的设计系统文档：

- **只用令牌，不写死数值。** 字号六档（`--fs-micro/meta/sm/body/lg/title`）、圆角四档
  （`--r-xs/sm/card/pill`）、间距五档（`--sp-1`…`--sp-5`）、强调色一组
  （`--accent` / `--accent-solid` / `--accent-soft` / `--accent-border`）、成功绿一组
  （`--ok` / `--ok-solid` / `--ok-soft` / `--ok-border`）。
  **全站蓝只有一支、绿只有一支**（品牌标同色），组件里不许再出现 `#58a6ff` / `#3fb950`
  这类十六进制。**除眉标/角标外字号不许低于 12px**，不要出现 10.5 / 11.5 / 12.5 这类半档。
- **强调色不要照抄十六进制**：antd 的 darkAlgorithm 会在 seed 上再推导一层，照抄的值
  必然比 antd 自己画的差一档。要一致就用 `--accent-solid`。
- **断点只有一个入口** `useLayout()`；不要读 `window.innerWidth`，不要自己 `matchMedia`。
  纯样式差异走 `<html>` 上的 `data-size` / `data-pointer`。
- **粗指针下命中区 ≥44**，用伪元素撑命中区、不撑视觉尺寸。
- **一级页面的页头用 `.tt-pagehead`**（眉标 + 标题 + 一句话），不要各写各的标题行。
- 前端改动不能只靠 typecheck 收工：真机验收跑法见
  [docs/development/web-ui-checklist.md](docs/development/web-ui-checklist.md)。
  提交前必过 `npm run typecheck && npm run i18n:check && npx vitest run && npm run build`。

## 图标硬规则（不许 emoji、不许文字符号）

界面上的图标**只有一种来源：SVG**。以下三类一律禁止新增，看到旧的顺手换掉：

1. **emoji**：🔄 📎 🤖 📢 📖 ✏️ 🔍 🌐 ✅ ⬜ 🏠 👤 🧭 🎨 …
   各平台字体各画各的，大小、基线、配色都不受控，一列排下来高低不齐，深色底上还常常自带白边。
2. **文字符号当图标**：`✕ × ✓ ✔ ▾ ▸ ▼ ▶ ← → ↑ ↓ ⌃ ⏎ ■ ● ○ ◆ ◁ ▭ ⚠ ⎇ ⧉ ⇡ ⇥ ⬡ ⚑ ＋ ❯ ⤷` …
   字号下与标点混作一团、粗细跟不上线性图标语言、基线随字体漂，手机字体上尤其难看。
3. **临时自画的一次性 SVG**：想要的图标没有就**加进图标模块**，不要在组件里就地画一个。

规则：

- **唯一出处 [`frontend/src/icons.tsx`](frontend/src/icons.tsx)**：24×24 viewBox、
  `stroke="currentColor"`、1.8 线宽、圆头圆角，颜色一律继承父级（不写死）。
  文件类型图标在 `frontend/src/file-icons.tsx`，Git 专用图标在 `frontend/src/git/parts.tsx`，
  这两处沿用同一套画法；**新图标默认加在 `icons.tsx`**。
- **同一个动作全站同一枚图标。** 曾经「关闭」在 Dock 是 `✕`、浏览器标签是 `×`、文件页签是
  第三种写法——这是最刺眼的一类不一致，比图标本身丑更糟。
- **图标不写进 i18n 文案。** `'＋ 新增任务'` / `'■ 停止'` / `'✓{count} 可清理'` 这种把符号
  焊死在译文里：换图标要改两份 locale，而且永远换不成 SVG。**文案只写字**，图标在调用处给：
  `icon={<PlusIcon />}`（antd 的 `Button` / `Tag` 都吃 `icon`；`Segmented` / `Menu` 的
  `label` 直接放 JSX）。
- **状态点、色块用画的，不用字符。** `●` → `border-radius:50%` 的 `<i>`；`■` 图例 →
  `<Swatch color=... />`。
- **例外只有两类**：① 键盘快捷键提示里的修饰键符号（`⌘ ⇧ ⌃`）——那是键帽的正确排版；
  ② 蜂群「办公室」插画视图里的角色头像 emoji（`Swarm.tsx` 的 `SUBROLES`），
  那是刻意的插画风格，不是功能图标。除此之外没有例外。
- 自查：改完在 `frontend/src` 下 grep 一遍 emoji 与上面那串符号（注释、TUI 输出解析用的正则
  不算），命中即是要改的。
