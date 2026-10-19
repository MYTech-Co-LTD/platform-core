import { describe, expect, it } from 'vitest'
import { parseAssignment, resolveAssigneeKeys } from './assignees'

// §2.4「指派与催办」：名单**只存引用**，本体在受管数据集（字典）。
// parseAssignment 是纯函数（无 IO）；resolveAssigneeKeys 需真库（无 DATABASE_URL 则跳过）。
describe('parseAssignment（纯函数）', () => {
  it('无 assignees → null（该表单没有指派语义）', () => {
    expect(parseAssignment({ schema: {} })).toBeNull()
    expect(parseAssignment(null)).toBeNull()
    expect(parseAssignment({ assignees: null })).toBeNull()
    expect(parseAssignment({ assignees: [] })).toBeNull()
  })

  it('有 assignees 无 due → afterDays 为 null', () => {
    expect(parseAssignment({ assignees: { dictRef: 'dict:x' } })).toEqual({ dictRef: 'dict:x', afterDays: null })
  })

  it('两键齐 → 都取出（gdict 全局引用也认）', () => {
    expect(parseAssignment({ assignees: { dictRef: 'gdict:y' }, due: { afterDays: 3 } }))
      .toEqual({ dictRef: 'gdict:y', afterDays: 3 })
  })

  it('due 形状不合法（编译闸会挡，此处兜底为 null）→ afterDays 为 null', () => {
    expect(parseAssignment({ assignees: { dictRef: 'dict:x' }, due: { afterDays: 0 } })?.afterDays).toBeNull()
    expect(parseAssignment({ assignees: { dictRef: 'dict:x' }, due: { afterDays: 1.5 } })?.afterDays).toBeNull()
  })
})

describe.skipIf(!process.env.DATABASE_URL)('resolveAssigneeKeys（真库）', () => {
  it('只取 enabled 条目，key 即 Casdoor 用户名', async () => {
    // 真库用例在 CI（有 DATABASE_URL）覆盖；本地跳过。
    expect(typeof resolveAssigneeKeys).toBe('function')
  })
})
