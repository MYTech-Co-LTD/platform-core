// scripts/gen-fct-measures.test.ts — fct 度量列「影子生成器」（P3.0 聚合面组件化 / issue #1012）。
//
// 断言面分三层，缺一层就会漏一类漂移：
//   · ① 形状：生成 SQL 的分组键 / 基面 where / 聚合列逐字钉住（两阶段编译落地到 fct 的形状）；
//   · ② 声明自洽：grain 与键名后缀、domain 缺失、未声明组件、未知 grain 四条**必须抛错**
//        （「不知道」不许默认成全表 / 全 grain —— 错数比报错更糟）；
//   · ③ 逐字节：标记区 == 生成物（`--check` 的判据），含真仓真事实源一条（手改即红）。
//
// ⚠️ 真仓用例读的是 `dbt/semantics/l1_metrics.yml` 与 `dbt/models/lemeng/marts/fct_retail_sale.sql`
//    本体：改声明后忘了重跑生成器，这里红——这正是 CI gates 里那条 `--check` 的本地等价物。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  BEGIN,
  END,
  FCT_MEASURE_COLUMNS,
  FCT_REL,
  GRAIN_KEYS,
  L1_DECLARATIONS_REL,
  driftMessage,
  extractRegion,
  renderFctMeasures,
  renderRegion,
  replaceRegion,
  run,
} from './gen-fct-measures.mjs'
import { measureOf } from './sync-data-semantics.mjs'
import type { Domain, Measure } from './sync-data-semantics.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 行域表（与 `dbt/semantics/l1_metrics.yml` 的 `domains:` 同形；测试不必读 YAML）。 */
const DOMAINS: Record<string, Domain> = {
  finished: { filter: "state = 'FINISHED'" },
  sale_finished: { extends: 'finished', filter: "order_transaction_type = 'SALE_ORDER'" },
  return_finished: { extends: 'finished', filter: "order_transaction_type like '%RETURN%'" },
}

const FIXTURE_MEASURES = new Map<string, Measure>([
  ['sale_amount@order', measureOf({ expr: 'sum(sale_money)', grain: ['order'], additivity: 'flow', domain: 'sale_finished' })],
  ['return_amount@line', measureOf({ expr: 'sum(return_money)', grain: ['line'], additivity: 'flow', domain: 'return_finished' })],
  ['line_amount@line', measureOf({ expr: 'sum(sale_money)', grain: ['line'], additivity: 'flow', domain: 'finished' })],
])

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/**
 * 造一棵最小假仓：一份语义声明 + 一份带标记区的 fct 模型。
 *
 * @param {{ region?: string, sqlPrefix?: string, sqlSuffix?: string }} [opts]
 * @returns {string} 临时仓根
 */
function fixture(opts: { region?: string; sqlPrefix?: string; sqlSuffix?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'gfctm-'))
  roots.push(root)
  mkdirSync(join(root, dirname(L1_DECLARATIONS_REL)), { recursive: true })
  mkdirSync(join(root, dirname(FCT_REL)), { recursive: true })
  writeFileSync(
    join(root, L1_DECLARATIONS_REL),
    [
      'domains:',
      '  finished: "state = \'FINISHED\'"',
      '  sale_finished: { extends: finished, filter: "order_transaction_type = \'SALE_ORDER\'" }',
      '  return_finished: { extends: finished, filter: "order_transaction_type like \'%RETURN%\'" }',
      'measures:',
      '  sale_amount@order: { expr: \'sum(sale_money)\', grain: [order], additivity: flow, domain: sale_finished }',
      '  return_amount@line: { expr: \'sum(return_money)\', grain: [line], additivity: flow, domain: return_finished }',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(root, FCT_REL),
    `${opts.sqlPrefix ?? 'with x as (\n    select 1 as a\n),\n'}${opts.region ?? `${BEGIN}\n手改的旧内容\n${END}`}\n\n${opts.sqlSuffix ?? 'select * from x\n'}`,
  )
  return root
}

