/**
 * `clientRequestId` 三条语义里**提交这一侧**的两条（轮换 / 失败不轮换），加上 payload 的收窄，
 * 与 Task 5 的 shim 单测互补：那边钉「键怎么存/怎么取」，这边钉「什么时候轮换」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { after_sales_work_order } from '@/shims/wuji-data'
import { currentClientRequestId } from '@/shims/client-request-id'
import { useWorkOrderSubmit } from './useWorkOrderSubmit'

vi.mock('@/shims/wuji-data', () => ({ after_sales_work_order: { create: vi.fn() } }))
vi.mock('@wujibase/wuji', () => ({ Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const create = vi.mocked(after_sales_work_order.create)

const ctx = (attachments: { value: unknown[] } = { value: [] }) =>
  useWorkOrderSubmit({
    selectedProduct: { value: { id: 4 } },
    selectedStore: { value: null },
    attachments,
  } as never)

beforeEach(() => {
  sessionStorage.clear()
  create.mockReset().mockResolvedValue({ id: 1, duplicated: false })
})

describe('clientRequestId 语义③（提交页）', () => {
  it('提交成功 ⇒ 幂等键被轮换（下一笔是新键，不会被判重）', async () => {
    const c = ctx()
    await c.submitWorkOrder()
    expect(create).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('aftersales.clientRequestId')).toBeNull()
    expect(currentClientRequestId()).not.toBe('')
  })

  it('提交失败 ⇒ **不**轮换（同一笔重试仍用同键，幂等才成立）', async () => {
    create.mockRejectedValue(new Error('boom'))
    const c = ctx()
    const key = currentClientRequestId()
    await c.submitWorkOrder()
    expect(sessionStorage.getItem('aftersales.clientRequestId')).toBe(key)
  })

  it('payload 只带域侧要的键：源侧的 order_number / damage_amount / related_order 一个都不发', async () => {
    const c = ctx()
    await c.submitWorkOrder()
    const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>
    // 工单号与金额由**服务端**出（spec §2.2 ③ / §0.3）：前端算的会成为第二份公式
    expect(Object.keys(payload).sort()).toEqual([
      'damage_images',
      'damage_quantity',
      'damage_reason',
      'product_id',
      'store_selection',
    ])
    expect(payload).not.toHaveProperty('order_number')
    expect(payload).not.toHaveProperty('damage_amount')
  })

  it('只带**已完成**的附件（上传中的带上会被按 id 认领，而对象可能还没落）', async () => {
    const attachments = {
      value: [
        { uploadStatus: 'completed', attachmentId: 11 },
        { uploadStatus: 'uploading', attachmentId: 12 },
        { uploadStatus: 'failed', attachmentId: 13 },
      ],
    }
    const c = ctx(attachments)
    await c.submitWorkOrder()
    const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(payload.damage_images).toEqual([{ uploadStatus: 'completed', attachmentId: 11 }])
  })
})
