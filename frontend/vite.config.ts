import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发期把 /api（含 WebSocket）代理到后端 Gin（:8080）
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
    },
  },
})
