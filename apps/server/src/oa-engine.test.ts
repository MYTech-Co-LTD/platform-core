// oa-engine.test.ts — 租户→引擎映射（issue #2363，OA P0 Task 5）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { createOaEnginePort, createOaEngineStore } from './oa-engine'
import { runMigrations } from './migrate'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

// org 每 run 唯一：共享库上固定 org 会被并行跑的兄弟套件互删（同 kernel.test.ts 的纪律）。
const orgOf = (suffix: string) => `oa-engine-test-${Math.random().toString(36).slice(2, 8)}-${suffix}`

describePg('oa-engine store', () => {
  let pool: Pool
  const orgs: string[] = []

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })
  afterAll(async () => {
    for (const org of orgs) {
      await pool.query('delete from platform.oa_engine where org = $1', [org]).catch(() => {})
    }
    await pool.end()
  })

  it('无映射 = null（OA 对该租户关闭）', async () => {
    const store = createOaEngineStore(pool)
    const org = orgOf('none')
    orgs.push(org)
    expect(await store.get(org)).toBeNull()
  })

  it('upsert 后可读且 enabled 生效', async () => {
    const store = createOaEngineStore(pool)
    const org = orgOf('upsert')
    orgs.push(org)
    await store.upsert({
      org, baseUrl: 'http://engine:3100', patSecretRef: 'OA_ENGINE_PAT', engineVersion: '0.3.0', enabled: true,
    })
    expect(await store.get(org)).toMatchObject({
      org, baseUrl: 'http://engine:3100', patSecretRef: 'OA_ENGINE_PAT', engineVersion: '0.3.0', enabled: true,
    })
  })

  it('upsert 幂等：二次写入覆盖旧值，不新增行', async () => {
    const store = createOaEngineStore(pool)
    const org = orgOf('idem')
    orgs.push(org)
    await store.upsert({ org, baseUrl: 'http://old:3100', patSecretRef: 'OLD_REF', engineVersion: null, enabled: true })
    await store.upsert({ org, baseUrl: 'http://new:3100', patSecretRef: 'NEW_REF', engineVersion: '0.4.0', enabled: true })
    expect(await store.get(org)).toMatchObject({ baseUrl: 'http://new:3100', patSecretRef: 'NEW_REF' })
    const { rows } = await pool.query('select count(*)::int n from platform.oa_engine where org = $1', [org])
    expect(rows[0].n).toBe(1)
  })

  it('enabled=false 与无行同义：get 仍返回 null（fail-closed）', async () => {
    const store = createOaEngineStore(pool)
    const org = orgOf('off')
    orgs.push(org)
    await store.upsert({ org, baseUrl: 'http://engine:3100', patSecretRef: 'OA_ENGINE_PAT', engineVersion: null, enabled: false })
    expect(await store.get(org)).toBeNull()
    // 行仍在（开关不删登记）——否则/dev 无法再打开
    const { rows } = await pool.query('select enabled from platform.oa_engine where org = $1', [org])
    expect(rows[0]).toEqual({ enabled: false })
  })
})

// ── OaEnginePort（OA P1 / #2363）：模块消费面的四条判据（全部 fail-closed） ──
describePg('createOaEnginePort', () => {
  let pool: Pool
  const orgs: string[] = []
  const orgOf = (suffix: string) => `oa-port-test-${Math.random().toString(36).slice(2, 8)}-${suffix}`

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })
  afterAll(async () => {
    for (const org of orgs) {
      await pool.query('delete from platform.oa_engine where org = $1', [org]).catch(() => {})
    }
    await pool.end()
  })

  it('无行 ⇒ null（OA 对该租户关闭）', async () => {
    const port = createOaEnginePort({ pool, env: { OA_ENGINE_PAT: 's3cret' } })
    const org = orgOf('none')
    orgs.push(org)
    expect(await port.get(org)).toBeNull()
  })

  it('enabled=false ⇒ null（停用即不可用）', async () => {
    const org = orgOf('off')
    orgs.push(org)
    await createOaEngineStore(pool).upsert({
      org, baseUrl: 'http://engine:3100', patSecretRef: 'OA_ENGINE_PAT', engineVersion: null, enabled: false,
    })
    expect(await createOaEnginePort({ pool, env: { OA_ENGINE_PAT: 's3cret' } }).get(org)).toBeNull()
  })

  it('secret 取不到 ⇒ null（fail-closed，不猜、不回落别的键）', async () => {
    const org = orgOf('nosecret')
    orgs.push(org)
    await createOaEngineStore(pool).upsert({
      org, baseUrl: 'http://engine:3100', patSecretRef: 'MISSING_PAT', engineVersion: null, enabled: true,
    })
    expect(await createOaEnginePort({ pool, env: {} }).get(org)).toBeNull()
    // 别的键有值不算（引用名必须精确相等）
    expect(await createOaEnginePort({ pool, env: { OA_ENGINE_PAT: 's3cret' } }).get(org)).toBeNull()
  })

  it('base_url 为空 ⇒ null', async () => {
    const org = orgOf('nobase')
    orgs.push(org)
    await createOaEngineStore(pool).upsert({
      org, baseUrl: '', patSecretRef: 'OA_ENGINE_PAT', engineVersion: null, enabled: true,
    })
    expect(await createOaEnginePort({ pool, env: { OA_ENGINE_PAT: 's3cret' } }).get(org)).toBeNull()
  })

  it('有行 + secret ⇒ 正确 baseUrl / 已解析 pat / engineVersion（只出可用配置）', async () => {
    const org = orgOf('ok')
    orgs.push(org)
    await createOaEngineStore(pool).upsert({
      org, baseUrl: 'http://engine:3100', patSecretRef: 'OA_ENGINE_PAT', engineVersion: '0.3.0', enabled: true,
    })
    expect(await createOaEnginePort({ pool, env: { OA_ENGINE_PAT: 's3cret' } }).get(org)).toEqual({
      baseUrl: 'http://engine:3100', pat: 's3cret', engineVersion: '0.3.0',
    })
  })

  it('未知 org ⇒ null（不抛错——与 OrganizationPort 同口径）', async () => {
    expect(await createOaEnginePort({ pool, env: { OA_ENGINE_PAT: 's3cret' } }).get('never-existed-org'))
      .toBeNull()
  })
})
