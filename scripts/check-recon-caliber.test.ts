// scripts/check-recon-caliber.test.ts — 「业务规则只定义一次」门禁（architecture §4.1 B11）的 fixtures 测试。
//
// **黑盒**：spawn 守卫 CLI（`node check-recon-caliber.mjs <rootDir>`）、断言退出码与输出
// （与 check-diagnostic-tool.test.ts / check-data-plane-lock.test.ts 同形）。
//
// 为什么这条守卫必须有**能红**的证明：「守卫不红等于没有守卫」，而它最容易失效的地方正是
// **它声称盯住的那条耦合**——真的在对账链路里搜口径原子吗？还是搜了个空集合？
// ⇒ 每条判据都配一个**只违反它一条**的反例夹具，证明红是那条判据打出来的。
//
// ⚠️ 夹具里的 SQL 直接写**规范化后的形态**（裸列名，不写 `r['x']` / `CAST(...)`）——规范化会把
//    这两种写法都折成裸列名。判别式字面量一律**从守卫导出**（`SALE_GIFT_SQL` / …），不手抄。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CONSUMER_SCRIPT,
  CONSUMER_MUST_CITE,
  DBT_COPIES,
  HALVING_SQL,
  RET_GIFT_SQL,
  RET_SUM_SQL,
  SALE_GIFT_SQL,
  SCRIPT_SQL_VAR,
  TOLERANCES_PATH,
} from './check-recon-caliber.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(repoRoot, 'scripts/check-recon-caliber.mjs')
const PIPELINE = 'deploy/duckle/console/pipelines/lemeng.recon.preagg.item.json'

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

type CopyKey = 'mart' | 'auditNet' | 'auditSales'

interface Over {
  /** 去掉该 dbt 副本的销售侧赠品判别式。 */
  dropSaleGift?: CopyKey
  /** 去掉该 dbt 副本的退货侧赠品判别式。 */
  dropRetGift?: CopyKey
  /** 往对账脚本的平台侧 SQL 里注入一段口径原子（模拟「又自立了一份」）。 */
  scriptAtom?: string
  /** 脚本 SQL 不引用构件（判据 ③ 的反例）。 */
  scriptNoCite?: boolean
  /** 往管线某个 code.sql 节点里注入口径原子。 */
  pipelineAtom?: string
  /** 脚本的 `NET_ABS_TOL` 默认值（判据 ④ 的反例）。 */
  netAbsTol?: string
  /** seed 里 `caliber_net` 的 `abs_tol`。 */
  seedNetAbs?: string
  /** 删掉脚本。 */
  removeScript?: boolean
}

/** dbt 副本夹具。 */
function dbtFixture(copyKey: CopyKey, over: Over): string {
  const copy = DBT_COPIES.find((c) => c.key === copyKey)
  if (copy === undefined) throw new Error(`unknown copy ${copyKey}`)
  const parts = ['-- fixture', 'select 1 as x']
  if (over.dropSaleGift !== copyKey) parts.push(SALE_GIFT_SQL)
  if (copy.retGift && over.dropRetGift !== copyKey) parts.push(RET_GIFT_SQL)
  return `${parts.join('\n')}\n`
}

/** 对账脚本夹具：消费者形态（读构件）+ 三个容差 env。 */
function scriptFixture(over: Over): string {
  const table = over.scriptNoCite === true ? 'staging.some_other_table' : `staging.${CONSUMER_MUST_CITE}`
  const atom = over.scriptAtom === undefined ? '' : `\n       AND ${over.scriptAtom}`
  const sql = `SELECT branch_num, sale_amount, return_amount FROM ${table} WHERE bizday = '2026-10-17'${atom} ORDER BY 1`
  return [
    '#!/bin/sh',
    `NET_ABS_TOL=\${NET_ABS_TOL:-${over.netAbsTol ?? '200.00'}}`,
    'PREAGG_ABS_TOL=${PREAGG_ABS_TOL:-1.00}',
    'PREAGG_MAX_PCT=${PREAGG_MAX_PCT:-0.01}',
    `${SCRIPT_SQL_VAR}="${sql}"`,
    '',
  ].join('\n')
}

/** 管线夹具：一个 code.sql（源侧落湖行）+ 一个 src.rest。 */
function pipelineFixture(over: Over): string {
  const baseSql =
    "SELECT 'x' AS batch_id, CAST(j.value AS BIGINT) AS branch_num, CAST(p.source_sale AS DECIMAL(20, 2)) AS source_sale\n" +
    "FROM json_each('[]') j LEFT JOIN \"pnormal\" p ON CAST(p.branch_num AS BIGINT) = CAST(j.value AS BIGINT)"
  const nodes = [
    { id: 'pre', data: { componentId: 'src.rest', properties: { url: 'https://example.test', body: '{}' } } },
    { id: 'pnormal', data: { componentId: 'code.sql', properties: { sql: 'SELECT 1 AS branch_num' } } },
    { id: 'srcprep', data: { componentId: 'code.sql', properties: { rawSql: true, sql: baseSql } } },
    { id: 'lakeout', data: { componentId: 'snk.minio', properties: { key: 'lemeng/recon_source/x/all.parquet' } } },
  ]
  if (over.pipelineAtom !== undefined) {
    const extra = `SELECT 1 AS branch_num WHERE ${over.pipelineAtom}`
    nodes.push({ id: 'leak', data: { componentId: 'code.sql', properties: { sql: extra } } })
  }
  return JSON.stringify({ name: 'lemeng.recon.preagg.item', nodes, edges: [] })
}

