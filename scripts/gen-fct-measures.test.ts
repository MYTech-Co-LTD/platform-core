// scripts/gen-fct-measures.test.ts — fct 度量列生成区生成器（P3.0 聚合面组件化 / issue #1012）。
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
  L1_DECLARATIONS_REL,
  MODELS,
  driftMessage,
  extractRegion,
  readSemantics,
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
  // MODELS 注册表驱动 run() ⇒ 每个注册模型都要有文件、每个物化组件都要有声明：
  // P3.3 Task 2（#1031）起注册表不止一项，夹具跟着注册表走（少一份 = 第二个模型抛「未声明的组件」）。
  for (const spec of MODELS) mkdirSync(join(root, dirname(spec.rel)), { recursive: true })
  writeFileSync(
    join(root, L1_DECLARATIONS_REL),
    [
      'domains:',
      '  finished: "state = \'FINISHED\'"',
      '  sale_finished: { extends: finished, filter: "order_transaction_type = \'SALE_ORDER\'" }',
      '  return_finished: { extends: finished, filter: "order_transaction_type like \'%RETURN%\'" }',
      '  expense_payable: "direction = \'应付\'"',
      '  expense_receivable: "direction = \'应收\'"',
      '  client_expense_payable: "other_inout_flag = false"',
      '  client_expense_receivable: "other_inout_flag = true"',
      '  transfer_line_quality_base: "state_code = 3 and out_branch_num = 99 and branch_num <> out_branch_num"',
      'measures:',
      '  sale_amount@order: { expr: \'sum(sale_money)\', grain: [order], additivity: flow, domain: sale_finished }',
      '  return_amount@line: { expr: \'sum(return_money)\', grain: [line], additivity: flow, domain: return_finished }',
      '  ep_payable@flat: { expr: \'sum(coalesce(amount, 0))\', grain: [flat], additivity: flow, domain: expense_payable }',
      '  er_receivable@flat: { expr: \'sum(coalesce(amount, 0))\', grain: [flat], additivity: flow, domain: expense_receivable }',
      '  client_ep_payable@flat: { expr: \'sum(coalesce(other_inout_money, 0))\', grain: [flat], additivity: flow, domain: client_expense_payable }',
      '  client_er_receivable@flat: { expr: \'sum(coalesce(other_inout_money, 0))\', grain: [flat], additivity: flow, domain: client_expense_receivable }',
      '  tq_zero_cost_amount@order: { expr: \'sum(case when coalesce(out_money, 0) <> 0 and subtotal = 0 then out_money else 0 end)\', grain: [order], additivity: flow, domain: transfer_line_quality_base }',
      '',
    ].join('\n'),
  )
  for (const spec of MODELS) {
    writeFileSync(
      join(root, spec.rel),
      `${opts.sqlPrefix ?? 'with x as (\n    select 1 as a\n),\n'}${opts.region ?? `${BEGIN}\n手改的旧内容\n${END}`}\n\n${opts.sqlSuffix ?? 'select * from x\n'}`,
    )
  }
  return root
}

/** 在 retail_sale 的 spec 上换一列物化清单（声明自洽用例的最短构造）。 */
function specWith(columns: string[]) {
  return { ...MODELS[0], columns }
}

