// scripts/check-recon-caliber.test.ts — 口径四副本同源门禁（#831）的 fixtures 测试。
//
// **黑盒**：spawn 守卫 CLI（`node check-recon-caliber.mjs <rootDir>`）、断言退出码与输出
// （与 check-diagnostic-tool.test.ts / check-data-plane-lock.test.ts 同形）。
//
// 为什么这条守卫必须有**能红**的证明：「守卫不红等于没有守卫」，而它最容易失效的地方正是
// **它声称盯住的那条耦合**——真的比了四份副本吗？还是四份都没抽到、比了个空集合？
// ⇒ 每条判据都配一个**只违反它一条**的反例夹具，证明红是那条判据打出来的。
//
// ⚠️ 夹具里的 SQL 直接写**规范化后的形态**（裸列名，不写 `r['x']` / `CAST(...)`）——规范化会把
//    这两种写法都折成裸列名，故夹具用裸列名既最短又**不引入方言副本**（方言副本本身就是漂移源）。
//    判别式字面量一律**从守卫导出**（`SALE_GIFT_SQL` / `RET_GIFT_SQL` / …），不手抄一份。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CALIBER_PATHS,
  HALVING_SQL,
  PIPELINE_SQL_NODE,
  RET_GIFT_SQL,
  RET_SUM_SQL,
  SALE_GIFT_SQL,
  TOLERANCES_PATH,
} from './check-recon-caliber.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(repoRoot, 'scripts/check-recon-caliber.mjs')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

const tmpRoots: string[] = []
afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
})

