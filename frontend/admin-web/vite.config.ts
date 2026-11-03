import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 管理站构建与测试加载此配置，将资源部署到 /admin/ 并在测试中启用样式处理。
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  test: { css: true },
})
