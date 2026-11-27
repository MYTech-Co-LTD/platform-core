import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { JOB_REGISTRY, seedSchedules, type JobDef } from './registry'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

const defs: JobDef[] = [
  { scope: 'platform', key: 'jobtest-registry:alpha', script: 'scripts/x.mjs', cron: '7 * * * *', timezone: 'UTC', timeoutMs: 1000, maxAttempts: 1, expectedIntervalSecs: 3600, description: 't' },
]

/** handler-only 条目：只登记 handler，不建系统排班行（cron/timezone 是 schema 必填的占位，不进库）。 */
const handlerOnlyDef: JobDef = {
  scope: 'platform', key: 'jobtest-registry:handler-only', script: 'scripts/x.mjs', cron: '0 0 1 1 *', timezone: 'UTC',
  timeoutMs: 1000, maxAttempts: 1, expectedIntervalSecs: 86400, description: 't', noSystemSchedule: true,
}

/** 用例的前置行由用例自己造（beforeEach 先清空本前缀）——单独跑任意一条都不依赖别的用例。 */
async function insertAlpha(pool: Pool, cron: string, enabled: boolean, nextRunAt: Date | null = null): Promise<void> {
  await pool.query(
    `insert into platform.job_schedule
       (key, cron, timezone, params, source, enabled, next_run_at, timeout_ms, max_attempts, expected_interval_secs)
     values ('jobtest-registry:alpha', $1, 'UTC', '{}'::jsonb, 'system', $2, $3, 1000, 1, 3600)`,
    [cron, enabled, nextRunAt],
  )
}

