// domain/errors.ts — forms 的机检错误码载体（OA P1 起独立成文件）。
//
// 为什么从 storage.ts 挪出来：审批编译/引擎 client 都要抛同一族错误，而 storage 反过来
// 要调编译与 client ⇒ 若错误类留在 storage 就形成 ESM 环（类型的循环引用能过，值的循环
// 引用会在装载期埋雷）。错误类型是**跨层契约**，放 domain 层最自然；storage 继续 re-export
// 以保持既有 `import { FormsError } from './storage'` 调用点零改动。
export class FormsError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ?? code)
  }
}
