import { defineConfig } from 'vitest/config'

// 纯逻辑测试默认跑 node；需要真实 DOM 交互的组件测试在文件头用
// @vitest-environment jsdom 单独切换环境。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
