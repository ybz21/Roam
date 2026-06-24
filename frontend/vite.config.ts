import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期把 /api（含 WebSocket）代理到后端 Gin（:8080）
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // antd 是全站基座，单独成块就有 ~800kB+ 属正常，调高阈值避免对合理的 vendor 块误报。
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 把第三方库按用途拆成独立 vendor 块：避免挤成一个 ~3MB 巨块，
        // 各块可被浏览器分别缓存（改业务代码不致使整包失效），按需并行加载。
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          // Office 预览（docx/xlsx/pptx）很重，仅看 Office 文件时才用 → 独立块（配合 FileBrowser 懒加载按需取）
          if (/docx-preview|xlsx|pptx|jvmr/.test(id)) return 'office'
          // 注：markdown 渲染链（react-markdown + 庞大的 unified/micromark/hast 生态）不单独拆块——
          // 它与其它库共享 unist/hast 等工具，强行拆会造成 markdown↔vendor 循环依赖，故整体并入 vendor。
          if (id.includes('@xterm')) return 'xterm'
          if (/hello-pangea/.test(id)) return 'dnd'
          if (/antd|@ant-design|rc-/.test(id)) return 'antd'
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
    },
  },
})
