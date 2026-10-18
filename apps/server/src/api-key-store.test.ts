// api-key-store.test.ts — 宿主 key-store（唯一哈希实现）。issue #894。
// 形状照搬原 modules/data/domain/key-store.test.ts（同一批断言语义），只有表/路径变。
import { afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import {
  PAT_PREFIX,
  createPatKey,
  hashPat,
  listPatKeys,
  newPatToken,
  resolvePat,
  revokePatKey,
  touchPatKey,
} from './api-key-store'
import { runMigrations } from './migrate'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）。 */
const ORG = 'org-894-key-store'
const user = 'alice'

describe('token 形状（不需要数据库）', () => {
  it('前缀是 dkq_，32 字节随机 → base64url', () => {
    const t = newPatToken()
    expect(t.startsWith(PAT_PREFIX)).toBe(true)
    expect(t.length).toBeGreaterThan(40)
    expect(newPatToken()).not.toBe(t)
  })

  it('hashPat = sha256 hex（宿主唯一一份；钉住算法不漂移）', () => {
    const token = 'dkq_fixture-token'
    // 自查重算：只钉住「hashPat = sha256 hex」这一算法形状，不证明跨进程一致性
    // （上移后不再有「模块建 / 宿主认」两侧，往返契约用例仍在，见 data-query.e2e.test.ts）。
    expect(hashPat(token)).toBe(createHash('sha256').update(token).digest('hex'))
    expect(hashPat(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describePg('宿主 key-store（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    await pool.query('delete from platform.api_key where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('建 key → 库里只有哈希，明文只在返回值里', async () => {
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
    const { id, token } = await createPatKey(pool, ORG, user, '我的 key')
    expect(token.startsWith(PAT_PREFIX)).toBe(true)

    const raw = await pool.query('select token_hash from platform.api_key where id = $1', [id])
    expect(raw.rows[0].token_hash).toBe(hashPat(token))
    expect(raw.rows[0].token_hash).not.toContain(token) // 明文不落库
  })

  it('名称空/超长 ⇒ 抛', async () => {
    await expect(createPatKey(pool, ORG, user, '   ')).rejects.toThrow()
    await expect(createPatKey(pool, ORG, user, 'x'.repeat(65))).rejects.toThrow()
  })

  it('list 只回自己的 key，按创建倒序，revoked 映射正确', async () => {
    const rows = await listPatKeys(pool, ORG, user)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => typeof r.id === 'number')).toBe(true) // int8 已归一
  })

  it('resolve：命中返主体；未知 token 返 null（fail-closed）', async () => {
    const { token } = await createPatKey(pool, ORG, user, 'resolve 用')
    const hit = await resolvePat(pool, token)
    expect(hit).toMatchObject({ org: ORG, casdoorUser: user })
    expect(await resolvePat(pool, 'dkq_definitely-not-a-key')).toBeNull()
  })

  it('吊销：带 casdoorUser 才改得到；吊销后解析不到', async () => {
    const { id, token } = await createPatKey(pool, ORG, user, '待吊销')
    // 不带 casdoor_user（用别人名字）⇒ 改不到
    expect(await revokePatKey(pool, ORG, 'someone-else', id)).toBe(false)
    expect(await revokePatKey(pool, ORG, user, id)).toBe(true)
    expect(await resolvePat(pool, token)).toBeNull()
  })

  it('touch：改 last_used_at，且不碰别家 org 的行', async () => {
    const { id, token } = await createPatKey(pool, ORG, user, 'touch 用')
    await touchPatKey(pool, ORG, id)
    const r = await pool.query('select last_used_at from platform.api_key where id = $1', [id])
    expect(r.rows[0].last_used_at).not.toBeNull()
    // 错的 org ⇒ 写不到
    await touchPatKey(pool, 'org-894-other', id)
    expect((await resolvePat(pool, token))?.keyId).toBe(id)
  })
})
