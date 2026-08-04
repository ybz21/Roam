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
- **箭头等符号用 SVG 图标**，不要 `→ ← ⌃ ✕ ▾ ✓ ⎇` 文字符号，也不要 emoji。图标统一从
  `frontend/src/icons.tsx` 取；同一个动作全站同一枚图标；**图标不写进 i18n 文案**
  （文案只写字，调用处 `icon={<PlusIcon />}`）。
- 前端改动不能只靠 typecheck 收工：真机验收跑法见
  [docs/development/web-ui-checklist.md](docs/development/web-ui-checklist.md)。
  提交前必过 `npm run typecheck && npm run i18n:check && npx vitest run && npm run build`。
