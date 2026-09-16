/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const c: DefineComponent<{}, {}, any>
  export default c
}

/**
 * 源侧的**宿主全局**（`gogo-runtime-stuff.d.ts` 声明、页面直接当裸标识符调用）。
 * 我们在 main.ts 里补一个退化实现（设 document.title）。
 *
 * ⚠️ **`window.w.global.appid` 刻意不补**：引用它的是页内那段前端微信 OAuth，
 * 而那些块在移植时**整体删除**（spec §3.2：身份只有 session 一份来源）。
 * 若哪次改动让它又冒出来，请在类型上就不给（编译期红好过运行期白屏）。
 */
declare function defineWujiPageMeta(options: { title: string; description?: string }): void

interface Window {
  /** main.ts 里赋的退化实现（`declare function` 声明的是全局函数，赋值目标是 window） */
  defineWujiPageMeta?: (options: { title: string; description?: string }) => void
}