describe('renderFctMeasures —— 生成的 SQL 形状', () => {
  it('两个度量各按自己的 grain 键分组，基面 where 由各自的 domain 派生', () => {
    const { ctes } = renderFctMeasures(FIXTURE_MEASURES, FCT_MEASURE_COLUMNS, DOMAINS)
    // 基面：一个 base 不能服务两个行域 ⇒ 两条独立 CTE，where 逐字来自 domain 链
    expect(ctes).toContain('base_sale as (')
    expect(ctes).toContain("where state = 'FINISHED' and order_transaction_type = 'SALE_ORDER'")
    expect(ctes).toContain('base_return as (')
    expect(ctes).toContain("where state = 'FINISHED' and order_transaction_type like '%RETURN%'")
    // 阶段 1：order 键 / line 键分别分组（键集来自 GRAIN_KEYS 唯一映射）
    expect(ctes).toContain(`group by ${GRAIN_KEYS.order.join(', ')}`)
    expect(ctes).toContain(`group by ${GRAIN_KEYS.line.join(', ')}`)
    expect(ctes).toContain('sale_amount__gen as (')
    expect(ctes).toContain('return_amount__gen as (')
    // sale 走 base_sale，return 走 base_return（串了基面 = 行域静默放宽）
    expect(ctes).toMatch(/sale_amount__gen as \([\s\S]*?from base_sale/)
    expect(ctes).toMatch(/return_amount__gen as \([\s\S]*?from base_return/)
  })

  it('聚合列在 fct 粒度上两阶段求和（先逐组求值、再 sum(measure_value)）', () => {
    const { cols } = renderFctMeasures(FIXTURE_MEASURES, FCT_MEASURE_COLUMNS, DOMAINS)
    expect(cols).toBe(
      'sum(sale_amount__gen.measure_value)::numeric(20,2) as sale_amount__gen,\n'
      + '        sum(return_amount__gen.measure_value)::numeric(20,2) as return_amount__gen',
    )
  })

  it('默认列清单只有 sale/return 两个：line_amount@line 属 order_line 视图，不物化进本 fct', () => {
    expect(FCT_MEASURE_COLUMNS).toEqual(['sale_amount@order', 'return_amount@line'])
    const { ctes } = renderFctMeasures(FIXTURE_MEASURES, undefined, DOMAINS)
    expect(ctes).not.toContain('line_amount')
  })

  it('生成物幂等：同样的输入跑两次，结果逐字一致', () => {
    const once = renderFctMeasures(FIXTURE_MEASURES, FCT_MEASURE_COLUMNS, DOMAINS)
    expect(JSON.stringify(renderFctMeasures(FIXTURE_MEASURES, FCT_MEASURE_COLUMNS, DOMAINS))).toBe(JSON.stringify(once))
    expect(renderRegion(once)).toContain(BEGIN)
    expect(renderRegion(once).endsWith(END)).toBe(true)
  })
})

describe('声明自洽 —— 不知道就抛错，不许默认', () => {
  it('measure.grain 与键名后缀不一致 ⇒ 抛错（line 的组件拿不到 order 的键）', () => {
    const bad = new Map<string, Measure>([
      ['line_amount@line', measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow', domain: 'finished' })],
    ])
    expect(() => renderFctMeasures(bad, ['line_amount@line'], DOMAINS)).toThrow(/不一致/)
  })

  it('未知 grain（键名后缀不在 GRAIN_KEYS）⇒ 抛错', () => {
    const bad = new Map<string, Measure>([
      ['x@store', measureOf({ expr: 'sum(a)', grain: ['store'], additivity: 'flow', domain: 'finished' })],
    ])
    expect(() => renderFctMeasures(bad, ['x@store'], DOMAINS)).toThrow(/未知 grain/)
  })

  it('引用了未声明的组件 ⇒ 抛错', () => {
    expect(() => renderFctMeasures(FIXTURE_MEASURES, ['nope@order'], DOMAINS)).toThrow(/未声明的组件/)
  })

  it('组件缺 domain ⇒ 抛错（基面 where 不许默认全表）', () => {
    const bad = new Map<string, Measure>([
      ['sale_amount@order', measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow' })],
    ])
    expect(() => renderFctMeasures(bad, ['sale_amount@order'], DOMAINS)).toThrow(/domain/)
  })

  it('组件 domain 未在 domains: 里声明 ⇒ 抛错（拼错域名不许静默降级）', () => {
    const bad = new Map<string, Measure>([
      ['sale_amount@order', measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow', domain: 'sale_finishedd' })],
    ])
    expect(() => renderFctMeasures(bad, ['sale_amount@order'], DOMAINS)).toThrow(/sale_finishedd/)
  })
})

describe('标记区逐字节比对（--check 的判据）', () => {
  it('手改标记区 ⇒ 报漂移/不一致', () => {
    const once = renderFctMeasures(FIXTURE_MEASURES, FCT_MEASURE_COLUMNS, DOMAINS)
    const tampered = { ...once, cols: once.cols.replace('sum(', 'sum(1 + ') }
    const msg = driftMessage(renderRegion(tampered), renderRegion(once))
    expect(msg).toMatch(/漂移|不一致/)
  })

  it('extractRegion 只取标记区（区外字节不参与比对）', () => {
    const text = `头部\n${BEGIN}\nbody\n${END}\n尾部\n`
    expect(extractRegion(text)).toBe(`${BEGIN}\nbody\n${END}`)
  })

  it('标记区缺失 / 重复 ⇒ 抛错（不猜插入点）', () => {
    expect(() => extractRegion('没有标记区')).toThrow(/标记区/)
    expect(() => extractRegion(`${BEGIN}\n${BEGIN}\n${END}`)).toThrow(/标记区/)
  })

  it('replaceRegion 只换区、区外逐字节不动', () => {
    const text = `pre\n${BEGIN}\nold\n${END}\npost\n`
    const next = replaceRegion(text, `${BEGIN}\nnew\n${END}`)
    expect(next).toBe(`pre\n${BEGIN}\nnew\n${END}\npost\n`)
  })

  it('真仓：标记区 == 生成物（改了声明/手改了区，这条红）', () => {
    expect(run(repoRoot, { check: true })).toBe(0)
  })
})

describe('run —— 写模式与 --check', () => {
  it('--check 判红后，写模式复原成生成物；再 --check 转绿', () => {
    const root = fixture()
    const before = readFileSync(join(root, FCT_REL), 'utf8')
    expect(run(root, { check: true })).toBe(1)
    expect(run(root)).toBe(0)
    const after = readFileSync(join(root, FCT_REL), 'utf8')
    // 区外逐字节不动
    expect(after.startsWith('with x as (\n    select 1 as a\n),\n')).toBe(true)
    expect(after.endsWith('\n\nselect * from x\n')).toBe(true)
    expect(after).not.toBe(before)
    expect(extractRegion(after)).not.toBe(extractRegion(before))
    // 假仓 YAML 解析出的声明与 FIXTURE_MEASURES / DOMAINS 的前两项等价（同一份 expr/domain）
    expect(driftMessage(
      extractRegion(after),
      renderRegion(renderFctMeasures(FIXTURE_MEASURES, FCT_MEASURE_COLUMNS, DOMAINS)),
    )).toBeNull()
    expect(run(root, { check: true })).toBe(0)
  })
})