describe('renderFctMeasures —— 生成的 SQL 形状', () => {
  it('两个度量各按自己的 grain 键分组，基面 where 由各自的 domain 派生', () => {
    const { ctes } = renderFctMeasures(FIXTURE_MEASURES, MODELS[0], DOMAINS)
    // 基面：一个 base 不能服务两个行域 ⇒ 两条独立 CTE，where 逐字来自 domain 链
    expect(ctes).toContain('base_sale as (')
    expect(ctes).toContain("where state = 'FINISHED' and order_transaction_type = 'SALE_ORDER'")
    expect(ctes).toContain('base_return as (')
    expect(ctes).toContain("where state = 'FINISHED' and order_transaction_type like '%RETURN%'")
    // 阶段 1：order 键 / line 键分别分组（键集来自 spec.grainKeys 唯一映射）
    expect(ctes).toContain(`group by ${MODELS[0].grainKeys.order.join(', ')}`)
    expect(ctes).toContain(`group by ${MODELS[0].grainKeys.line.join(', ')}`)
    expect(ctes).toContain('sale_amount__gen as (')
    expect(ctes).toContain('return_amount__gen as (')
    // sale 走 base_sale，return 走 base_return（串了基面 = 行域静默放宽）
    expect(ctes).toMatch(/sale_amount__gen as \([\s\S]*?from base_sale/)
    expect(ctes).toMatch(/return_amount__gen as \([\s\S]*?from base_return/)
  })

  it('聚合列在 fct 粒度上两阶段求和（先逐组求值、再 sum(measure_value)）', () => {
    const { cols } = renderFctMeasures(FIXTURE_MEASURES, MODELS[0], DOMAINS)
    expect(cols).toEqual([
      'sum(sale_amount__gen.measure_value)::numeric(20,2) as sale_amount__gen',
      'sum(return_amount__gen.measure_value)::numeric(20,2) as return_amount__gen',
    ])
  })

  it('gen_agg 先按 fct 粒度上卷再 join（细粒度直接 join = 笛卡尔放大，fix round 1）', () => {
    const region = renderRegion(renderFctMeasures(FIXTURE_MEASURES, MODELS[0], DOMAINS))
    // 每侧都有一条**自己的**上卷 CTE（group by fct 粒度）
    for (const name of ['sale_amount', 'return_amount']) {
      expect(region).toContain(
        `${name}__rollup as (\n`
        + `    select ${MODELS[0].fctGrain.join(', ')}, sum(${name}__gen.measure_value)::numeric(20,2) as ${name}__gen\n`
        + `    from ${name}__gen\n`
        + `    group by 1, 2, 3\n)`,
      )
    }
    // gen_agg 的 join 输入必须是上卷后的 CTE，绝不是阶段 1 的细粒度 CTE
    const genAgg = region.slice(region.indexOf('gen_agg as ('), region.indexOf(END))
    expect(genAgg).toContain('from sale_amount__rollup\n    full join return_amount__rollup')
    expect(genAgg).not.toMatch(/from (sale_amount|return_amount)__gen\b/)
    expect(genAgg).not.toContain('group by')
  })

  it('物化清单只有 sale/return 两个：line_amount@line 属 order_line 视图，不物化进本 fct', () => {
    expect(MODELS[0].columns).toEqual(['sale_amount@order', 'return_amount@line'])
    const { ctes } = renderFctMeasures(FIXTURE_MEASURES, MODELS[0], DOMAINS)
    expect(ctes).not.toContain('line_amount')
  })

  it('生成物幂等：同样的输入跑两次，结果逐字一致', () => {
    const once = renderFctMeasures(FIXTURE_MEASURES, MODELS[0], DOMAINS)
    expect(JSON.stringify(renderFctMeasures(FIXTURE_MEASURES, MODELS[0], DOMAINS))).toBe(JSON.stringify(once))
    expect(renderRegion(once)).toContain(BEGIN)
    expect(renderRegion(once).endsWith(END)).toBe(true)
  })
})

describe('声明自洽 —— 不知道就抛错，不许默认', () => {
  it('measure.grain 与键名后缀不一致 ⇒ 抛错（line 的组件拿不到 order 的键）', () => {
    const bad = new Map<string, Measure>([
      ['line_amount@line', measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow', domain: 'finished' })],
    ])
    expect(() => renderFctMeasures(bad, specWith(['line_amount@line']), DOMAINS)).toThrow(/不一致/)
  })

  it('未知 grain（键名后缀不在 spec.grainKeys）⇒ 抛错', () => {
    const bad = new Map<string, Measure>([
      ['x@store', measureOf({ expr: 'sum(a)', grain: ['store'], additivity: 'flow', domain: 'finished' })],
    ])
    expect(() => renderFctMeasures(bad, specWith(['x@store']), DOMAINS)).toThrow(/未知 grain/)
  })

  it('引用了未声明的组件 ⇒ 抛错', () => {
    expect(() => renderFctMeasures(FIXTURE_MEASURES, specWith(['nope@order']), DOMAINS)).toThrow(/未声明的组件/)
  })

  it('组件缺 domain ⇒ 抛错（基面 where 不许默认全表）', () => {
    const bad = new Map<string, Measure>([
      ['sale_amount@order', measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow' })],
    ])
    expect(() => renderFctMeasures(bad, specWith(['sale_amount@order']), DOMAINS)).toThrow(/domain/)
  })

  it('组件 domain 未在 domains: 里声明 ⇒ 抛错（拼错域名不许静默降级）', () => {
    const bad = new Map<string, Measure>([
      ['sale_amount@order', measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow', domain: 'sale_finishedd' })],
    ])
    expect(() => renderFctMeasures(bad, specWith(['sale_amount@order']), DOMAINS)).toThrow(/sale_finishedd/)
  })

  it('x@flat 却声明 grain:[order] ⇒ 抛错（flat 不豁免后缀一致性校验）', () => {
    const bad = new Map<string, Measure>([
      ['x@flat', measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow', domain: 'finished' })],
    ])
    expect(() => renderFctMeasures(bad, specWith(['x@flat']), DOMAINS)).toThrow(/不一致/)
  })
})

describe('标记区逐字节比对（--check 的判据）', () => {
  it('手改标记区 ⇒ 报漂移/不一致', () => {
    const once = renderFctMeasures(FIXTURE_MEASURES, MODELS[0], DOMAINS)
    // 篡改面跟着结构走：阶段 2 表达式住在 comps[].col（renderRegion 读的是它）
    const tampered = {
      ...once,
      comps: [
        { ...once.comps[0], col: once.comps[0].col?.replace('sum(', 'sum(1 + ') ?? null },
        ...once.comps.slice(1),
      ],
    }
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
    const before = readFileSync(join(root, MODELS[0].rel), 'utf8')
    expect(run(root, { check: true })).toBe(1)
    expect(run(root)).toBe(0)
    const after = readFileSync(join(root, MODELS[0].rel), 'utf8')
    // 区外逐字节不动
    expect(after.startsWith('with x as (\n    select 1 as a\n),\n')).toBe(true)
    expect(after.endsWith('\n\nselect * from x\n')).toBe(true)
    expect(after).not.toBe(before)
    expect(extractRegion(after)).not.toBe(extractRegion(before))
    // 假仓 YAML 解析出的声明与 FIXTURE_MEASURES / DOMAINS 的前两项等价（同一份 expr/domain）
    expect(driftMessage(
      extractRegion(after),
      renderRegion(renderFctMeasures(FIXTURE_MEASURES, MODELS[0], DOMAINS)),
    )).toBeNull()
    expect(run(root, { check: true })).toBe(0)
  })
})

describe('P3.3 多模型注册表 / flat 粒度 / precision（#1031）', () => {
  /** 简报用例的最小 flat spec（与 `MODELS` 的项同形）。 */
  const FLAT_SPEC = {
    rel: 'x.sql',
    stagingRef: "{{ ref('stg_x') }}",
    grainKeys: {},
    fctGrain: ['system_book', 'bizday'],
    columns: ['ep_payable@flat'],
    baseAliases: { 'ep_payable@flat': 'base_payable' },
  }
  const FLAT_MEASURES = new Map<string, Measure>([
    ['ep_payable@flat', measureOf({ expr: 'sum(coalesce(amount, 0))', domain: 'be_payable', grain: ['flat'], additivity: 'flow' })],
  ])
  const PAYABLE_DOMAINS: Record<string, Domain> = { be_payable: { filter: "direction = '应付'" } }

  it('① flat 粒度：单层直聚，无预分组 CTE', () => {
    const r = renderFctMeasures(FLAT_MEASURES, FLAT_SPEC, PAYABLE_DOMAINS)
    // 阶段 1 直接在 fct 粒度求和（无 group by order 键的中间层）
    expect(r.ctes).toContain('select system_book, bizday, sum(coalesce(amount, 0))::numeric(20,2) as ep_payable__gen')
    expect(r.names).toEqual(['ep_payable__gen'])
  })

  it('② precision 覆盖：声明 "20,3" ⇒ cast 逐字变', () => {
    const measures = new Map<string, Measure>([
      ['ep_payable@flat', measureOf({ expr: 'sum(coalesce(amount, 0))', domain: 'be_payable', grain: ['flat'], additivity: 'flow', precision: '20,3' })],
    ])
    const r = renderFctMeasures(measures, FLAT_SPEC, PAYABLE_DOMAINS)
    expect(r.ctes).toContain('sum(coalesce(amount, 0))::numeric(20,3) as ep_payable__gen')
    expect(r.ctes).not.toContain('numeric(20,2)')
    // 分组组件同理：阶段 2 上卷的 cast 也走 precision（Task 2-5 的分组族会用到）
    const specX = { ...MODELS[0], columns: ['x@order'], baseAliases: { ...MODELS[0].baseAliases, 'x@order': 'base_x' } }
    const r2 = renderFctMeasures(
      new Map([['x@order', measureOf({ expr: 'sum(v)', grain: ['order'], additivity: 'flow', domain: 'finished', precision: '20,3' })]]),
      specX,
      DOMAINS,
    )
    expect(r2.cols).toEqual(['sum(x__gen.measure_value)::numeric(20,3) as x__gen'])
  })

  it('③ retail_sale 回归：MODELS[0] 渲染结果与现有标记区逐字节一致', () => {
    const { measures, domains } = readSemantics(repoRoot)
    const expected = renderRegion(renderFctMeasures(measures, MODELS[0], domains))
    expect(expected).toBe(
      readFileSync(join(repoRoot, MODELS[0].rel), 'utf8').match(/-- BEGIN GENERATED MEASURES[\s\S]*-- END GENERATED MEASURES/)![0],
    )
  })

  it('④ flat + 多组件 gen_agg：flat 组件不产 rollup，gen_agg 直接引阶段 1', () => {
    const spec = {
      rel: 'x.sql',
      stagingRef: "{{ ref('stg_x') }}",
      grainKeys: { order: ['system_book', 'bizday'] },
      fctGrain: ['system_book', 'bizday'],
      columns: ['ep_payable@flat', 'x@order'],
      baseAliases: { 'ep_payable@flat': 'base_payable', 'x@order': 'base_x' },
    }
    const measures = new Map<string, Measure>([
      ['ep_payable@flat', measureOf({ expr: 'sum(coalesce(amount, 0))', domain: 'be_payable', grain: ['flat'], additivity: 'flow' })],
      ['x@order', measureOf({ expr: 'sum(v)', grain: ['order'], additivity: 'flow', domain: 'finished' })],
    ])
    const region = renderRegion(renderFctMeasures(measures, spec, { ...DOMAINS, ...PAYABLE_DOMAINS }))
    // flat 组件没有自己的 rollup CTE；分组组件有一条
    expect(region).toContain('x__rollup as (')
    expect(region).not.toContain('ep_payable__rollup')
    // gen_agg 的 join 输入：flat 直接用阶段 1 CTE（排第一时做 full join 的左基表），分组组件用上卷
    expect(region).toContain('from ep_payable__gen\n    full join x__rollup')
    expect(region).toMatch(/coalesce\(ep_payable__gen\.system_book/)
  })

  it('⑤ ModelSpec.columns 为空 ⇒ 抛错（fail-loud；Task 1 评审 Minor 1 钉住）', () => {
    expect(() => renderFctMeasures(FLAT_MEASURES, { ...FLAT_SPEC, columns: [] }, PAYABLE_DOMAINS))
      .toThrow('ModelSpec.columns 不能为空')
  })

  it('⑥ precision 形态坏（点号 "20.3"）⇒ measureOf 抛「整,小」形态错（Task 1 评审 Minor 2）', () => {
    // 负面对照钉在**声明层**（measureOf 是门禁与生成器共用的唯一解析实现）：
    // `"20.3"` 若静默过关，会物化出 `::numeric()` 缺参的 SQL，到 dbt 才炸（离声明很远）。
    expect(() => measureOf({ expr: 'sum(a)', additivity: 'flow', precision: '20.3' }))
      .toThrow(/整,小/)
  })
})
