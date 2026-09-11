import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  test: { css: true },
})
