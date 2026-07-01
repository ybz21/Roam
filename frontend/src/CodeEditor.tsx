// Monaco 代码编辑器（VSCode 同款内核）：行号、语法高亮、编辑、查找、Ctrl+S 保存。
// 依赖较重，仅由 FileBrowser 的 Viewer 懒加载引入，不进首屏包。
// 用本地打包的 monaco（loader.config），不依赖 CDN，离线/局域网也能用。
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Vite 用 ?worker 把各语言 worker 单独打包，用到才取（编辑时才加载）。
;(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  },
}
loader.config({ monaco })

export default function CodeEditor({
  value, language, dark, readOnly, onChange, onSave,
}: {
  value: string
  language: string
  dark: boolean
  readOnly?: boolean
  onChange: (v: string) => void
  onSave: () => void
}) {
  // 让编辑器背景/装订线/缩略图跟应用统一（用 --bg-base，避免 Monaco 默认灰底跟四周不一致）。
  const appBg = (typeof getComputedStyle !== 'undefined'
    ? getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
    : '') || (dark ? '#0d1117' : '#ffffff')
  return (
    <Editor
      height="100%"
      value={value}
      language={language}
      theme={dark ? 'roam-dark' : 'roam-light'}
      beforeMount={(m) => {
        const colors = { 'editor.background': appBg, 'editorGutter.background': appBg, 'minimap.background': appBg, 'editorStickyScroll.background': appBg }
        m.editor.defineTheme('roam-dark', { base: 'vs-dark', inherit: true, rules: [], colors })
        m.editor.defineTheme('roam-light', { base: 'vs', inherit: true, rules: [], colors })
      }}
      onChange={(v) => onChange(v ?? '')}
      onMount={(editor, m) => {
        // Ctrl/Cmd+S 保存（onSave 读最新 draft，见 Viewer）
        editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => onSave())
      }}
      options={{
        readOnly,
        fontSize: 13,
        minimap: { enabled: true }, // 右侧代码缩略图：显示整段代码长度与当前所在位置（VSCode 同款）
        lineNumbers: 'on',
        // 行号装订线：关掉字形边距/折叠栏（那才是之前的大缝隙），保留 VSCode 同款行号↔代码间距
        glyphMargin: false,
        folding: false,
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 10,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'selection',
        smoothScrolling: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}
    />
  )
}
