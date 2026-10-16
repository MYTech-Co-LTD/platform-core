import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import * as store from './storage'

// 字典四纪律 + P4 双档（issue #710；正典 architecture §2.4）：
// ① key 不可变（**裸 SQL 绕过测试**——越过 API 改 key 也必须被 DB 触发器拦）；
// ② 软删（enabled=false + retired_at，行不消失）；③ 退役值可渲染历史（resolve）、新提交拒（闸 5）；
// ④ 恢复允许。P4：租户私有按 org 隔离；全局无 org、与租户表同名不同表互不可见。
// 清场纪律：唯一 org / 唯一 dict_id（字典表无不可变触发器冲突，可直接清），不碰兄弟夹具。

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const SUF = Math.random().toString(36).slice(2, 8)
const ORG_A = `org-forms-dict-a-${SUF}`
const ORG_B = `org-forms-dict-b-${SUF}`
const DICT = `dict-${SUF}`
const GDICT = `gdict-${SUF}`

describePg('forms 字典（P4 双档 + 四纪律）', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
  })

  afterAll(async () => {
    await pool.query('delete from forms.dict_item where dict_id=$1 or org in ($1, $2, $3)', [DICT, ORG_A, ORG_B]).catch(() => {})
    await pool.query('delete from forms.dict_item where dict_id=$1', [DICT]).catch(() => {})
    await pool.query('delete from forms.dict_global_item where dict_id=$1', [GDICT]).catch(() => {})
    await pool.query('delete from forms.submission where org in ($1,$2)', [ORG_A, ORG_B]).catch(() => {})
    await pool.query('delete from forms.asset_head where org in ($1,$2)', [ORG_A, ORG_B]).catch(() => {})
    await pool.query('delete from forms.asset_version where org in ($1,$2)', [ORG_A, ORG_B]).catch(() => {})
    await pool.end()
  })

  it('① 裸 SQL 改 tenant 字典 key → 触发器拦（绕过 API 的 DB 层测试）', async () => {
    await store.addDictKey(pool, 'tenant', ORG_A, DICT, 'k1', '甲', 'u1')
    await expect(
      pool.query(
        `update forms.dict_item set key='k1-changed' where org=$1 and dict_id=$2 and key='k1'`,
        [ORG_A, DICT],
      ),
    ).rejects.toThrow(/dict key is immutable/)
  })

  it('① 裸 SQL 改 global 字典 key → 同拦', async () => {
    await store.addDictKey(pool, 'global', null, GDICT, 'g1', '全局甲', 'platform-admin')
    await expect(
      pool.query(
        `update forms.dict_global_item set key='g1-changed' where dict_id=$1 and key='g1'`,
        [GDICT],
      ),
    ).rejects.toThrow(/dict key is immutable/)
  })

  it('addKey upsert：同 key 重写=改 label/sort，不撞唯一键', async () => {
    await store.addDictKey(pool, 'tenant', ORG_A, DICT, 'k1', '甲改', 'u1', 5)
    const opts = await store.dictOptions(pool, 'tenant', ORG_A, DICT)
    expect(opts).toEqual([{ key: 'k1', label: '甲改', sortNo: 5 }])
  })

  it('② 软删：options 排除、resolve 仍带 label + enabled=false、retired_at 落值', async () => {
    await store.addDictKey(pool, 'tenant', ORG_A, DICT, 'k2', '乙', 'u1')
    await store.updateDictKey(pool, 'tenant', ORG_A, DICT, 'k2', { enabled: false })
    const opts = await store.dictOptions(pool, 'tenant', ORG_A, DICT)
    expect(opts.map((o) => o.key)).toEqual(['k1']) // k2 退出生效集
    const resolved = await store.dictResolve(pool, 'tenant', ORG_A, DICT, ['k2'])
    expect(resolved.get('k2')).toMatchObject({ label: '乙', enabled: false }) // 历史可渲染
    const { rows } = await pool.query(
      'select retired_at from forms.dict_item where org=$1 and dict_id=$2 and key=$3',
      [ORG_A, DICT, 'k2'],
    )
    expect(rows[0].retired_at).not.toBeNull()
  })

  it('④ 恢复：enabled=true 回生效集、retired_at 清空', async () => {
    await store.updateDictKey(pool, 'tenant', ORG_A, DICT, 'k2', { enabled: true })
    const opts = await store.dictOptions(pool, 'tenant', ORG_A, DICT)
    // 排序口径 (sort_no, key)：k2 恢复后 sort_no=0 在 k1（已改 sort_no=1）之前
    expect(opts.map((o) => o.key)).toEqual(['k2', 'k1'])
    const resolved = await store.dictResolve(pool, 'tenant', ORG_A, DICT, ['k2'])
    expect(resolved.get('k2')?.enabled).toBe(true)
  })

  it('updateKey 改 label/sort；不存在的 key → DICT_KEY_NOT_FOUND（机检错误码）', async () => {
    await store.updateDictKey(pool, 'tenant', ORG_A, DICT, 'k1', { label: '甲终', sortNo: 1 })
    const opts = await store.dictOptions(pool, 'tenant', ORG_A, DICT)
    expect(opts.find((o) => o.key === 'k1')).toMatchObject({ label: '甲终', sortNo: 1 })
    await expect(
      store.updateDictKey(pool, 'tenant', ORG_A, DICT, 'nope', { label: 'x' }),
    ).rejects.toMatchObject({ code: 'DICT_KEY_NOT_FOUND' })
  })

  it('P4：租户字典按 org 隔离——B org 查不到 A 的任何 key', async () => {
    expect(await store.dictOptions(pool, 'tenant', ORG_B, DICT)).toEqual([])
    expect(await store.dictResolve(pool, 'tenant', ORG_B, DICT, ['k1']).then((m) => m.size)).toBe(0)
  })

  it('P4：全局与租户同名不同表——同 dict_id 互不可见', async () => {
    await store.addDictKey(pool, 'global', null, DICT, 'only-global', '全局独有', 'platform-admin')
    await store.addDictKey(pool, 'tenant', ORG_A, DICT, 'only-tenant', '租户独有', 'u1')
    const g = await store.dictOptions(pool, 'global', null, DICT)
    const t = await store.dictOptions(pool, 'tenant', ORG_A, DICT)
    expect(g.map((o) => o.key)).toEqual(['only-global'])
    expect(t.map((o) => o.key)).toEqual(['k2', 'only-tenant', 'k1']) // (sort_no, key) 排序
  })

  it('③ 提交集成：required 绑定生效值过 / 退役值拒 / open 放行（submit 预载通路）', async () => {
    await store.addDictKey(pool, 'tenant', ORG_A, DICT, 'p1', 'P1', 'u1', 1)
    await store.addDictKey(pool, 'tenant', ORG_A, DICT, 'p2', 'P2', 'u1', 2)
    const schema = {
      type: 'object',
      properties: {
        level: { type: 'string', title: '级别', 'x-dict': `dict:${DICT}`, 'x-binding': 'required' },
        note: { type: 'string', 'x-dict': `dict:${DICT}`, 'x-binding': 'open' },
      },
      required: ['level'],
    }
    await store.newDraft(pool, ORG_A, `flow-${SUF}`, { schema }, 'u1')
    await store.publish(pool, ORG_A, `flow-${SUF}`, 1, 'human-1')

    const ok = await store.submit(pool, ORG_A, `flow-${SUF}`, { level: 'p1', note: '自由文本' }, 's1')
    expect(ok.version).toBe(1)

    await store.updateDictKey(pool, 'tenant', ORG_A, DICT, 'p2', { enabled: false }) // 退役 p2
    await expect(
      store.submit(pool, ORG_A, `flow-${SUF}`, { level: 'p2' }, 's1'),
    ).rejects.toMatchObject({ code: 'DICT_REQUIRED_VIOLATION' }) // ③ 新提交拒退役值
  })

  it('gdict 引用在提交通路走全局表（P4 前缀分档贯通）', async () => {
    await store.addDictKey(pool, 'global', null, GDICT, 'cn-11', '北京', 'platform-admin')
    const schema = {
      type: 'object',
      properties: { region: { type: 'string', 'x-dict': `gdict:${GDICT}`, 'x-binding': 'required' } },
      required: ['region'],
    }
    await store.newDraft(pool, ORG_B, `gflow-${SUF}`, { schema }, 'u1')
    await store.publish(pool, ORG_B, `gflow-${SUF}`, 1, 'human-1')
    await expect(
      store.submit(pool, ORG_B, `gflow-${SUF}`, { region: 'nope' }, 's1'),
    ).rejects.toMatchObject({ code: 'DICT_REQUIRED_VIOLATION' })
    const ok = await store.submit(pool, ORG_B, `gflow-${SUF}`, { region: 'cn-11' }, 's1')
    expect(ok.version).toBe(1)
  })
})
