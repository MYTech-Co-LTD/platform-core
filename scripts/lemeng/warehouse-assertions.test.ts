// warehouse-assertions.test.ts — #2628 容器化断言面的护栏测试。
//
// 这一层**不连库**：连库的部分由真机首跑验收（deploy/jobs.md 四步开闸的第二步）。
// 守的是「移植时最容易悄悄改掉的三件东西」：
//   ① advisory 归集（判红不翻 job rc 的名单——少一个就把语义判据塞进了 openshift 通知腿）；
//   ② 反向测试钩子（每条 advisory 都必须能被 SELFTEST 逼出一行 ERR，否则「链路通不通」永远没人验）；
//   ③ 阈值不许被顺手收紧（容差的由来是源端发布滞后这类**结构事实**，不是偏好）。

import { describe, expect, it, vi, afterEach } from 'vitest'

const SANDBOX_ENV_KEYS = [
  'WIRE_REGION_REGISTERED_SELFTEST',
  'WIRE_RECON_LEDGER_COVER_SELFTEST',
  'WIRE_RECON_NOT_EVALUATED_SELFTEST',
  'WIRE_RECON_SOURCE_COVER_SELFTEST',
  'WIRE_CONFIG_DRIFT_SELFTEST',
  'WIRE_PG_CRASH_FREE_SELFTEST',
  'WIRE_SEALED_MANIFEST_SELFTEST',
  'WIRE_DETAIL_PATH_SELFTEST',
  'WIRE_HOT_PARTITIONS_SELFTEST',
]

afterEach(() => {
  for (const k of SANDBOX_ENV_KEYS) delete process.env[k]
  vi.resetModules()
})

/** 假 pool：让「纯判定」能测，不必连库。 */
function fakePool(handler: (sql: string, params?: unknown[]) => unknown) {
  const calls: string[] = []
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push(sql)
      return { rows: handler(sql, params) as never }
    },
    end: async () => {},
  }
}

