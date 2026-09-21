import { afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { PAT_PREFIX, createPatKey, hashPat, listPatKeys, newPatToken, resolvePat, revokePatKey, touchPatKey } from './key-store'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 模块各表的**隔离键**（text，值 = 该租户的 Casdoor org）——已不是数字 tenant id。 */
const ORG = 'org-t3-test'

describe('token 形状（不需要数据库）', () => {
  it('前缀是 dkq_，32 字节随机 → base64url', () => {
    const t = newPatToken()
    expect(t.startsWith(PAT_PREFIX)).toBe(true)
    expect(t.length).toBeGreaterThan(40)
    expect(newPatToken()).not.toBe(t)          // 每次都不同
  })

  it('hashPat 与宿主中间件那条行**逐字一致**（跨进程契约，见 Global Constraints 5）', () => {
    const token = 'dkq_fixture-token'
    // ↓↓ 这一行必须与 apps/server/src/pat-auth.ts 里的实现完全相同
    const expected = createHash('sha256').update(token).digest('hex')
    expect(hashPat(token)).toBe(expected)
    expect(hashPat(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describePg('key-store（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_keys where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('建 key → 库里只有哈希，明文只在返回值里', async () => {
    await applyMigrations(pool)
    const { id, token } = await createPatKey(pool, ORG, 'alice', '我的 key')
    expect(token.startsWith(PAT_PREFIX)).toBe(true)

    const raw = await pool.query('select token_hash from data.query_keys where id = $1', [id])
    expect(raw.rows[0].token_hash).toBe(hashPat(token))
    expect(raw.rows[0].token_hash).not.toContain(token)   // 明文不落库
  })

  it('resolvePat 命中 / 未知 token 返 null / 吊销后立刻失效', async () => {
    const { id, token } = await createPatKey(pool, ORG, 'bob', 'k')
    const hit = await resolvePat(pool, token)
    expect(hit).toEqual({ keyId: id, org: ORG, casdoorUser: 'bob' })

    expect(await resolvePat(pool, 'dkq_never-existed')).toBeNull()

    expect(await revokePatKey(pool, ORG, 'bob', id)).toBe(true)
    expect(await resolvePat(pool, token)).toBeNull()       // 吊销即时生效
  })

  it('listPatKeys 只列自己的，且 revoked 标记正确', async () => {
    const { id } = await createPatKey(pool, ORG, 'carol', 'c1')
    const other = await createPatKey(pool, ORG, 'dave', 'd1')
    const mine = await listPatKeys(pool, ORG, 'carol')
    expect(mine.map((k) => k.id)).toContain(id)
    expect(mine.map((k) => k.id)).not.toContain(other.id)
    await revokePatKey(pool, ORG, 'carol', id)
    expect((await listPatKeys(pool, ORG, 'carol')).find((k) => k.id === id)?.revoked).toBe(true)
  })

  it('revokePatKey 对别人的 key 返 false（不能吊销别人的）', async () => {
    const { id } = await createPatKey(pool, ORG, 'erin', 'e1')
    expect(await revokePatKey(pool, ORG, 'frank', id)).toBe(false)
  })

  it('touchPatKey 写 last_used_at', async () => {
    const { id } = await createPatKey(pool, ORG, 'gina', 'g1')
    await touchPatKey(pool, id)
    const r = await pool.query('select last_used_at from data.query_keys where id = $1', [id])
    expect(r.rows[0].last_used_at).not.toBeNull()
  })
})