/** 跑守卫；`rootDir` 由 argv 传入（守卫默认仓根，测试一律传夹具）。 */
function guard(rootDir: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, rootDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** 哪一份副本 —— 用于「只弄坏这一份」的参数化。 */
type Copy = 'mart' | 'auditNet' | 'auditSales' | 'script' | 'pipeline'

/** 有**退货侧**的副本（判据 ② 的作用面）；销售侧复算不在其中。 */
const WITH_RETURN_SIDE: readonly Copy[] = ['mart', 'auditNet', 'script', 'pipeline']

interface Over {
  /** 去掉该副本的**销售侧**赠品判别式。 */
  dropSaleGift?: Copy
  /** 去掉该副本的**退货侧**赠品判别式。 */
  dropRetGift?: Copy
  /** 去掉该副本的**折半形态**（只在 script / pipeline 有意义）。 */
  dropHalving?: 'script' | 'pipeline'
  /** 给该副本的 `ret_side` 套上折半（判据 ④ 的反例）。 */
  halveReturn?: 'script' | 'pipeline'
  /** 删掉该副本的 `ret_side` CTE（判据 ④ 抽不到块）。 */
  dropRetSide?: 'script' | 'pipeline'
  /** 脚本的 `NET_ABS_TOL` 默认值（判据 ⑤ 的反例）。 */
  netAbsTol?: string
  /** seed 里 `caliber_net` 的 `abs_tol`（判据 ⑤ 的另一半）。 */
  seedNetAbs?: string
  /** 把某份工件整个删掉。 */
  remove?: Copy
  /** 管线 JSON 里不写 lagg 节点。 */
  pipelineWithoutLagg?: boolean
}

const giftPredicate = (copy: Copy, dropSaleGift: Copy | undefined, dropRetGift: Copy | undefined): string => {
  const parts: string[] = []
  if (dropSaleGift !== copy) parts.push(SALE_GIFT_SQL)
  // 销售侧复算**没有**退货侧 —— 给它补一条只会掩盖「判据 ② 的作用面」写错（那是真回归）
  if (dropRetGift !== copy && copy !== 'auditSales') parts.push(RET_GIFT_SQL)
  return parts.join('\n')
}

/** 构件 / 复算夹具（SQL 文件）：只放该副本该带的判别式即可（判据 ①② 比的是它们）。 */
function sqlFixture(copy: Copy, over: Over): string {
  return [
    `-- ${copy} fixture`,
    'select 1 as x',
    giftPredicate(copy, over.dropSaleGift, over.dropRetGift),
    '',
  ].join('\n')
}

/** 脚本夹具：GIFT / GIFT_RET 两个 shell 变量 + SQL_LAKE 引用它们（**故意走展开路径**）。 */
function scriptFixture(over: Over): string {
  const gift = over.dropSaleGift === 'script' ? '' : SALE_GIFT_SQL
  const giftRet = over.dropRetGift === 'script' ? '' : RET_GIFT_SQL
  const halving = over.dropHalving === 'script' ? 'sum(ng + tot - sd)' : HALVING_SQL
  const retTerm = over.halveReturn === 'script' ? `(${RET_SUM_SQL}) / 2` : RET_SUM_SQL
  const retSide =
    over.dropRetSide === 'script'
      ? 'sale_side AS (SELECT b, round(sum(ng), 2) AS sale_net FROM per_order GROUP BY b)'
      : `ret_side AS (SELECT b, round(sum(CASE WHEN \${GIFT_RET} THEN 0 ELSE ${retTerm} END), 2) AS ret FROM src WHERE order_transaction_type like '%RETURN%' AND state='FINISHED' GROUP BY 1)`
  return [
    '#!/bin/sh',
    'NET_ABS_TOL=${NET_ABS_TOL:-' + (over.netAbsTol ?? '200.00') + '}',
    'PREAGG_ABS_TOL=${PREAGG_ABS_TOL:-1.00}',
    'PREAGG_MAX_PCT=${PREAGG_MAX_PCT:-0.01}',
    `GIFT="state='FINISHED' AND ${gift}"`,
    `GIFT_RET="${giftRet}"`,
    `SQL_LAKE="WITH per_order AS (SELECT b, sum(CASE WHEN \${GIFT} THEN 0 ELSE sale_money END) AS ng, max(order_total_money) AS tot, sum(order_detail_share_discount) AS sd FROM src GROUP BY 1), sale_side AS (SELECT b, round(${halving}, 2) AS sale_net FROM per_order GROUP BY b), ${retSide} SELECT 1"`,
    '',
  ].join('\n')
}

/** 管线夹具：`lagg` 节点的 sql 与脚本同形（口径四副本之一）。 */
function pipelineFixture(over: Over): string {
  const gift = over.dropSaleGift === 'pipeline' ? '' : SALE_GIFT_SQL
  const giftRet = over.dropRetGift === 'pipeline' ? '' : RET_GIFT_SQL
  const halving = over.dropHalving === 'pipeline' ? 'sum(ng + tot - sd)' : HALVING_SQL
  const retTerm = over.halveReturn === 'pipeline' ? `(${RET_SUM_SQL}) / 2` : RET_SUM_SQL
  const retSide =
    over.dropRetSide === 'pipeline'
      ? 'sale_side AS (SELECT b, round(sum(ng), 2) AS sale_net FROM per_order GROUP BY b)'
      : `ret_side AS (SELECT b, round(sum(CASE WHEN ${giftRet} THEN 0 ELSE ${retTerm} END), 2) AS ret FROM "lguard" WHERE order_transaction_type like '%RETURN%' AND state='FINISHED' GROUP BY 1)`
  const sql =
    `WITH per_order AS (SELECT b, sum(CASE WHEN ${gift} THEN 0 ELSE sale_money END) AS ng, ` +
    `max(order_total_money) AS tot, sum(order_detail_share_discount) AS sd FROM "lguard" GROUP BY 1), ` +
    `sale_side AS (SELECT b, round(${halving}, 2) AS sale_net FROM per_order GROUP BY b), ${retSide} SELECT 1`
  const nodes = over.pipelineWithoutLagg ? [{ id: 'other', data: { properties: { sql } } }] : [{ id: PIPELINE_SQL_NODE, data: { properties: { sql } } }]
  return JSON.stringify({ name: 'fixture', nodes, edges: [] })
}

/** seed 夹具：与脚本 env 默认值同源（`netAbs` 可覆盖成不同源）。 */
function seedFixture(over: Over): string {
  return [
    'control,abs_tol,pct_tol,reason_code,expires_on,disposition,disposition_by',
    'caliber_sale,1.00,0.01,,,,',
    `caliber_net,${over.seedNetAbs ?? '200.00'},0.01,late_return_restatement,2026-12-31,过渡,data-platform`,
    '',
  ].join('\n')
}

/** 建夹具根目录。 */
function fixture(over: Over = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-caliber-'))
  tmpRoots.push(root)
  /** @type {Array<[string, string]>} */
  const files: Array<[string, string]> = [
    [CALIBER_PATHS.mart, sqlFixture('mart', over)],
    [CALIBER_PATHS.auditNet, sqlFixture('auditNet', over)],
    [CALIBER_PATHS.auditSales, sqlFixture('auditSales', over)],
    [CALIBER_PATHS.script, scriptFixture(over)],
    [CALIBER_PATHS.pipeline, pipelineFixture(over)],
    [TOLERANCES_PATH, seedFixture(over)],
  ]
  for (const [rel, content] of files) {
    if (over.remove !== undefined && CALIBER_PATHS[over.remove] === rel) continue
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

describe('check-recon-caliber：口径四副本同源门禁', () => {
  it('一致 ⇒ exit 0', () => {
    const r = guard(fixture())
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('check-recon-caliber: OK')
  })

  it('真仓必须干净（机制落码了、仓里却是坏的 = 最坏的一种绿）', () => {
    const r = guard(repoRoot)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('副本整个不在场 ⇒ 红（不是静默通过）', () => {
    const r = guard(fixture({ remove: 'pipeline' }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(CALIBER_PATHS.pipeline)
  })

  // ── 判据 ②：本门禁存在的**直接原因**（#917 缺的就是它）──────────────────────
  for (const copy of WITH_RETURN_SIDE) {
    it(`判据②：${copy} 缺**退货侧**赠品判别式 ⇒ 红（#917 的形态）`, () => {
      const r = guard(fixture({ dropRetGift: copy }))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(CALIBER_PATHS[copy])
      expect(r.stderr).toContain('退货侧赠品判别式')
    })
  }

  it('判据②的作用面：销售侧复算**不带**退货侧 ⇒ 不得因它没有而红（写宽了就是假红）', () => {
    const r = guard(fixture())
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  for (const copy of ['mart', 'auditNet', 'auditSales', 'script', 'pipeline'] as const) {
    it(`判据①：${copy} 缺**销售侧**赠品判别式 ⇒ 红`, () => {
      const r = guard(fixture({ dropSaleGift: copy }))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(CALIBER_PATHS[copy])
      expect(r.stderr).toContain('销售侧赠品判别式')
    })
  }

  it('判据①③：脚本把判别式抽成 ${GIFT} 变量时**必须展开**再比（不展开会误报缺销售侧判别式）', () => {
    // 一致夹具里 SQL_LAKE 写的就是 ${GIFT} / ${GIFT_RET} —— 能绿即证明展开生效。
    const r = guard(fixture())
    expect(r.status).toBe(0)
  })

  for (const copy of ['script', 'pipeline'] as const) {
    it(`判据③：${copy} 的折半形态被改（先和后除）⇒ 红`, () => {
      const r = guard(fixture({ dropHalving: copy }))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(CALIBER_PATHS[copy])
      expect(r.stderr).toContain('折半形态')
    })
  }

  for (const copy of ['script', 'pipeline'] as const) {
    it(`判据④：${copy} 的退货侧套了折半 ⇒ 红`, () => {
      const r = guard(fixture({ halveReturn: copy }))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(CALIBER_PATHS[copy])
      expect(r.stderr).toContain('套了折半')
    })
  }

  for (const copy of ['script', 'pipeline'] as const) {
    it(`判据④：${copy} 抽不到 ret_side ⇒ 红（结构变了，门禁无从判）`, () => {
      const r = guard(fixture({ dropRetSide: copy }))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('抽不到 `ret_side AS ( … )`')
    })
  }

  it('判据④：**湖扫描路径里的 `/` 不得误判成折半**（裸 includes 会恒红）', () => {
    // 一致夹具的 SQL 里没有 s3 路径；这里补一条：把 ret_side 的 FROM 换成带路径的 read_parquet，
    // 规范化后应折成 `from src`，路径的 `/` 随之消失 ⇒ 仍绿。
    const root = fixture()
    const p = join(root, CALIBER_PATHS.script)
    const s = readFileSync(p, 'utf8').replaceAll('FROM src', "FROM read_parquet('s3://b/x/system_book=1/bizday=2026-10-17/**/*.parquet') r")
    writeFileSync(p, s)
    const r = guard(root)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('判据⑤：脚本 NET_ABS_TOL 与 seed 不同源 ⇒ 红（#813 的实证形态）', () => {
    const r = guard(fixture({ netAbsTol: '50.00' }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('NET_ABS_TOL')
    expect(r.stderr).toContain('不同源')
  })

  it('判据⑤：seed 侧被改（脚本没跟）⇒ 同样红', () => {
    const r = guard(fixture({ seedNetAbs: '50.00' }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('不同源')
  })

  it('管线 JSON 里没有 lagg 节点 ⇒ 红（节点改名/搬走要同步门禁）', () => {
    const r = guard(fixture({ pipelineWithoutLagg: true }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(PIPELINE_SQL_NODE)
  })
})
