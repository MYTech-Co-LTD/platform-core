// 路由层的共享层：两个**类型**（ModuleHono / RouteCtx）**外加**参数解析的**运行时常量**与解析器
// （分页 `parsePageParam` + 路径 id `parseIdParam`）。
// 单独一个文件是为了让 T6–T9 四个域互相不 import（避免循环与耦合），只共同依赖这里。
// ⚠️ 因此本文件有**值导出**：引类型请务必 `import type`，别把类型当值引（#44 的形状，
//    typecheck 与直连 src 的单测都拦不住，本仓护栏只加载 auth-core 的桶、照不到这里）。
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import type { ZosStorage } from '../storage'

/** 模块路由的统一类型：identity 由宿主注入（模块自己【不写】门禁，spec/协议见 module-protocol）。 */
export type ModuleHono = Hono<{ Variables: { identity: Identity } }>

/** 每个域注册时拿到的依赖。storage 可能为 null（没配 ZOS 凭证），见 storage.ts 的说明。 */
export interface RouteCtx {
  pool: Pool
  storage: ZosStorage | null
}

/** 列表分页上界：模块自己的护栏，防止 size=99999 一次拉全表。 */
export const MAX_PAGE_SIZE = 100
export const DEFAULT_PAGE_SIZE = 20

/** 门店是选择器数据（源侧 322 行），一次给全但设上界。**管理面与访客面共用这一个**。 */
export const MAX_STORES = 1000

/**
 * 分页参数解析（page/size 共用）。**全仓唯一一份**——T6 的管理端列表与访客列表都从这里取，
 * 两份实现会静默漂移：修复前 `?size=-5` ⇒ 管理端回落 20、访客端夹成 1（同一参数两个端点两种语义）。
 *
 * 口径：非整数 / < 1 / 空 / NaN / Infinity ⇒ 回落 fallback（**不是 400**，回落是本模块既定的统一口径）；
 * 大于 max ⇒ 夹到 max。
 *
 * 守卫不是「防御性编程」而是必需：非法值（1.5 / Infinity）直接落进 pg 的 limit/offset 参数位会抛
 * 22P02 ⇒ Hono 兜成 500，且参数完全由客户端控制（实测 `?page=1.5&size=1` 曾 500）。
 */
export function parsePageParam(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}

/**
 * 路径参数里的 id（`/rules/:id` 一类的 `:id` 段）。**全仓唯一一份**，与 `parsePageParam` 同址同因：
 * 7 处内联守卫一字不差，分开修必然写出 7 份实现 ⇒ 重造 `parsePageParam` 当初被消灭的那种漂移。
 *
 * 口径：**只接受十进制正整数字面量**，其余一律 `null`。
 *   · 非规范字面量（`1.0` / `1e2` / 前导 `+`）**拒绝**——`Number('1.0') === 1`、`Number('1e2') === 100`，
 *     旧守卫会把它【静默当作某个 id】，属歧义不是特性；
 *   · `Number.isInteger(1e23) === true` ⇒ 旧守卫放行，值直接落进 pg 的 bigint 参数位 ⇒
 *     22P02 ⇒ Hono 兜成 **500**（实测 `GET …/tickets/1e23`）。`Number.isSafeInteger` 同时否掉
 *     越界值与指数记法（`1e23` 不是安全整数）。
 *
 * 只回 `null`，**状态码由各调用点自己决定**（本模块里 400 与 404 都有，语义各不相同，不在这里统一）。
 */
export function parseIdParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
