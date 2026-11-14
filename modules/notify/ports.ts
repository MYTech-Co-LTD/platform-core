// ports-v2.ts — notify 模块供给宿主的端口（expand 阶段文件；Task 15 rename 为 ports.ts）。
import type { Pool } from 'pg'
import type { EnqueueEventInput } from '@platform/sdk'
import { enqueueEvent, getEventDecl } from './storage'

export function createPorts(ctx: { pool: Pool }) {
  return {
    enqueueEvent: (input: EnqueueEventInput) =>
      enqueueEvent(ctx.pool, input),
    // 宿主 ctx.notify.emit 的 tenant fallback：平台事件走内存目录，ext.* 走本端口。
    resolveEventDecl: (org: string, key: string) =>
      getEventDecl(ctx.pool, org, key),
  }
}
