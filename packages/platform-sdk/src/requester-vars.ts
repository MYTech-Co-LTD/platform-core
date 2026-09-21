// 请求者上下文变量名（三通道共用）。
// 用**计算键名**而非字面量——字面量是第二份事实源，改名时它不会跟着改，
// 症状是**静默拿不到通道**（与 module.ts 的 TENANT_STORAGE 同一条理由）。
//
// 语义：**未设置 = 系统内会话通道**（sessionMiddleware 不设这两个变量）。
export const REQUESTER_CHANNEL = 'platform.requesterChannel'
export const REQUESTER_KEY_ID = 'platform.requesterKeyId'

/**
 * 上面两个变量的 **`Variables` 片段**（一个键→值的映射，**不是** Env，也**不是** Env 片段）。
 *
 * ⚠️ 用法只有一个形状：**求交进 `Variables`**。
 *   宿主：`TenantEnv & SessionEnv & { Variables: RequesterVars }`（T5，见该任务 pat-auth.ts）
 *   模块：`{ Variables: { identity: Identity; tenant: DataTenant } & RequesterVars }`（T6）
 *   **绝不写成 `ModuleVars & RequesterVars`**——那会把两个键搁到 Env **顶层**
 *   （Env 只认 `Bindings` / `Variables` 两个字段），结果 `c.get(REQUESTER_CHANNEL)` 恒 `undefined`：
 *   表现为**限速与审计静默丢失归属**，typecheck 不报错（`c.get` 的重载会退化成宽松签名）。
 *
 * `REQUESTER_*` 是 `const` 字面量 ⇒ 计算键名推出来的是**字面量键**（照 loader.ts:61 的写法）。
 */
export type RequesterVars = {
  [REQUESTER_CHANNEL]?: 'pat' | 'wecom'
  [REQUESTER_KEY_ID]?: number
}