/** seed 夹具。 */
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
  const files = []
  for (const c of DBT_COPIES) files.push([c.path, dbtFixture((c.key as CopyKey), over)])
  files.push([CONSUMER_SCRIPT, scriptFixture(over)])
  files.push([PIPELINE, pipelineFixture(over)])
  files.push([TOLERANCES_PATH, seedFixture(over)])
  for (const [rel, content] of files) {
    if (over.removeScript === true && rel === CONSUMER_SCRIPT) continue
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

describe('check-recon-caliber：业务规则只定义一次（B11）', () => {
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

  it('脚本不在场 ⇒ 红（不是静默通过）', () => {
    const r = guard(fixture({ removeScript: true }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(CONSUMER_SCRIPT)
  })

  // ── 判据 ①②：dbt 副本里该带的判别式必须逐字在场 ─────────────────────────────
  for (const c of DBT_COPIES) {
    it(`判据①：${c.key} 缺销售侧赠品判别式 ⇒ 红`, () => {
      const r = guard(fixture({ dropSaleGift: (c.key as CopyKey) }))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(c.path)
      expect(r.stderr).toContain('销售侧赠品判别式')
    })
  }

  for (const c of DBT_COPIES.filter((x) => x.retGift)) {
    it(`判据①：${c.key} 缺退货侧赠品判别式 ⇒ 红（#917 的形态）`, () => {
      const r = guard(fixture({ dropRetGift: (c.key as CopyKey) }))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(c.path)
      expect(r.stderr).toContain('退货侧赠品判别式')
    })
  }

  it('判据①的作用面：销售侧复算**不带**退货侧 ⇒ 不得因它没有而红', () => {
    const r = guard(fixture())
    expect(r.status).toBe(0)
  })

  // ── 判据 ②：对账链路出现口径原子 ⇒ 红（本次改造的核心断言）──────────────────
  it('判据②：对账脚本里出现赠品判别式 ⇒ 红（对账又自立了一份口径）', () => {
    const r = guard(fixture({ scriptAtom: SALE_GIFT_SQL }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(CONSUMER_SCRIPT)
    expect(r.stderr).toContain('销售侧赠品判别式')
  })

  it('判据②：对账脚本里出现退货侧判别式 ⇒ 红', () => {
    const r = guard(fixture({ scriptAtom: RET_GIFT_SQL }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('退货侧赠品判别式')
  })

  it('判据②：对账脚本里出现折半形态 ⇒ 红', () => {
    const r = guard(fixture({ scriptAtom: HALVING_SQL }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('折半形态')
  })

  it('判据②：对账管线 code.sql 里出现口径原子 ⇒ 红（#917 的形态）', () => {
    const r = guard(fixture({ pipelineAtom: RET_SUM_SQL }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(PIPELINE)
    expect(r.stderr).toContain('退货侧全额冲减形态')
  })

  it('判据②：`_note` 里复述口径**不算违规**（只扫代码，不扫散文）', () => {
    const root = fixture()
    const abs = join(root, PIPELINE)
    const doc = JSON.parse(readFileSync(abs, 'utf8'))
    doc._note = [`口径常识：${SALE_GIFT_SQL}`, `折半 ${HALVING_SQL}`]
    writeFileSync(abs, JSON.stringify(doc))
    const r = guard(root)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  // ── 判据 ③：消费者必须指向构件 ───────────────────────────────────────────────
  it('判据③：脚本不引用构件 ⇒ 红（读别的表 = 又自立了一份口径）', () => {
    const r = guard(fixture({ scriptNoCite: true }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(CONSUMER_MUST_CITE)
  })

  // ── 判据 ④：容差地板同源 ────────────────────────────────────────────────────
  it('判据④：脚本 NET_ABS_TOL 与 seed 不同源 ⇒ 红（#813 的实证形态）', () => {
    const r = guard(fixture({ netAbsTol: '50.00' }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('NET_ABS_TOL')
    expect(r.stderr).toContain('不同源')
  })

  it('判据④：seed 侧被改（脚本没跟）⇒ 同样红', () => {
    const r = guard(fixture({ seedNetAbs: '50.00' }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('不同源')
  })
})
