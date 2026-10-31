// channel-probe.test.ts — 直连渠道活性证据（spec 2026-10-31 §3.4）
//
// 断言四个方向：
//   ① 探到 token ⇒ 写 last_ok_at、清 last_error；
//   ② 探失败 ⇒ 写 last_error（判据据此 PROBE_FAILED），且**不倒退** last_ok_at；
//   ③ 没配凭据（missing）⇒ 不写失败（「还没接」≠「坏了」）；
//   ④ 限频：checked_at 新于 300s 的通道不再探（worker 每 2s 一圈，不能每圈都打企微）。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { probeDirectChannels, MIN_PROBE_INTERVAL_SECONDS, SAMPLE_LIMIT } from './channel-probe'
import { upsertCredential } from './credential-store'
import { __resetTokenCache } from './im/wecom-direct'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-chan-probe'
const KEK = 'e'.repeat(64)
const env = { NOTIFY_CRED_KEK: KEK }

/** 假企微网关：errcode 可切。 */
function fakeFetch(state: { fail: boolean; calls: number; badUsers?: string[] }): typeof fetch {
  return (async (input: string | URL | Request) => {
    state.calls += 1
    const u = String(input)
    if (u.includes('/cgi-bin/gettoken')) {
      if (state.fail) {
        return new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errcode: 0, access_token: 'tok-1', expires_in: 7200 }), { status: 200 })
    }
    if (u.includes('/cgi-bin/user/get')) {
      const uid = new URL(u).searchParams.get('userid') ?? ''
      if ((state.badUsers ?? []).includes(uid)) {
        return new Response(JSON.stringify({ errcode: 60111, errmsg: 'user not found' }), { status: 200 })
      }
      return new Response(JSON.stringify({ errcode: 0, userid: uid }), { status: 200 })
    }
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
  }) as unknown as typeof fetch
}

