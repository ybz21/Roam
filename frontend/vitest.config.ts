import { defineConfig } from 'vitest/config'

// 下载协议纯逻辑单测（无 DOM 依赖，node 环境即可）。
// 只跑 src/p2p 下的 *.test.ts；协议正确性逻辑（seq/size 校验、writeChain 串行、
// 回退 truncate 语义、StreamSaver 信用背压）都已抽成可测纯函数/纯类。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
