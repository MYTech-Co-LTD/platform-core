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
  it('★ data.dbt_tick 与 openship 现役逐字一致，且 env 指向 tick 档', () => {
    const def = JOB_REGISTRY.find((d) => d.key === 'data.dbt_tick')!
    expect(def).toBeDefined()
    expect(def.cron).toBe('2-59/10 1-15 * * *')
    expect(def.timeoutMs).toBe(600000)
    expect(def.maxAttempts).toBe(1)
    expect(def.env).toEqual({ MATERIALIZE_SCOPE: 'tick', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' })
    expect(existsSync(repoPath(def.script))).toBe(true)
  })
})

describe('registry · dbt hourly/tables（Wave 8 P1）', () => {
  it('★ cron/timeout/scope 与 openship 现役逐字一致', () => {
    const hourly = JOB_REGISTRY.find((d) => d.key === 'data.dbt_hourly')!
    expect(hourly.cron).toBe('5 1-15 * * *')
    expect(hourly.timeoutMs).toBe(1800000)
    expect(hourly.env?.MATERIALIZE_SCOPE).toBe('hourly')
    const tables = JOB_REGISTRY.find((d) => d.key === 'data.dbt_tables')!
    expect(tables.cron).toBe('25 2 * * *')
    expect(tables.timeoutMs).toBe(5400000)
    expect(tables.env?.MATERIALIZE_SCOPE).toBe('tables')
    for (const d of [hourly, tables]) {
      expect(d.env?.DATA_PLANE_DOMAINS).toBe('lemeng')
      expect(d.env?.MATERIALIZE_MODE).toBe('container')
      expect(existsSync(repoPath(d.script))).toBe(true)
    }
  })
})

describe('registry · dbt 对账分族（full / window，#2428）', () => {
  const FULL = [
    { scope: 'platform', key: 'data.dbt_audit_a1', cron: '0 6 * * *', n: 5 },
    { scope: 'platform', key: 'data.dbt_audit_a2a', cron: '30 3 * * *', n: 8 },
    { scope: 'platform', key: 'data.dbt_audit_a2b', cron: '45 4 * * *', n: 6 },
  ] as const
  const WINDOW = { scope: 'platform', key: 'data.dbt_audit_window', cron: '30 7 * * *', n: 24 } as const

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
    ])
    for (const d of JOB_REGISTRY) {
      if (allow.has(d.key)) continue
      expect(d.args ?? []).toEqual([])
    }
  })
})
