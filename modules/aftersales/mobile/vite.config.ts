import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // ⚠️ 必须与 manifest 的 `userApp.mount` 一致（M3b-2 I2）：
  // 不设 base ⇒ index.html 引用**站点绝对**的 `/assets/*`，而 apps/web 的 vite 产物也在
  // `/assets/*`（app.ts 的全局 serveStatic 在给 web 供文件）⇒ 移动端会加载到 **console 的**
  // 同路径产物（或反之），症状是白屏/杂壳，且两侧都「构建成功」。
  base: '/app/aftersales/',
  plugins: [vue()],
  resolve: {
    alias: {
      // 三个 shim 用**别名**而不是三个 workspace 包：源码里的 import 字面量
      // （`from '@wujibase/wuji-data'`）因此**一字不改**，「整包搬」才成立。
      // 键是**精确匹配 + '/子路径'**语义（vite 的 alias 实现），故 `@wujibase/wuji`
      // 不会误吃 `@wujibase/wuji-data`（后者不以 `@wujibase/wuji/` 开头）。
      '@wujibase/wuji': here('./src/shims/wuji.ts'),
      '@wujibase/wuji-data': here('./src/shims/wuji-data.ts'),
      '@wujibase/wuji-upload': here('./src/shims/wuji-upload.ts'),
      '@': here('./src'),
    },
  },
  test: {
    environment: 'happy-dom',
  },
})
