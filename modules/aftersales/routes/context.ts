// 路由层的两个共享类型。单独一个文件是为了让 T6–T9 四个域互相不 import（避免循环与耦合），
// 只共同依赖这里。
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