describePg('channel-probe', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from notify.channel_probe where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from notify.channel where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from notify.channel_credential where org=$1', [ORG]).catch(() => {})
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('delete from notify.channel_probe where org=$1', [ORG])
    await pool.query('delete from notify.channel where org=$1', [ORG])
    await pool.query('delete from notify.channel_credential where org=$1', [ORG])
    // token 缓存是进程级的（同 key 并发只取一次）；跨用例不清会串——尤其「换 secret 后失败」的用例
    __resetTokenCache()
  })

  const addChannel = async (config: Record<string, unknown>, enabled = true) => {
    await pool.query(
      `insert into notify.channel(org, id, provider, enabled, config, secret_refs, created_by)
       values ($1,'wecom-main','wecom_chat',$2,$3::jsonb,'{}'::jsonb,'test')`,
      [ORG, enabled, JSON.stringify(config)],
    )
  }
  const probeRow = async () => {
    const r = await pool.query(
      'select last_ok_at, last_error, checked_at from notify.channel_probe where org=$1 and provider=$2',
      [ORG, 'wecom_chat'],
    )
    return r.rows[0] as { last_ok_at: Date | null; last_error: string | null; checked_at: Date } | undefined
  }

  it('★ 取到 token ⇒ last_ok_at 前进、last_error 清空', async () => {
    await addChannel({ transport: 'direct' })
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww1', agentId: '1', secret: 's' }, 't', env)
    const s = await probeDirectChannels({ pool, env, fetchImpl: fakeFetch({ fail: false, calls: 0 }) })
    expect(s.probed).toBe(1)
    expect(s.ok).toEqual([`${ORG}/wecom_chat`])
    const row = await probeRow()
    expect(row?.last_ok_at).not.toBeNull()
    expect(row?.last_error).toBeNull()
  })

  it('★ 取不到 token ⇒ last_error 有原因，且 last_ok_at 不倒退（线索是「沉默多久」）', async () => {
    await addChannel({ transport: 'direct' })
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww1', agentId: '1', secret: 's' }, 't', env)
    await probeDirectChannels({ pool, env, fetchImpl: fakeFetch({ fail: false, calls: 0 }) })
    const before = await probeRow()
    // 强制到点（否则限频会跳过）
    await pool.query("update notify.channel_probe set checked_at = now() - interval '10 minutes' where org=$1", [ORG])
    // 凭据换了：token 缓存必须清，否则探针会拿旧 token 判「还活着」（假绿）
    __resetTokenCache()

    const s = await probeDirectChannels({ pool, env, fetchImpl: fakeFetch({ fail: true, calls: 0 }) })
    expect(s.failed).toHaveLength(1)
    const after = await probeRow()
    expect(after?.last_error).toMatch(/40013|invalid corpid/)
    expect(after?.last_ok_at?.getTime()).toBe(before?.last_ok_at?.getTime())
  })

  it('★ 没配凭据 ⇒ 跳过且不写失败（「还没接」≠「坏了」）', async () => {
    await addChannel({ transport: 'direct' })
    const s = await probeDirectChannels({ pool, env, fetchImpl: fakeFetch({ fail: false, calls: 0 }) })
    expect(s.skipped).toBe(1)
    expect(await probeRow()).toBeUndefined()
  })

  it('★ 非直连通道不探（桥路线不产生本表证据）', async () => {
    await addChannel({ transport: 'bridge' })
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww1', agentId: '1', secret: 's' }, 't', env)
    const state = { fail: false, calls: 0 }
    const s = await probeDirectChannels({ pool, env, fetchImpl: fakeFetch(state) })
    expect(s.probed).toBe(0)
    expect(state.calls).toBe(0)
    expect(await probeRow()).toBeUndefined()
  })

  it('★ 限频：刚探过就不再打企微（worker 每 2s 一圈）', async () => {
    await addChannel({ transport: 'direct' })
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww1', agentId: '1', secret: 's' }, 't', env)
    const state = { fail: false, calls: 0 }
    await probeDirectChannels({ pool, env, fetchImpl: fakeFetch(state) })
    const first = state.calls
    expect(first).toBeGreaterThan(0)
    const s2 = await probeDirectChannels({ pool, env, fetchImpl: fakeFetch(state) })
    expect(s2.probed).toBe(0)
    expect(state.calls).toBe(first)
    // 间隔常量是 300s（与 spec「每 5 分钟一次 gettoken」一致）
    expect(MIN_PROBE_INTERVAL_SECONDS).toBe(300)
  })

  it('★ 个人级抽样：成功/失败分别落 reachable / unreachable，**不改** last_ok_at 语义', async () => {
    await addChannel({ transport: 'direct' })
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww-sample', agentId: '9', secret: 's' }, 't', env)
    let asked = 0
    const opts = {
      pool, env,
      fetchImpl: fakeFetch({ fail: false, calls: 0, badUsers: ['ghost'] }),
      sampleAddresses: async (_org: string, limit: number) => {
        asked = limit
        return ['ok1', 'ghost', 'ok2']
      },
    }
    const s = await probeDirectChannels(opts)
    expect(s.ok).toEqual([`${ORG}/wecom_chat`])
    expect(asked).toBe(SAMPLE_LIMIT)
    const row = await pool.query(
      'select reachable, unreachable, last_ok_at, last_error from notify.channel_probe where org=$1', [ORG],
    )
    expect(row.rows[0]).toMatchObject({ reachable: 2, unreachable: 1, last_error: null })
    expect(row.rows[0].last_ok_at).not.toBeNull()
  })

  it('采样器缺省 / 抽不到人 ⇒ 统计列为 null（「不知道」≠「0 可达」）', async () => {
    await addChannel({ transport: 'direct' })
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww-sample2', agentId: '9', secret: 's' }, 't', env)
    await probeDirectChannels({ pool, env, fetchImpl: fakeFetch({ fail: false, calls: 0 }) })
    const r1 = await pool.query('select reachable, unreachable from notify.channel_probe where org=$1', [ORG])
    expect(r1.rows[0]).toEqual({ reachable: null, unreachable: null })

    await pool.query("update notify.channel_probe set checked_at = now() - interval '10 minutes' where org=$1", [ORG])
    __resetTokenCache()
    await probeDirectChannels({
      pool, env, fetchImpl: fakeFetch({ fail: false, calls: 0 }), sampleAddresses: async () => [],
    })
    const r2 = await pool.query('select reachable, unreachable from notify.channel_probe where org=$1', [ORG])
    expect(r2.rows[0]).toEqual({ reachable: null, unreachable: null })
  })

  it('★ 停用的通道不探', async () => {
    await addChannel({ transport: 'direct' }, false)
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww1', agentId: '1', secret: 's' }, 't', env)
    const s = await probeDirectChannels({ pool, env, fetchImpl: fakeFetch({ fail: false, calls: 0 }) })
    expect(s.probed).toBe(0)
  })
})