describePg('seedSchedules', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  beforeEach(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest-registry:%'") })
  afterAll(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest-registry:%'"); await pool.end() })

  it('首次插入：enabled=false 且 next_run_at 为空（登记不跑）', async () => {
    const r = await seedSchedules(pool, defs)
    expect(r.inserted).toContain('jobtest-registry:alpha')
    const { rows } = await pool.query("select enabled, next_run_at, params, source from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].next_run_at).toBeNull()
    expect(rows[0].params).toEqual({})
    expect(rows[0].source).toBe('system')
  })

  it('★ 二次 seed 不覆盖人改过的 cron / enabled', async () => {
    await insertAlpha(pool, '*/5 * * * *', true)
    await seedSchedules(pool, defs)
    const { rows } = await pool.query("select cron, enabled from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(rows[0].cron).toBe('*/5 * * * *')
    expect(rows[0].enabled).toBe(true)
  })

  it('★ 软删行在 key 回到 registry 时复活（#2670）：只清 deleted_at，不动 enabled/cron', async () => {
    await insertAlpha(pool, '*/5 * * * *', false)
    await pool.query("update platform.job_schedule set deleted_at=now() where key='jobtest-registry:alpha'")
    const r = await seedSchedules(pool, defs)
    expect(r.revived).toContain('jobtest-registry:alpha')
    expect(r.inserted).not.toContain('jobtest-registry:alpha')
    const { rows } = await pool.query("select deleted_at, enabled, cron from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(rows[0].deleted_at).toBeNull()
    // 复活 ≠ 开跑：enabled 仍 false，四步开闸的人工闸门保留（#2668 实踩的语义）。
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].cron).toBe('*/5 * * * *')
  })

  it('★ 已活行二次 seed 不重报（inserted / revived 都空）', async () => {
    await insertAlpha(pool, '*/5 * * * *', false)
    const r = await seedSchedules(pool, defs)
    expect(r.inserted).toEqual([])
    expect(r.revived).toEqual([])
  })

  it('★ 已启用但 next_run_at 为空 ⇒ 补算（不立即跑）', async () => {
    await insertAlpha(pool, '7 * * * *', true)
    const r = await seedSchedules(pool, defs, new Date('2026-11-14T07:00:00Z'))
    expect(r.filled).toContain('jobtest-registry:alpha')
    const { rows } = await pool.query("select next_run_at from platform.job_schedule where key='jobtest-registry:alpha'")
    // cron `7 * * * *` @ UTC，从固定 now 07:00 起的下一个触发点是 07:07。
    expect(new Date(rows[0].next_run_at).toISOString()).toBe('2026-11-14T07:07:00.000Z')
  })

  it('★ 非法 cron 在 seed 期炸（fail-closed）', async () => {
    await expect(seedSchedules(pool, [{ ...defs[0], key: 'jobtest-registry:bad', cron: '0 0 * * MON' }]))
      .rejects.toThrow(/cron/)
  })

  it('★ script 不在 scripts/ 下也在 seed 期炸（fail-closed）', async () => {
    await expect(seedSchedules(pool, [{ ...defs[0], key: 'jobtest-registry:badscript', script: 'app/x.mjs' }]))
      .rejects.toThrow(/script/)
    const { rows } = await pool.query("select count(*)::int as n from platform.job_schedule where key='jobtest-registry:badscript'")
    expect(rows[0].n).toBe(0)
  })

  it('★ noSystemSchedule 条目只登记 handler，不建系统排班行；普通条目照旧插入', async () => {
    const r = await seedSchedules(pool, [...defs, handlerOnlyDef])
    expect(r.inserted).toContain('jobtest-registry:alpha')
    expect(r.inserted).not.toContain('jobtest-registry:handler-only')
    const { rows } = await pool.query("select count(*)::int as n from platform.job_schedule where key='jobtest-registry:handler-only'")
    expect(rows[0].n).toBe(0)
    const alpha = await pool.query("select count(*)::int as n from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(alpha.rows[0].n).toBe(1)
  })
})

/** registry 的 script 是相对仓根的路径；用测试文件位置锚定仓根（apps/server/src/scheduler → ../../../..），不依赖 cwd。 */
function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../../../${relative}`, import.meta.url))
}

describe('JOB_REGISTRY · 作业域（#2511）', () => {
  it('命名前缀与 scope 一致（防止新作业漏声明/声明错域）', () => {
    for (const d of JOB_REGISTRY) {
      const expectData = d.key.startsWith('data.')
      expect(
        { key: d.key, scope: d.scope },
        `${d.key} 的 scope 与命名前缀不符`,
      ).toEqual({ key: d.key, scope: expectData ? 'data' : 'platform' })
    }
  })

  it('data 域的 dbt 类必须声明 requiresEnv（缺 env 要在启动时被挡住，而不是跑到一半炸）', () => {
    for (const d of JOB_REGISTRY.filter((x) => x.key.startsWith('data.dbt_'))) {
      expect(d.requiresEnv ?? [], `${d.key} 缺 requiresEnv`).toContain('DATA_WAREHOUSE_URL')
    }
  })
})

describe('JOB_REGISTRY', () => {
  // 不依赖 DB：纯目录断言（无 DATABASE_URL 的裸跑也保这层覆盖）。
  it('★ 含 handler-only 的 notify.emit，且 script 指向仓内真实文件', () => {
    const def = JOB_REGISTRY.find((d) => d.key === 'notify.emit')
    expect(def).toBeDefined()
    expect(def!.noSystemSchedule).toBe(true)
    expect(def!.script).toBe('scripts/notify-emit-job.mjs')
    expect(existsSync(repoPath(def!.script))).toBe(true)
  })

  it('★ 每个条目的 script 都指向仓内真实文件（新增条目忘建文件 ⇒ 红）', () => {
    const missing = JOB_REGISTRY.filter((d) => !existsSync(repoPath(d.script))).map((d) => `${d.key} → ${d.script}`)
    expect(missing).toEqual([])
  })
})

describe('registry · dbt tick（Wave 8 P1）', () => {
  it('★ data.dbt_tick 覆盖采集窗口（CST 9-23 + 次日 0-1），且 env 指向 tick 档', () => {
    const def = JOB_REGISTRY.find((d) => d.key === 'data.dbt_tick')!
    expect(def).toBeDefined()
    // 采集 tick 是 */10 9-23,0-1（CST）；物化晚 2 分钟，故 UTC 1-17 = CST 09:02–次日 01:52。
    expect(def.cron).toBe('2-59/10 1-17 * * *')
    expect(def.timeoutMs).toBe(600000)
    expect(def.maxAttempts).toBe(1)
    expect(def.env).toEqual({ MATERIALIZE_SCOPE: 'tick', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' })
    expect(existsSync(repoPath(def.script))).toBe(true)
  })
})

describe('registry · dbt hourly/tables（Wave 8 P1 / A3 拆车道）', () => {
  it('★ 1h 车道：门店维 :04 / 各域 :05–:41 / 窗口审计 :45', () => {
    const dims = JOB_REGISTRY.find((d) => d.key === 'data.dbt_hourly_dims')!
    expect(dims.cron).toBe('4 1-15 * * *')
    expect(dims.env?.MATERIALIZE_HOURLY_SELECT).toBe('stg_lemeng_branch')
    expect(dims.timeoutMs).toBe(300000)
    expect(dims.maxAttempts).toBe(2)
    const audit = JOB_REGISTRY.find((d) => d.key === 'data.dbt_hourly')!
    expect(audit.cron).toBe('45 1-15 * * *')
    expect(audit.timeoutMs).toBe(1800000)
    expect(audit.env?.MATERIALIZE_SCOPE).toBe('hourly')
    expect(audit.env?.MATERIALIZE_HOURLY_SELECT).toBe('tag:audit_window')
    const tables = JOB_REGISTRY.find((d) => d.key === 'data.dbt_tables')!
    expect(tables.cron).toBe('30 18 * * *')
    expect(tables.timeoutMs).toBe(9000000) // 2026-11-26：湖读 256s/全史 count ⇒ 90 分钟常超时，放宽到 150 分钟
    expect(tables.env?.MATERIALIZE_SCOPE).toBe('tables')
    for (const d of [dims, audit, tables]) {
      expect(d.env?.DATA_PLANE_DOMAINS).toBe('lemeng')
      expect(d.env?.MATERIALIZE_MODE).toBe('container')
      expect(existsSync(repoPath(d.script))).toBe(true)
    }
  })

  it('★ 1h 车道：每个域一个 job，车道名与 data-lanes.json 对应、分钟错峰且不撞 tick', () => {
    const lanes = JSON.parse(readFileSync(repoPath('scripts/lemeng/data-lanes.json'), 'utf8')) as {
      lanes: { nonretail_1h: { domains: Record<string, string[]> } }
    }
    const domains = Object.keys(lanes.lanes.nonretail_1h.domains)
    const minutes = new Set<number>()
    for (const d of domains) {
      const job = JOB_REGISTRY.find((j) => j.key === `data.dbt_hourly_${d}`)
      expect(job, `缺少 data.dbt_hourly_${d}`).toBeTruthy()
      expect(job!.env?.MATERIALIZE_SCOPE).toBe('hourly')
      expect(job!.env?.MATERIALIZE_LANE).toBe(`nonretail_1h.${d}`)
      expect(job!.scope).toBe('data')
      expect(job!.timeoutMs).toBe(900000)
      expect(job!.maxAttempts).toBe(3) // 429 busy 是容量竞态，不能 1 次判终态
      const m = Number(job!.cron.split(' ')[0])
      expect(Number.isInteger(m)).toBe(true)
      // 10m tick 是 `2-59/10`：域 job 不落 2 mod 10，避免与 tick 撞分钟。
      expect(m % 10).not.toBe(2)
      minutes.add(m)
    }
    expect(minutes.size).toBe(domains.length) // 错峰：分钟互异
    expect(Math.max(...minutes)).toBeLessThan(45) // 审计 :45 之前跑完
  })

  it('★ 分块车道（B2）：retail_derived 两块的选择器并集 == 车道模型清单，且不重不漏', () => {
    const lanes = JSON.parse(readFileSync(repoPath('scripts/lemeng/data-lanes.json'), 'utf8')) as {
      lanes: { nonretail_1h: { domains: Record<string, string[]> } }
    }
    const blocks = JOB_REGISTRY.filter((j) => j.key === 'data.dbt_hourly_retail_derived'
      || j.key.startsWith('data.dbt_hourly_retail_derived_'))
    expect(blocks).toHaveLength(2)
    // 两块都声明同一条车道：排除集（audit/audit_window）与语义不变，只是范围收窄。
    for (const b of blocks) expect(b.env?.MATERIALIZE_LANE).toBe('nonretail_1h.retail_derived')
    const selected = blocks
      .flatMap((b) => (b.env?.MATERIALIZE_HOURLY_SELECT ?? '').split(/\s+/).filter(Boolean))
      .sort()
    expect(selected).toEqual([...lanes.lanes.nonretail_1h.domains.retail_derived].sort())
    // 两块错开分钟，且都不撞 tick（2 mod 10）。
    const ms = blocks.map((b) => Number(b.cron.split(' ')[0]))
    expect(new Set(ms).size).toBe(2)
    for (const m of ms) expect(m % 10).not.toBe(2)
  })

  it('★ 日档车道 job：daily_report 两件（09:10 CST，错开 item_profit 09:05 采集）', () => {
    const job = JOB_REGISTRY.find((d) => d.key === 'data.dbt_daily_report')!
    expect(job.cron).toBe('10 1 * * *')
    expect(job.env?.MATERIALIZE_SCOPE).toBe('hourly')
    expect(job.env?.MATERIALIZE_LANE).toBe('daily_report')
    expect(job.timeoutMs).toBe(900000)
    expect(job.maxAttempts).toBe(2)
    expect(job.scope).toBe('data')
    expect(existsSync(repoPath(job.script))).toBe(true)
  })

  it('★ #2674 拆档：全史 CTAS 模型从主档排除，独立对账档只跑它们', () => {
    // 拆档理由：三个全史模型单轮 ~11 分钟且必撞采集期 ETag，与几十个表同档 ⇒ 90 分钟必超时，
    // 新增/修改的 table 模型整天进不了生产（#2655 实证）。
    // #2890：`recon_run` 也必须在对账档里 —— 它只是 `recon_break` 的 count(*) 汇总（毫秒级、
    // 不碰湖），留在主档会被主档超时连坐（2026-11-26：主档 90 分钟被杀 ⇒ 台账停在 11-21，
    // 而 recon_break 已被对账档刷到 11-23）。台账的刷新者必须 = 它上游的刷新者。
    const FULL = ['recon_fact', 'recon_break', 'fct_retail_swap_offset', 'recon_run']
    const tables = JOB_REGISTRY.find((d) => d.key === 'data.dbt_tables')!
    const recon = JOB_REGISTRY.find((d) => d.key === 'data.dbt_tables_recon')!
    expect(recon, 'data.dbt_tables_recon').toBeDefined()
    // 主档：默认选择器 + 明确的排除清单（不许两档都跑同一模型 ⇒ 并发写同一张表）
    expect(tables.env?.MATERIALIZE_TABLES_SELECT).toBeUndefined()
    expect(String(tables.env?.MATERIALIZE_TABLES_EXCLUDE).split(/\s+/).sort()).toEqual([...FULL].sort())
    // 对账档：**只**跑这四个，写死选择器
    expect(String(recon.env?.MATERIALIZE_TABLES_SELECT).split(/\s+/).sort()).toEqual([...FULL].sort())
    expect(recon.env?.MATERIALIZE_TABLES_EXCLUDE).toBeUndefined()
    // #2896：对账档在**夜间空窗**（CST 03:30）——主档 02:30 之后、preagg 00:40 之后，
    // 且不与 04:30 的台账闸、05:30 起的审计链重叠。原 11:45 是 #2792 挪夜间时漏改的化石。
    expect(recon.cron).toBe('30 19 * * *')
    expect(recon.timeoutMs).toBe(2700000)
    expect(recon.env?.MATERIALIZE_SCOPE).toBe('tables')
    expect(recon.env?.MATERIALIZE_MODE).toBe('container')
    expect(existsSync(repoPath(recon.script))).toBe(true)
  })

  it('★ #2894 台账当夜自愈闸：CST 04:30，判据与断言 ⑪ 同源，缺行才重建', () => {
    // 断言 ⑪ 是只读兜底：它红了没人会因此重建台账 ⇒ 红满一整天（2026-11-26 实证）。
    // 本 job 用同一条 SQL 判 T-4 缺行，缺了才重建（≈35s，不碰 500s 的 swap_offset）。
    const guard = JOB_REGISTRY.find((d) => d.key === 'data.recon_ledger_guard')!
    expect(guard, 'data.recon_ledger_guard').toBeDefined()
    expect(guard.scope).toBe('data')
    expect(guard.cron).toBe('30 20 * * *') // UTC ⇒ CST 04:30
    expect(guard.timezone).toBe('UTC')
    expect(guard.timeoutMs).toBe(1800000)
    expect(guard.maxAttempts).toBe(1) // 判据红是真红，重试只会重复吵
    expect(existsSync(repoPath(guard.script))).toBe(true)
    // 要跑 dbt（materialize.sh 容器模式）+ 读仓库 ⇒ 两组 env 都得在
    for (const k of ['DATA_WAREHOUSE_URL', 'DATABASE_URL', 'LEMENG_ZOS_BUCKET']) {
      expect(guard.requiresEnv).toContain(k)
    }
    // 重建范围写死在脚本里（不靠 registry env 传入）：只许碰台账族三个模型，
    // 尤其**不许**带上 `fct_retail_swap_offset`（单轮 ~500s，与「某天没进台账」无关）。
    const src = readFileSync(repoPath(guard.script), 'utf8')
    const sel = src.match(/MATERIALIZE_TABLES_SELECT:\s*'([^']+)'/)?.[1]
    expect(sel, '缺 MATERIALIZE_TABLES_SELECT').toBeDefined()
    expect(String(sel).split(/\s+/).sort()).toEqual(['recon_break', 'recon_fact', 'recon_run'])
  })
})

describe('registry · dbt 对账分族（full / window，#2428）', () => {
  const FULL = [
    { scope: 'platform', key: 'data.dbt_audit_a1', cron: '30 22 * * *', n: 5 },
    { scope: 'platform', key: 'data.dbt_audit_a2a', cron: '30 21 * * *', n: 8 },
    { scope: 'platform', key: 'data.dbt_audit_a2b', cron: '0 22 * * *', n: 6 },
  ] as const
  const WINDOW = { scope: 'platform', key: 'data.dbt_audit_window', cron: '30 23 * * *', n: 24 } as const

  /** 递归收集 dbt/models 下的 .sql（ref 解析用）。 */
  function collectSql(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) collectSql(p, out)
      else if (name.endsWith('.sql')) out.push(p)
    }
    return out
  }

  /** ref 名 → 物化类型（incremental / table / view / default / seed）。 */
  const materialized = (() => {
    const map = new Map<string, string>()
    const modelsDir = repoPath('dbt/models')
    for (const file of collectSql(modelsDir)) {
      const name = file.split('/').pop()!.replace(/\.sql$/, '')
      const text = readFileSync(file, 'utf8')
      const m = text.match(/materialized\s*=\s*'(\w+)'/)
      map.set(name, m?.[1] ?? 'default')
    }
    // seed（CSV）不是增量模型，但要能被 ref 解析到，否则会被误判成「名字抄错」。
    for (const name of readdirSync(repoPath('dbt/seeds'))) {
      if (name.endsWith('.csv')) map.set(name.replace(/\.csv$/, ''), 'seed')
    }
    return map
  })()

  const auditNames = (key: string): string[] => {
    const d = JOB_REGISTRY.find((x) => x.key === key)!
    return (d.env?.MATERIALIZE_AUDIT_SELECT ?? '').split(/\s+/).filter(Boolean)
  }

  it('★ full/window 两族的 cron/scope/窗口开关', () => {
    for (const c of FULL) {
      const d = JOB_REGISTRY.find((x) => x.key === c.key)!
      expect(d, c.key).toBeDefined()
      expect(d.cron, c.key).toBe(c.cron)
      expect(d.timeoutMs, c.key).toBe(5400000)
      expect(d.maxAttempts, c.key).toBe(1)
      expect(d.env?.MATERIALIZE_SCOPE, c.key).toBe('audit')
      expect(d.env?.MATERIALIZE_AUDIT_WINDOW, c.key).toBeUndefined()
      expect(d.env?.DATA_PLANE_DOMAINS, c.key).toBe('lemeng')
      expect(d.env?.MATERIALIZE_MODE, c.key).toBe('container')
      expect(existsSync(repoPath(d.script)), c.key).toBe(true)
    }
    const w = JOB_REGISTRY.find((x) => x.key === WINDOW.key)!
    expect(w).toBeDefined()
    expect(w.cron).toBe(WINDOW.cron)
    expect(w.timeoutMs).toBe(5400000)
    expect(w.env?.MATERIALIZE_SCOPE).toBe('audit')
    expect(w.env?.MATERIALIZE_AUDIT_WINDOW).toBe('1')
    expect(w.env?.DATA_PLANE_DOMAINS).toBe('lemeng')
    expect(w.env?.MATERIALIZE_MODE).toBe('container')
    expect(existsSync(repoPath(w.script))).toBe(true)
  })

  it('★ 选择器每条都对应仓内 dbt test 文件（抄错名字 ⇒ 红）', () => {
    for (const c of [...FULL, WINDOW]) {
      const names = auditNames(c.key)
      expect(names.length, c.key).toBe(c.n)
      const missing = names.filter((n) => !existsSync(repoPath(`dbt/tests/lemeng/${n}.sql`)))
      expect(missing, c.key).toEqual([])
    }
  })

  it('★ 分族不混：全史段不得引用增量模型；窗口段每条至少要有一个增量模型', () => {
    const refsOf = (name: string): string[] => {
      const text = readFileSync(repoPath(`dbt/tests/lemeng/${name}.sql`), 'utf8')
      return [...text.matchAll(/ref\('([a-z0-9_]+)'\)/g)].map((m) => m[1])
    }
    for (const c of FULL) {
      for (const name of auditNames(c.key)) {
        const refs = refsOf(name)
        // ref 解析不到 = 名字抄错，或新增了 seed 目录没登记（比默默放行安全）。
        expect(refs.filter((r) => !materialized.has(r)), `${c.key} / ${name} 的 ref 解析不到`).toEqual([])
        const bad = refs.filter((r) => materialized.get(r) === 'incremental')
        expect(bad, `${c.key} / ${name} 引用了增量模型（结构性假红）`).toEqual([])
      }
    }
    for (const name of auditNames(WINDOW.key)) {
      const refs = refsOf(name)
      expect(refs.filter((r) => !materialized.has(r)), `${WINDOW.key} / ${name} 的 ref 解析不到`).toEqual([])
      const inc = refs.filter((r) => materialized.get(r) === 'incremental')
      expect(inc.length, `${WINDOW.key} / ${name} 没有增量模型 refs（分族错位？）`).toBeGreaterThan(0)
    }
  })

  it('★ 读湖的审计必须带 audit_until_date 上界（只比 T-3+，不跟每小时重采赛跑）', () => {
    // 根因（2026-11-18）：T-1 被 15 个 L0、T-2 被库存快照每小时重采；审计的 mart 是「建表那刻」的湖、
    // 复算侧是「读那刻」的湖 ⇒ 比 T-1/T-2 = 拿旧 mart 比新湖（run 6609/6628 实测）。上界宏 = 上海今天−2。
    const dir = repoPath('dbt/tests/lemeng')
    for (const file of readdirSync(dir)) {
      if (!file.startsWith('audit_') || !file.endsWith('.sql')) continue
      const text = readFileSync(`${dir}/${file}`, 'utf8')
      if (!text.includes('read_parquet')) continue // 只比 mart 的审计不在此列（两侧同一次重建）
      expect(text.includes('audit_until_date'), `${file} 读湖但没有 audit_until_date 上界`).toBe(true)
    }
  })

  it('★ 回填窗口宏必须成对接线：backfill_to 与 cutoff_or_backfill 出现次数相等（#2493）', () => {
    // 只压下界不封上界 = 从 bf_from 一路读到今天 ⇒ 等价全史重跑 = pg_duckdb 崩溃路径
    //（publish-dims / 全史 CTAS 两次实证）。接入回填宏的模型逐个登记在下面。
    const models = [
      'fct_hq_outbound', 'fct_client_expense', 'fct_outbound_region', 'fct_transfer_item',
      'fct_inventory_snapshot',
    ]
    for (const m of models) {
      const text = readFileSync(repoPath(`dbt/models/lemeng/marts/${m}.sql`), 'utf8')
      const lower = (text.match(/cutoff_or_backfill\(/g) ?? []).length
      const upper = (text.match(/backfill_to\(\)/g) ?? []).length
      expect(lower, `${m}：backfill_to(${upper}) 必须与 cutoff_or_backfill(${lower}) 成对`).toBe(upper)
      expect(lower, `${m}：一个回填门都没有（接线被删？）`).toBeGreaterThan(0)
    }
    // 宏本体存在且不传 vars 时零行为变化（输出空/回落 incremental_cutoff）
    const macro = readFileSync(repoPath('dbt/macros/backfill_bounds.sql'), 'utf8')
    expect(macro).toContain("var('bf_from', '')")
    expect(macro).toContain("var('bf_to', '')")
  })

  it('★ 上界必须落在**每一个**带 bizday 的数据源 CTE 上（只写一处 = 单边裁掉 T-1/T-2 ⇒ 结构性假红）', () => {
    // 2026-11-18 run 7224 实测：`audit_lemeng__contribution__margin_rate` 只给湖侧 CTE 加了上界，
    // expense CTE 与 materialized CTE 没加 ⇒ 复算侧少了 T-1/T-2、物化侧还有 ⇒ 479 行「差异」。
    // 文件级「包含 audit_until_date」拦不住这种半截改法，所以按 **CTE 逐块**判：
    //   · 块里读湖（read_parquet / window_read_parquet）或读 fct mart（ref('fct…））
    //   · 且块里有 bizday（维度快照 CTE 如 branch_latest / item_latest 没 bizday，不在此列）
    // ⇒ 块内必须出现 audit_until_date。
    const dir = repoPath('dbt/tests/lemeng')
    const offenders: string[] = []
    for (const file of readdirSync(dir)) {
      if (!file.startsWith('audit_') || !file.endsWith('.sql')) continue
      const lines = readFileSync(`${dir}/${file}`, 'utf8').split('\n')
      // CTE 块：`name as (` 顶格开头，`),` 顶格结尾（仓内审计文件一致采用此排版）。
      const blocks: Array<{ name: string; body: string }> = []
      let start = -1
      let name = ''
      lines.forEach((line, i) => {
        if (/^[a-z0-9_]+ as \($/.test(line)) {
          if (start >= 0) blocks.push({ name, body: lines.slice(start, i).join('\n') })
          start = i
          name = line.replace(/ as \($/, '')
        }
      })
      // 收尾块 = 最后一个 CTE 到文件末（含最终 select），否则结尾段漏判。
      if (start >= 0) blocks.push({ name, body: lines.slice(start).join('\n') })
      for (const b of blocks) {
        const reads = b.body.includes('read_parquet') || b.body.includes('window_read_parquet')
          || /ref\('fct/.test(b.body)
        if (!reads || !/\bbizday\b/.test(b.body)) continue
        if (!b.body.includes('audit_until_date')) offenders.push(`${file} :: ${b.name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  // 窗口感知 = SQL 自己读 `window_read_parquet`（湖侧）或使用 `window_start_date()`（两侧下界）；
  // 只比 mart、日期固定且不读湖的 canary 不参与窗口，登记理由后放行。
  const MART_ONLY_OK = new Map([
    ['audit_order_event_ref_coverage_20261020', '固定日 2026-10-20 的 mart 快照 canary，不读湖'],
    ['audit_order_event_type_counts_20261020', '同上'],
  ])

  it('★ 窗口段每条审计都必须自己读窗口（#2456 改造后的护栏）', () => {
    for (const name of auditNames(WINDOW.key)) {
      const text = readFileSync(repoPath(`dbt/tests/lemeng/${name}.sql`), 'utf8')
      const aware = text.includes('window_read_parquet') || text.includes('window_start_date')
      if (!aware) {
        expect(MART_ONLY_OK.has(name), `${WINDOW.key} / ${name} 未 window 化，也未登记为 mart-only canary`).toBe(true)
        continue
      }
      expect(MART_ONLY_OK.has(name), `${name} 已 window 化，请从 mart-only 清单移除`).toBe(false)
      // 读湖的审计必须同时有下界；只加宏不加 WHERE = 「全史湖 vs 窗口 mart」结构性不一致。
      if (text.includes('window_read_parquet')) {
        expect(text.includes('window_start_date'), `${name} 用了 window_read_parquet 但没有 window_start_date 下界`).toBe(true)
      }
    }
  })
})

describe('registry · Wave 8 ③ 平台/运维类（#2450）', () => {
  it('★ 词表物化与私有测度归档：cron/timeout/脚本在位', () => {
    const sem = JOB_REGISTRY.find((d) => d.key === 'data.semantics_sync')!
    expect(sem, 'data.semantics_sync').toBeDefined()
    expect(sem.cron).toBe('33 4 * * *')
    expect(sem.timeoutMs).toBe(300000)
    expect(sem.maxAttempts).toBe(2)
    expect(sem.script).toBe('scripts/sync-data-semantics.mjs')
    expect(existsSync(repoPath(sem.script))).toBe(true)

    const arc = JOB_REGISTRY.find((d) => d.key === 'data.archive_private_measures')!
    expect(arc, 'data.archive_private_measures').toBeDefined()
    expect(arc.cron).toBe('30 3 * * *')
    expect(arc.timeoutMs).toBe(300000)
    expect(arc.script).toBe('scripts/archive-private-measures.mjs')
    // `--org` 是脚本必填项（缺了直接 usage 退出）⇒ 必须显式给。
    expect(arc.args).toEqual(['--org', 'shanhaiyiguo-org'])
    expect(existsSync(repoPath(arc.script))).toBe(true)
  })

  it('★ 维表发布 publish-dims：cron/重试与现役一致，timeout 放宽到 30 分钟', () => {
    // openship `custom:hjf8m1PBcP7fZpWt`：`43 3 * * *`（CST 11:43）、attempts=2。
    // timeout 由 600s 放宽到 1800s：600s 是 openship 时代的值，而按月分块的真实耗时从未跑通过
    // （#2491 修好 to_char 前每次都崩/超时），1M 行的 dim_transfer_out 分块聚合需要更大余量。
    const pub = JOB_REGISTRY.find((d) => d.key === 'data.publish_dims')!
    expect(pub, 'data.publish_dims').toBeDefined()
    expect(pub.cron).toBe('43 3 * * *')
    expect(pub.timezone).toBe('UTC')
    expect(pub.timeoutMs).toBe(1800000)
    expect(pub.maxAttempts).toBe(2)
    expect(pub.script).toBe('scripts/lemeng/publish-dims.mjs')
    expect(pub.args ?? []).toEqual([])
    expect(existsSync(repoPath(pub.script))).toBe(true)
  })
})

describe('registry · 日更件零行巡检（#2590，判据化）', () => {
  it('★ data.zero_row_check：cron/超时与现役一致，且判据本体是 python（壳只透传退出码）', () => {
    // 原 openship job：`30 2 * * *`（CST 10:30）、timeout 1800s、attempts=1。
    const def = JOB_REGISTRY.find((d) => d.key === 'data.zero_row_check')!
    expect(def, 'data.zero_row_check').toBeDefined()
    expect(def.cron).toBe('30 2 * * *')
    expect(def.timezone).toBe('UTC')
    expect(def.timeoutMs).toBe(1800000)
    expect(def.maxAttempts).toBe(1)
    expect(def.script).toBe('scripts/lemeng/zero-row-check.mjs')
    // 数据面化后不再 docker exec ⇒ 只依赖 DSN；缺 DSN 要在启动期挡住（作业不进 claim 集合）。
    expect(def.requiresEnv).toEqual(['DATABASE_URL', 'DATA_WAREHOUSE_URL'])
    expect(existsSync(repoPath(def.script))).toBe(true)
    expect(existsSync(repoPath('scripts/lemeng/check-zero-row-days.py'))).toBe(true)
  })
})

describe('registry · 需求挖掘（#2560 落点裁决）', () => {
  it('★ demand.mining 落 platform 域（读 OO 的凭据在应用单元），cron/timeout 与现役一致', () => {
    // 现役 openship job：`10 21 * * *`（CST 05:10）、timeout 300s、attempts=1。
    const def = JOB_REGISTRY.find((d) => d.key === 'demand.mining')!
    expect(def, 'demand.mining').toBeDefined()
    // 关键断言：**不是 data 域**——数据单元只有摄取凭据，读端点 401（2026-11-20 实测）。
    expect(def.scope).toBe('platform')
    expect(def.cron).toBe('10 21 * * *')
    expect(def.timezone).toBe('UTC')
    expect(def.timeoutMs).toBe(300000)
    expect(def.maxAttempts).toBe(1)
    expect(def.script).toBe('scripts/demand-mining.mjs')
    expect(def.args ?? []).toEqual([])
    // 读 OO 的三元组缺一不可，否则作业不进 claim 集合（启动期就红，而不是等到 cron 时刻）。
    expect(def.requiresEnv).toContain('OO_READ_URL')
    expect(def.requiresEnv).toContain('OO_READ_ORG')
    expect(def.requiresEnv).toContain('OO_READ_TOKEN')
    expect(existsSync(repoPath(def.script))).toBe(true)
  })
})

describe('registry · 业务监控 tick（W7-V1）', () => {
  it('★ data.monitor_tick 每分钟一条、脚本在位、不传参数', () => {
    const def = JOB_REGISTRY.find((d) => d.key === 'data.monitor_tick')!
    expect(def).toBeDefined()
    expect(def.cron).toBe('* * * * *')
    expect(def.expectedIntervalSecs).toBe(60)
    expect(def.args ?? []).toEqual([])
    expect(existsSync(repoPath(def.script))).toBe(true)
  })
})

describe('registry · OA 审批对账（#2363/#2385 收口）', () => {
  // 两个脚本此前零调度登记（配置齐全也不会跑）；本组断言登记形态与 notify.reconcile 同款：
  // 调脚本、platform 域、小时级错峰、失败走既有 jobs.job.failed 通路（不新增告警面）。
  const OA = [
    { key: 'oa.standard_approval_reconcile', cron: '17 * * * *', script: 'scripts/oa-standard-approval-reconcile.mjs' },
    { key: 'oa.approval_reconcile', cron: '47 * * * *', script: 'scripts/oa-approval-reconcile.mjs' },
  ] as const

  it('★ 两条都在：platform 域、小时级错峰、UTC、timeout/重试与 notify.reconcile 同款', () => {
    for (const c of OA) {
      const def = JOB_REGISTRY.find((d) => d.key === c.key)
      expect(def, c.key).toBeDefined()
      expect(def!.scope, c.key).toBe('platform')
      expect(def!.cron, c.key).toBe(c.cron)
      expect(def!.timezone, c.key).toBe('UTC')
      expect(def!.timeoutMs, c.key).toBe(300000)
      expect(def!.maxAttempts, c.key).toBe(2)
      expect(def!.expectedIntervalSecs, c.key).toBe(3600)
      expect(def!.args ?? [], c.key).toEqual([])
      // 缺 DATABASE_URL 要在启动期挡住（不进 claim 集合），而不是每小时 exit 1/2 刷失败告警。
      expect(def!.requiresEnv, c.key).toContain('DATABASE_URL')
      expect(existsSync(repoPath(c.script)), c.script).toBe(true)
    }
    // 错峰：两条互不相同，且都不撞既有小时级 job 的分钟位（:07/:13/:23/:30/:40）。
    const minutes = OA.map((c) => Number(c.cron.split(' ')[0]))
    expect(new Set(minutes).size).toBe(minutes.length)
  })

  it('★ script 字段逐字指向仓内脚本（抄错名字 ⇒ 红在 existsSync 之前先红在这里）', () => {
    const std = JOB_REGISTRY.find((d) => d.key === 'oa.standard_approval_reconcile')!
    const app = JOB_REGISTRY.find((d) => d.key === 'oa.approval_reconcile')!
    expect(std.script).toBe('scripts/oa-standard-approval-reconcile.mjs')
    expect(app.script).toBe('scripts/oa-approval-reconcile.mjs')
  })
})

describe('registry · 小时对象回收（Wave 8 ③；#2668 拆回两条）', () => {
  it('★ 小时对象回收两条排班：激进档（30 分钟）+ 保守档（每日）', () => {
    // #2588 当年合并的依据「96 个小文件 ≈ +0.8s」已于 2026-11-22 实测失效（单微文件 ~350ms，
    // 热腿 66 文件 ≈ 24s/tick，见 #2668）。护栏目的更新为：**两条都必须在**（激进档停跑两日
    // 即堆积 71 个微文件拖垮所有热腿查询）+ 判据脚本同源（同 hour-partition-gc.mjs 入口）。
    const keys = JOB_REGISTRY.filter((d) => d.script === 'scripts/lemeng/hour-partition-gc.mjs').map((d) => d.key)
    expect(keys).toEqual(['data.hour_partition_gc', 'data.hot_hours_gc'])
  })

  it('★ data.hour_partition_gc：激进档（UTC 今天前、扫 4 天，#2668）', () => {
    const def = JOB_REGISTRY.find((d) => d.key === 'data.hour_partition_gc')!
    expect(def, 'data.hour_partition_gc').toBeDefined()
    expect(def.cron).toBe('5,35 * * * *')
    expect(def.timezone).toBe('UTC')
    expect(def.timeoutMs).toBe(300000)
    expect(def.maxAttempts).toBe(1)
    expect(def.expectedIntervalSecs).toBe(1800)
    expect(def.script).toBe('scripts/lemeng/hour-partition-gc.mjs')
    expect(def.args ?? []).toEqual([])
    // 窗口靠 def.env 给：缺了会按脚本默认（UTC 今天 / 扫 10 天）跑——多扫 6 天纯浪费 HEAD。
    expect(def.env).toEqual({ GC_DAYS_BACK: '0', GC_TZ: 'UTC', GC_SCAN_DAYS: '4' })
    expect(existsSync(repoPath(def.script))).toBe(true)
  })

  it('★ data.hot_hours_gc：同一入口的保守档（上海今天−2、扫 30 天），cron 与原 gc-hot-hours 一致', () => {
    // 现役 openship job `custom:-ff8kWdZzvItKCYa`：`20 19 * * *`（CST 03:20）、timeout 600s、不重试。
    const def = JOB_REGISTRY.find((d) => d.key === 'data.hot_hours_gc')!
    expect(def, 'data.hot_hours_gc').toBeDefined()
    expect(def.cron).toBe('20 19 * * *')
    expect(def.timezone).toBe('UTC')
    expect(def.timeoutMs).toBe(600000)
    expect(def.maxAttempts).toBe(1)
    expect(def.expectedIntervalSecs).toBe(86400)
    expect(def.script).toBe('scripts/lemeng/hour-partition-gc.mjs')
    expect(def.args ?? []).toEqual([])
    // 窗口靠 def.env 给：调度器容器里没有 GC_* 变量，缺了会按默认（UTC 今天 / 扫 10 天）跑 ——
    // 那等于把保守档悄悄变成激进档，删到重述窗口内的日子。
    expect(def.env).toEqual({ GC_DAYS_BACK: '2', GC_TZ: 'Asia/Shanghai', GC_SCAN_DAYS: '30' })
    expect(existsSync(repoPath(def.script))).toBe(true)
  })

  it('★ aftersales.attachment_gc：平台域、每日 CST 04:20、排班必须 --apply（脚本默认 dry-run）', () => {
    const def = JOB_REGISTRY.find((d) => d.key === 'aftersales.attachment_gc')!
    expect(def, 'aftersales.attachment_gc').toBeDefined()
    // 业务动作（#2728）⇒ 平台调度器。租户存储配置在 `platform.tenant` 行上、平台默认 env 只是兜底
    // ⇒ 只要求 DATABASE_URL（不能把 AFTERSALES_ZOS_* 列为必需：缺平台默认时租户自备配置照样能删）。
    expect(def.scope).toBe('platform')
    expect(def.requiresEnv).toEqual(['DATABASE_URL'])
    expect(def.cron).toBe('20 20 * * *') // UTC 20:20 = CST 04:20（夜间低峰）
    expect(def.timezone).toBe('UTC')
    expect(def.expectedIntervalSecs).toBe(86400)
    // 缺 --apply = 每天只打 dry-run 报告、孤儿行与对象永不清理（静默失败）
    expect(def.args).toEqual(['--apply'])
    expect(existsSync(repoPath(def.script))).toBe(true)
  })
})

describe('registry · 子进程参数（W6-P4b）', () => {
  it('★ org.sync 必须带 --apply（脚本默认 dry-run，不带参数=空跑不写库）', () => {
    const def = JOB_REGISTRY.find((d) => d.key === 'org.sync')!
    expect(def.args).toEqual(['--apply'])
  })

  it('其余条目不传多余参数（避免命令被意外改变）', () => {
    // 带 args 的条目必须逐个登记理由——新增一条没理由的参数 = 命令被悄悄改掉。
    const allow = new Map([
      ['org.sync', '脚本默认 dry-run，必须 --apply'],
      ['data.archive_private_measures', '--org 必填，缺了直接 usage 退出'],
      ['platform.verify_regression', '--org 必填（platform.tenant.casdoor_org），缺了直接 usage 退出'],
      // #2628：一套脚本两个域（凭据边界拆开），靠 --group 选断言子集。
      // 缺了它 = 跑到全套 ⇒ 数据单元因无 OO 读凭据恒红 ⑭⑮、应用单元白跑仓库查询。
      ['data.warehouse_assertions', '--group core：只跑不依赖 OO 读凭据的 16 条'],
      ['platform.warehouse_assertions_oo', '--group oo：只跑 ⑭⑮（需 OO 读凭据，只在应用单元）'],
      // B2 第二阶段：全量证明档（org 单值 84s + 下钻延迟 23s）从 5 分钟档搬出来，每 30 分钟跑。
      ['data.warehouse_assertions_heavy', '--group heavy：只跑全量扫描/延迟探测两条（每 30 分钟）'],
      // spec §5 #12：脚本默认 dry-run（安全缺省），系统排班必须 --apply 才真删；
      // 缺了它 = 每天跑一轮只打报告、孤儿行与对象永不清理（= 现状的静默失败）。
      ['aftersales.attachment_gc', '脚本默认 dry-run，排班必须 --apply'],
    ])
    for (const d of JOB_REGISTRY) {
      if (allow.has(d.key)) continue
      expect(d.args ?? []).toEqual([])
    }
  })
})
