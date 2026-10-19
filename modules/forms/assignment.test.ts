// assignment.test.ts — §2.4「指派与催办」模块侧 SQL 的真库测试（无 DATABASE_URL 则 skip）。
// 脚本（scripts/notify-reconcile.mjs）的**编排**另有纯核测试（scripts/notify-reconcile.test.ts）——
// 真栈跑脚本的一半按仓内约定不在 scripts/ 测（根 vitest 解析不到 pg；先例 reconcile-tenant-sources）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import { addDictKey, listAssignmentTargets, newDraft, publish } from './storage'
import { parseAssignment, resolveAssigneeKeys } from './domain/assignees'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

describePg('指派与催办（模块侧 SQL）', () => {
  let pool: Pool
  const SUF = Math.random().toString(36).slice(2, 8)
  const ORG = `org-assign-${SUF}`
  const WITH = `f-with-${SUF}`
  const WITHOUT = `f-without-${SUF}`

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    await addDictKey(pool, 'tenant', ORG, 'staff', 'u1', '甲', 'tester', 0)
    await addDictKey(pool, 'tenant', ORG, 'staff', 'u2', '乙', 'tester', 1)
    const v1 = await newDraft(
      pool, ORG, WITH,
      { schema: { type: 'object', properties: { name: { type: 'string' } } }, assignees: { dictRef: 'dict:staff' }, due: { afterDays: 7 } },
      'tester',
    )
    await publish(pool, ORG, WITH, v1, 'tester')
    const v2 = await newDraft(
      pool, ORG, WITHOUT,
      { schema: { type: 'object', properties: { name: { type: 'string' } } } },
      'tester',
    )
    await publish(pool, ORG, WITHOUT, v2, 'tester')
  })

  afterAll(async () => {
    // published/retired 行物理不可删（触发器 = 被测契约）⇒ 尽力而为，留唯一 org（惰性数据）
    for (const t of ['submission', 'asset_head', 'asset_version']) {
      await pool.query(`delete from forms.${t} where org=$1`, [ORG]).catch(() => {})
    }
    await pool.end()
  })

  it('listAssignmentTargets：只返回**含 assignees 声明**的活跃已发布版本（无声明的不返回）', async () => {
    const targets = (await listAssignmentTargets(pool)).filter((t) => t.org === ORG)
    expect(targets.map((t) => t.assetId)).toEqual([WITH])
    expect(parseAssignment(targets[0].body)).toEqual({ dictRef: 'dict:staff', afterDays: 7 })
  })

  it('resolveAssigneeKeys：只取 enabled 条目，key 即 Casdoor 用户名；软删后不再出现', async () => {
    expect(await resolveAssigneeKeys(pool, ORG, 'dict:staff')).toEqual(['u1', 'u2'])
    await pool.query(`update forms.dict_item set enabled=false where org=$1 and dict_id='staff' and key='u2'`, [ORG])
    expect(await resolveAssigneeKeys(pool, ORG, 'dict:staff')).toEqual(['u1'])
  })
})
