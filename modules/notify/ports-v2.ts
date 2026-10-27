// ports-v2.ts — notify 模块供给宿主的端口（expand 阶段文件；Task 15 rename 为 ports.ts）。
import type { Pool } from 'pg'
import type { EnqueueEventInput } from '@platform/sdk'
import { enqueueEvent } from './storage-v2'

export function createPortsV2(ctx: { pool: Pool }) {
  return {
    enqueueEvent: (input: EnqueueEventInput) =>
      enqueueEvent(ctx.pool, input),
  }
}
