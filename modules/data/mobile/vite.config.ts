import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // ⚠️ 必须与 manifest 的 `userApp.mount` 一致（aftersales/mobile 同款坑，M3b-2 I2）：
  // 不设 base ⇒ index.html 引用站点绝对的 `/assets/*`，与 apps/web 的 console 产物同路径
  // ⇒ 移动端加载到 console 的产物（白屏/杂壳），且两侧都「构建成功」。
  base: '/app/data/',
  plugins: [react()],
  test: {
    environment: 'happy-dom',
  },
})