describe('#2628 数据面断言面（容器化）', () => {
  it('advisory 集必须覆盖 ⑩–⑱ 九条（判红只投递、不翻 rc）', async () => {
    const { ADVISORY } = await import('./warehouse-assertions.mjs')
    expect([...ADVISORY].sort()).toEqual([
      'config_drift',
      'detail_path',
      'hot_partitions',
      'org_valid',
      'pg_crash_free',
      'recon_ledger_cover',
      'recon_not_evaluated',
      'recon_source_cover',
      'region_registered',
      'sealed_manifest',
    ])
    // 硬断言不得混进来——否则 advisory 语义被稀释，或反之把硬判据塞进桥。
    for (const hard of ['dns', 'tcp', 'query', 'fresh', 'marts_fresh', 'metrics', 'dims']) {
      expect(ADVISORY.has(hard)).toBe(false)
    }
  })

  it('每条 advisory 的自测钩子都能逼出一行 ERR（「判红行→桥→企微」这条腿的验收前提）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')

    process.env.WIRE_REGION_REGISTERED_SELFTEST = '1'
    expect((await mod.checkRegionRegistered(fakePool(() => []) as never)).ok).toBe(false)
    delete process.env.WIRE_REGION_REGISTERED_SELFTEST

    process.env.WIRE_RECON_LEDGER_COVER_SELFTEST = '1'
    expect((await mod.checkReconLedgerCover(fakePool(() => []) as never)).ok).toBe(false)
    delete process.env.WIRE_RECON_LEDGER_COVER_SELFTEST

    process.env.WIRE_RECON_NOT_EVALUATED_SELFTEST = '1'
    expect((await mod.checkReconNotEvaluated(fakePool(() => []) as never)).ok).toBe(false)
    delete process.env.WIRE_RECON_NOT_EVALUATED_SELFTEST

    process.env.WIRE_RECON_SOURCE_COVER_SELFTEST = '1'
    expect((await mod.checkReconSourceCover(fakePool(() => []) as never)).ok).toBe(false)
    delete process.env.WIRE_RECON_SOURCE_COVER_SELFTEST

    process.env.WIRE_SEALED_MANIFEST_SELFTEST = '1'
    expect((await mod.checkSealedManifest(fakePool(() => []) as never)).ok).toBe(false)
    delete process.env.WIRE_SEALED_MANIFEST_SELFTEST

    process.env.WIRE_DETAIL_PATH_SELFTEST = '1'
    expect((await mod.checkDetailPath(fakePool(() => []) as never)).ok).toBe(false)
    delete process.env.WIRE_DETAIL_PATH_SELFTEST

    process.env.WIRE_HOT_PARTITIONS_SELFTEST = '1'
    expect((await mod.checkHotPartitions(fakePool(() => []) as never)).ok).toBe(false)
    delete process.env.WIRE_HOT_PARTITIONS_SELFTEST
  })

  it('⑭⑮ 的自测钩子同样生效（走 OO 检索的两条，不该因为换了通道就丢掉反向测试）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')

    process.env.WIRE_CONFIG_DRIFT_SELFTEST = '1'
    expect((await mod.checkConfigDrift()).ok).toBe(false)
    delete process.env.WIRE_CONFIG_DRIFT_SELFTEST

    process.env.WIRE_PG_CRASH_FREE_SELFTEST = '1'
    expect((await mod.checkPgCrashFree()).ok).toBe(false)
    delete process.env.WIRE_PG_CRASH_FREE_SELFTEST
  })

  it('④ 新鲜度：max(bizday) 落后容差线即判红，且容差线用**上海时钟**减 FRESH_DAYS', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const stale = fakePool(() => [{ maxday: '2026-01-01', cutoff: '2026-01-10' }])
    const r = await mod.checkFresh(stale as never)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('停更')
    // 容差天数必须作为参数传下去（不是拼进 SQL 的字面量——后者容易被改成别的值而没人发现）
    expect(stale.calls[0]).toContain('$1')
  })

  it('④ 表空必须判红（空表不是「新鲜」，是断供）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const r = await mod.checkFresh(fakePool(() => [{ maxday: '', cutoff: '2026-01-10' }]) as never)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('表空')
  })

  it('⑨ 新构件容差**分档**照抄旧面：inventory_snapshot 宽一天（源端发布滞后是结构事实）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./warehouse-assertions.mjs', import.meta.url), 'utf8')
    expect(src).toContain('fct_inventory_snapshot:4')
    expect(src).toContain('fct_hq_outbound:3')
  })

  it('⑦ 取价面容差**时段感知**：13 点前 −3、之后 −2（固定 −2 会让每晚结构性红）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const pool = fakePool(() => [{ n: 1, maxday: '2026-01-01', cutoff: '2026-01-10' }])
    await mod.checkSettlementFace(pool as never)
    expect(pool.calls[0]).toMatch(/< 13/)
    expect(pool.calls[0]).toContain('then 3 else 2')
  })

  it('⑯ 封版水位容差：02:00 前按 −2、之后 −1（day 管线 CST 00:0x 封前一天）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const pool = fakePool(() => [{ n: 1, maxday: '2026-01-01', age_min: 1, cutoff: '2026-01-10' }])
    await mod.checkSealedManifest(pool as never)
    expect(pool.calls[0]).toContain("time '02:00:00'")
    expect(pool.calls[0]).toContain('then 2 else 1')
  })

  it('⑰ 延迟测的是**drill 真实路径**（月感知视图 + month 谓词）且**热态**（先预热再计时）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const pool = fakePool((sql) => {
      if (sql.includes('pg_views')) return [{ sealed_refs: 10, daily_refs: 0 }]
      if (sql.includes('max(bizday)')) return [{ d: '2026-11-20' }]
      return [{ n: 100 }]
    })
    const r = await mod.checkDetailPath(pool as never)
    expect(r.ok).toBe(true)
    // drill 路径：月感知视图 + month 谓词（不是 bizday）
    const drill = pool.calls.filter((s) => s.includes('vw_lemeng_retail_order_line_month'))
    expect(drill.length).toBeGreaterThanOrEqual(2) // 预热一次 + 计时一次
    expect(drill[0]).toContain("month = '2026-11'")
    // 通用视图仍然被读（灾难线护栏），且用字面量日期（子查询形态会废掉文件裁剪）
    const generic = pool.calls.find((s) => s.includes('bitint') || (s.includes('vw_lemeng_retail_order_line') && s.includes('bizday = date')))
    expect(generic).toContain("date '2026-11-20'")
    expect(generic).not.toContain('select max(')
  })

  it('⑰ drill 计时优先用**已合并月份**（当月走热腿会擦阈值边）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const pool = fakePool((sql) => {
      if (sql.includes('pg_views')) return [{ sealed_refs: 10, daily_refs: 0 }]
      if (sql.includes('lake_month_index')) return [{ ym: '2026-10' }]
      if (sql.includes('max(bizday)')) return [{ d: '2026-11-20' }]
      return [{ n: 100 }]
    })
    await mod.checkDetailPath(pool as never)
    const drill = pool.calls.filter((s) => s.includes('vw_lemeng_retail_order_line_month'))
    expect(drill[0]).toContain("month = '2026-10'") // 已合并月，不是当月 2026-11
  })

  it('⑰ 视图回退到 _DAILY 必须判红（#1872 的慢/崩路径回来了）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const pool = fakePool((sql) =>
      sql.includes('pg_views') ? [{ sealed_refs: 10, daily_refs: 7 }] : [{ d: '2026-11-20' }],
    )
    const r = await mod.checkDetailPath(pool as never)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('_DAILY')
  })

  it('①② 目标 host 必须取自连接串，**不许写死** docker 别名（W4 拆分后的真机教训）', async () => {
    // 真机事实（2026-11-21）：应用单元 DATA_WAREHOUSE_URL = 10.0.0.5:15432，数据单元 = pg_duckdb:5432。
    // 写死 `pg_duckdb` ⇒ 应用单元恒 ENOTFOUND ⇒ 天天误报「Gate-B 掉了」。
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./warehouse-assertions.mjs', import.meta.url), 'utf8')
    expect(src).toContain('new URL(raw)')
    // 不允许出现「裸查字面名」的调用
    expect(src).not.toMatch(/lookup\('pg_duckdb'\)/)
    expect(src).not.toMatch(/connect\(\s*5432\s*,\s*'pg_duckdb'\s*\)/)
  })

  it('⑮ 崩溃判据必须读 OO 日志流（容器内无 docker），且保留 postmaster 原句', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./warehouse-assertions.mjs', import.meta.url), 'utf8')
    expect(src).toContain('openship_platform_core_data_pg_duckdb')
    expect(src).toContain('terminated by signal')
    expect(src).toContain('database system is in recovery mode')
    // 容器内不许再真的调 docker（注释里提历史是允许的，所以判据是「没有 exec/spawn docker」）
    expect(src).not.toMatch(/(execFileSync|spawnSync|execSync)\(\s*['"]docker['"]/)
  })

  it('按凭据边界分组：core 组不含 ⑭⑮，oo 组**只**含 ⑭⑮（不连仓库）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./warehouse-assertions.mjs', import.meta.url), 'utf8')
    // oo 组早退：只跑两条 OO 断言
    expect(src).toMatch(/if \(!wantCore\) \{\s*return \[await checkConfigDrift\(\), await checkPgCrashFree\(\)\]/)
    // core 组不含 OO 两条（要 OO 读凭据，只在应用单元）
    const coreBlock = src.slice(src.indexOf('const pool = await warehouse()'), src.indexOf('if (wantOo)'))
    expect(coreBlock).not.toContain('checkConfigDrift')
    expect(coreBlock).not.toContain('checkPgCrashFree')
  })

  it('⑲ org 非法必须判红（#2638：错误文本被当 org 烧进视图，where org=… 恒 0 行）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    // 形态脏
    const dirty = fakePool(() => [
      { org: 'OCIruntimeexecfailed:execfailed:exec:"psql":executablefilenotfoundin$PATH', n: 19 },
    ])
    const r1 = await mod.checkOrgValid(dirty as never)
    expect(r1.ok).toBe(false)
    expect(r1.detail).toContain('org 非法')
    // 多值（一面一租户被破坏）
    const multi = fakePool(() => [{ org: 'a-org', n: 1 }, { org: 'b-org', n: 1 }])
    expect((await mod.checkOrgValid(multi as never)).ok).toBe(false)
    // 合法单值
    const good = fakePool(() => [{ org: 'shanhaiyiguo-org', n: 100 }])
    expect((await mod.checkOrgValid(good as never)).ok).toBe(true)
  })

  it('⑲ 查不动 ≠ org 脏：争用期判 WARN（不冒充「数据错了」）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    process.env.WIRE_RETRY_DELAY_MS = '0'
    // 所有关系都抛 cancel 类错误 ⇒ 应为 WARN，而不是 ERR
    const pool = {
      calls: [],
      query: async () => { throw new Error('(PGDuckDB) Executor Error: Query cancelled') },
      end: async () => {},
    }
    const r = await mod.checkOrgValid(pool as never)
    expect(r.verdict).toBe('WARN')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('读不动')
    delete process.env.WIRE_RETRY_DELAY_MS
  })

  it('⑲ 真脏仍然判 ERR（WARN 不能把真问题也吃进去）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const dirty = fakePool(() => [{ org: 'OCI runtime exec failed', n: 1 }])
    const r = await mod.checkOrgValid(dirty as never)
    expect(r.verdict ?? 'ERR').toBe('ERR')
  })

  it('⑱ glob 不可解析必须判红（不把「读不到」当「没积压」）', async () => {
    vi.resetModules()
    const mod = await import('./warehouse-assertions.mjs')
    const r = await mod.checkHotPartitions(fakePool(() => [{}]) as never)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('不可解析')
  })
})
