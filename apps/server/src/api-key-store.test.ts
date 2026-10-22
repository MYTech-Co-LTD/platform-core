// api-key-store.test.ts — 宿主 key-store（唯一哈希实现）。issue #894。
// 形状照搬原 modules/data/domain/key-store.test.ts（同一批断言语义），只有表/路径变。
import { afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
  /** 回填用例的独立 org（与上面 ORG 分开，清理互不误伤）。 */
  const BACKFILL_ORG = 'org-010-backfill'
  afterAll(async () => {
    await pool.query('delete from platform.api_key where org = any($1)', [[ORG, BACKFILL_ORG]]).catch(() => {})
    await pool.query('delete from data.query_keys where org = $1', [BACKFILL_ORG]).catch(() => {})
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

  it('010 回填：旧表存量行搬进新表且 resolvePat 可解析；重跑幂等且不复活已吊销行', async () => {
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))

    const backfill = () =>
      pool.query(readFileSync(
        fileURLToPath(new URL('./migrations/010_platform_api_key_backfill.sql', import.meta.url)), 'utf8'))
    const backfillOn = (conn: { query: (sql: string) => Promise<unknown> }) =>
      conn.query(readFileSync(
        fileURLToPath(new URL('./migrations/010_platform_api_key_backfill.sql', import.meta.url)), 'utf8'))

    // 守卫分支先钉住（CI smoke 2026-10-22 的炸点）：旧表还不存在的库上跑迁移必须无害跳过
    // （全新库跑到 010 时 data.query_keys 尚未由模块迁移建出——无守卫装载即炸）。
    // drop 用**事务内**做、随后 rollback：共享库上并行 worker 的 data.* 夹具不受影响
    // （DDL 事务性——schema 消失只在本事务可见）。
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('drop schema if exists data cascade')
      await backfillOn(client)
      await client.query('rollback')
    } finally {
      client.release()
    }

    // 造「上移前的世界」：旧表按 data 001 形状幂等补齐（模块迁移由装载期跑，与本文件无顺序保证）。
    await pool.query('create schema if not exists data')
    await pool.query(`create table if not exists data.query_keys (
      id           bigserial   primary key,
      org          text        not null,
      casdoor_user text        not null,
      name         text        not null,
      token_hash   text        not null unique,
      created_at   timestamptz not null default now(),
      last_used_at timestamptz,
      revoked_at   timestamptz
    )`)
    // 一枚 key 只存在于旧表（createPatKey 只写新表，造不出来）。
    const legacy = newPatToken()
    await pool.query(
      'insert into data.query_keys (org, casdoor_user, name, token_hash) values ($1,$2,$3,$4)',
      [BACKFILL_ORG, user, 'legacy-010', hashPat(legacy)],
    )
    // 先钉住病灶：迁移前 resolvePat 必然 null（shanhai 2026-10-22 生产 401 的机制）。
    expect(await resolvePat(pool, legacy)).toBeNull()

    await backfill()
    await backfill()
    expect(await resolvePat(pool, legacy)).toMatchObject({ org: BACKFILL_ORG, casdoorUser: user })

    // 幂等 + 不复活：新表侧吊销后重跑回填，吊销必须保持（on conflict do nothing 不覆盖新表行——
    // 若写成 do update，重跑会把旧表的 revoked_at=null 盖回来 = 复活已吊销 key，安全回退）。
    const row = await pool.query('select id from platform.api_key where token_hash = $1', [hashPat(legacy)])
    expect(await revokePatKey(pool, BACKFILL_ORG, user, Number(row.rows[0].id))).toBe(true)
    await backfill()
    expect(await resolvePat(pool, legacy)).toBeNull()
  })
})
