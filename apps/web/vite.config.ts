/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // 全 web 包统一 happy-dom（任务书约定：environment 走包级配置而非文件头注释）
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        // iframe 不真拉子页（企微扫码 iframe 的 src 是外网 URL，测试里只断言属性）
        settings: { navigation: { disableChildFrameNavigation: true } },
      },
    },
    setupFiles: ['./src/test-setup.ts'],
  },
})
