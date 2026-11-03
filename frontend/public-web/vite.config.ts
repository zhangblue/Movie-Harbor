import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 公开站构建加载此配置，通过 React 插件处理页面组件并使用默认站点根路径。
export default defineConfig({
  plugins: [react()],
})
