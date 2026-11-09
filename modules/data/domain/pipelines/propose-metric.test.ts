// propose-metric.test.ts —— L1 指标声明草案组装器（propose 侧，零写入）。
//
// 三个核心不变量（对齐 plan 2026-11-05-amd-w3-l1-proposal Task 1）：
//   ① 零写入：compose 是纯函数（roots 传占位路径也照常工作 = 不碰 fs 的结构性证明）；
//   ② 保真：全量 YAML piece 的未触碰区域逐字相等（含注释归属不动）——不是「内容等价」，是「字节相等」；
//   ③ 同尺：expression/ratio/sla/命名的判据全部来自 check-data-models 的导出与 parseL1Select，
//      测试只钉「调用了同一把尺」，不复制判据文本。
import { parseDocument } from 'yaml'
import { describe, expect, it } from 'vitest'
import { composeMetricDeclaration, proposeMetricDeclarationImpl, SEMANTICS_YAML_REL } from './propose-metric'
import type { MetricDeclarationInput } from './propose-metric'
import type { PipelineDeps } from './types'

// compose 是纯函数：roots 传占位（compose 不得读 fs——这是它纯度的断言方式之一）
const NO_ROOTS = { pipelinesRoot: '/nope', contractsRoot: '/nope' }

const FIXTURE = `version: 1

# ── 实体 ──────────────────────────────────────────────────────────────────────
entities:
  branch:
    label: 门店
    synonyms: [店铺, 分店]

domains:
  finished: "state = 'FINISHED'"

measures:
  sale_amount@order:
    expr: >-
      case when state = 'FINISHED' then 1 else 0 end

# ── 指标声明（新条目按 name 字典序插入；未触碰条目逐字保留）──────────────────
metrics:
  # 前置注释（归属 retail:sales：插入不得把它挪到新条目头上）
  - name: 'lemeng:retail:sales'
    label: 销售额（不冲退货）
    entity: branch
    synonyms: [销售金额, 营业额]
    unit: 元
    definition: >-
      零售销售侧金额（**不冲退货**）= 测试口径。粒度 = 账套 × 业务日 × 门店。
      ✅ tier=certified（沿用旧验证，公式未变）。
    expression: 'sum(fct_retail_sale.sale_amount)'
    grain: [system_book, bizday, branch_num]
    owner: data-platform
    tier: certified
    source: lemeng
    freshness_sla_days: 1
    sources:
      - 's3://<bucket>/lemeng/retail_order_line/system_book=<账套>/bizday=<日期>/all.parquet'

  # ── 分隔注释（归属 outbound:net_amount）────────────────────────────────────
  - name: 'lemeng:outbound:net_amount'
    label: 出库净额
    unit: 元
    definition: >-
      出库净额 = 测试口径，可加；率类走 ratio（分母自动包 nullif）。
    ratio:
      numerator: 'sum(fct_outbound.money)'
      denominator: 'sum(fct_outbound.lines)'
    grain: [system_book, bizday, branch_num]
    owner: data-platform
    tier: experimental
    source: lemeng
    freshness_sla_days: 2
    sources:
    - 's3://<bucket>/lemeng/outbound/system_book=<账套>/bizday=<日期>/all.parquet'

  - name: 'lemeng:member:branch_vip_nums'
    label: 门店会员数
    definition: >-
      会员数 = 去重会员数，测试口径。
    expression: 'count(distinct fct_member_summary.vip_num)'
    grain: [system_book, bizday, branch_num]
    owner: data-platform
    tier: experimental
    source: lemeng
    freshness_sla_days: 1

  # ── 分隔注释（归属 wholesale:order_line）───────────────────────────────────
  - name: 'lemeng:wholesale:order_line'
    label: 批发行数
    definition: >-
      批发行数 = 测试口径。
    expression: 'sum(fct_wholesale_order.line_count)'
    grain: [system_book, bizday]
    owner: data-platform
    tier: experimental
    source: lemeng
    freshness_sla_days: 1
`

const AUDIT_SQL = `-- 独立复算：会员消费金额（测试口径）
select system_book, bizday, branch_num, sum(vip_money) as value
from {{ ref('stg_lemeng_member_summary') }}
group by 1, 2, 3
`

/** 输入造厂：合法新增档（relation 取夹具里已用的 fct_member_summary）。 */
const baseInput = (over: Partial<Record<string, unknown>> = {}): MetricDeclarationInput => ({
  name: 'lemeng:member:vip_money',
  label: '会员消费金额',
  definition: '会员消费金额 = member_summary 按门店×日合计的 vip_money，可加。测试口径（提案链路用）。',
  expression: 'sum(fct_member_summary.vip_money)',
  grain: ['system_book', 'bizday', 'branch_num'],
  owner: 'data-platform',
  tier: 'experimental',
  source: 'lemeng',
  freshnessSlaDays: 1,
  synonyms: ['会员消费'],
  auditSql: AUDIT_SQL,
  rationale: 'W3 提案链路测试',
  ...over,
})

const compose = (input: MetricDeclarationInput, currentYaml: string = FIXTURE) =>
  composeMetricDeclaration(NO_ROOTS, input, currentYaml)

// ── yaml 节点的最小结构面（测试只读；与 propose-metric.ts 的取值方式同形）─────────────────
interface YScalar { value?: unknown }
interface YNode {
  get(key: string, keep?: boolean): unknown
  items?: unknown[]
  range?: [number, number, number] | null
}
const asY = (v: unknown): YNode => v as YNode
const scalarText = (node: unknown, key: string): string => {
  const s = asY(node).get(key, true) as YScalar | null | undefined
  return s !== null && s !== undefined && typeof s.value === 'string' ? s.value : ''
}
const seqText = (node: unknown, key: string): string[] =>
  ((asY(node).get(key, true) as YNode | null | undefined)?.items ?? []).map((g) => String((g as YScalar).value))
const metricsItems = (yaml: string): YNode[] =>
  (asY(parseDocument(yaml).get('metrics', true)).items ?? []) as YNode[]

/** 从一段 YAML 里取某个 metrics 条目的**源码切片**（含前导 `- ` 整行，到该条目 node 末尾）。 */
const entrySlice = (yaml: string, name: string): string => {
  const it = metricsItems(yaml).find((i) => scalarText(i, 'name') === name)
  if (it === undefined) throw new Error(`夹具里没有条目 ${name}`)
  const range = it.range
  if (range === null || range === undefined) throw new Error(`条目 ${name} 无 range`)
  const start = yaml.lastIndexOf('\n', range[0] - 1) + 1
  return yaml.slice(start, range[2])
}

const metricNamesOf = (yaml: string): string[] => metricsItems(yaml).map((i) => scalarText(i, 'name'))

describe('composeMetricDeclaration：新增（expression 档）', () => {
  it('ok:true；piece 1 = 全量 YAML（重解析无错、条目数 +1、新条目值与输入一致）', () => {
    const r = compose(baseInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pieces).toHaveLength(2)
    const piece = r.pieces[0]
    expect(piece.path).toBe(SEMANTICS_YAML_REL)
    expect(piece.bytes).toBe(Buffer.byteLength(piece.content, 'utf8'))
    const re = parseDocument(piece.content)
    expect(re.errors).toEqual([])
    expect(metricNamesOf(piece.content)).toEqual([
      'lemeng:member:vip_money', 'lemeng:retail:sales', 'lemeng:outbound:net_amount',
      'lemeng:member:branch_vip_nums', 'lemeng:wholesale:order_line',
    ])
    const node = metricsItems(piece.content)[0]
    expect(scalarText(node, 'label')).toBe('会员消费金额')
    expect(scalarText(node, 'definition')).toBe(baseInput().definition)
    expect(scalarText(node, 'expression')).toBe('sum(fct_member_summary.vip_money)')
    expect(seqText(node, 'grain')).toEqual(['system_book', 'bizday', 'branch_num'])
    expect(scalarText(node, 'owner')).toBe('data-platform')
    expect(scalarText(node, 'tier')).toBe('experimental')
    expect(scalarText(node, 'source')).toBe('lemeng')
    expect(Number((asY(node.get('freshness_sla_days', true)) as unknown as YScalar).value)).toBe(1)
    expect(node.get('entity', true)).toBeUndefined()   // 输入未给 entity ⇒ 不落该键
    expect(seqText(node, 'synonyms')).toEqual(['会员消费'])
    expect(node.get('ratio', true)).toBeUndefined()
  })

  it('保真硬判据：插入位 = 第一个 name 字典序更大的条目之前；条目 0 头上的注释归属不动', () => {
    const r = compose(baseInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.pieces[0].content
    // 头部（metrics: 之前）逐字不动
    expect(out.startsWith(FIXTURE.slice(0, FIXTURE.indexOf('  # 前置注释')))).toBe(true)
    // 新条目在 retail:sales 之前、原前置注释仍在 retail:sales 头上（不挪到新条目头上）
    const atNew = out.indexOf("name: 'lemeng:member:vip_money'")
    const atComment = out.indexOf('# 前置注释')
    const atRetail = out.indexOf("name: 'lemeng:retail:sales'")
    expect(atNew).toBeGreaterThan(-1)
    expect(atNew).toBeLessThan(atComment)
    expect(atComment).toBeLessThan(atRetail)
    // 未触碰条目逐字保留（字节级）
    for (const name of ['lemeng:retail:sales', 'lemeng:outbound:net_amount', 'lemeng:member:branch_vip_nums', 'lemeng:wholesale:order_line']) {
      expect(out.includes(entrySlice(FIXTURE, name))).toBe(true)
    }
  })

  it('mid-file 插入（锚 = 前一条目 node 末尾）与尾部追加（锚 = 末条目 node 末尾）', () => {
    const mid = compose(baseInput({ name: 'lemeng:transfer:line_count' }))
    expect(mid.ok).toBe(true)
    if (mid.ok) {
      const out = mid.pieces[0].content
      const atNew = out.indexOf("name: 'lemeng:transfer:line_count'")
      const atMember = out.indexOf("name: 'lemeng:member:branch_vip_nums'")
      const atWholesaleComment = out.indexOf('# ── 分隔注释（归属 wholesale:order_line）')
      expect(atNew).toBeGreaterThan(atMember)
      expect(atNew).toBeLessThan(atWholesaleComment)   // wholesale 头上的注释仍归属 wholesale
      expect(out.includes(entrySlice(FIXTURE, 'lemeng:wholesale:order_line'))).toBe(true)
    }
    const tail = compose(baseInput({ name: 'lemeng:zz_top:lines' }))
    expect(tail.ok).toBe(true)
    if (tail.ok) {
      const out = tail.pieces[0].content
      expect(out.indexOf("name: 'lemeng:zz_top:lines'")).toBeGreaterThan(
        out.indexOf("name: 'lemeng:wholesale:order_line'"))
      expect(metricNamesOf(out)).toHaveLength(5)
    }
  })

  it('缺 auditSql：不拒——validation 注明 + downstream required 指向映射出的对账文件', () => {
    const r = compose(baseInput({ auditSql: undefined }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pieces).toHaveLength(1)
    expect(r.validation).toContainEqual({
      path: 'auditSql',
      message: '未提供——PR 合并前 gate ⑦（audit test）会红，draft PR 带红是预期',
    })
    expect(r.downstream).toEqual([{
      path: 'dbt/tests/lemeng/audit_lemeng__member__vip_money.sql',
      kind: 'required',
      why: expect.stringContaining('对账'),
    }])
  })

  it('auditSql 在场：piece 2 内容逐字（不加工），落点按 metricToAuditFileName 映射', () => {
    const r = compose(baseInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pieces[1]).toEqual({
      path: 'dbt/tests/lemeng/audit_lemeng__member__vip_money.sql',
      bytes: Buffer.byteLength(AUDIT_SQL, 'utf8'),
      content: AUDIT_SQL,
    })
    expect(r.validation).toEqual([])
    expect(r.downstream).toEqual([])
  })
})

describe('composeMetricDeclaration：ratio 档与互斥', () => {
  it('ratio 在场：entry 落 ratio（嵌套 map），分子分母单引号；relation 取自引用反解', () => {
    const r = compose(baseInput({
      name: 'lemeng:member:vip_rate',
      expression: undefined,
      ratio: { numerator: 'sum(fct_member_summary.vip_money)', denominator: 'sum(fct_member_summary.vip_nums)' },
      definition: '会员消费占比 = 测试口径（率类，分母自动包 nullif）。',
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const re = parseDocument(r.pieces[0].content)
    expect(re.errors).toEqual([])
    const node = metricsItems(r.pieces[0].content)[0]
    expect(node.get('expression', true)).toBeUndefined()
    expect(scalarText(asY(node.get('ratio', true)), 'numerator')).toBe('sum(fct_member_summary.vip_money)')
    expect(scalarText(asY(node.get('ratio', true)), 'denominator')).toBe('sum(fct_member_summary.vip_nums)')
  })

  it('expression 与 ratio 同给 ⇒ 拒（ratioShapeError：两处事实源）', () => {
    const r = compose(baseInput({ ratio: { numerator: 'sum(fct_member_summary.a)', denominator: 'sum(fct_member_summary.b)' } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.path === 'expression' && i.message.includes('互斥'))).toBe(true)
  })

  it('expression 与 ratio 都缺 ⇒ 拒（ratioShapeError：缺 expression）', () => {
    const r = compose(baseInput({ expression: undefined }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.path === 'expression' && i.message.includes('缺 expression'))).toBe(true)
  })
})

describe('composeMetricDeclaration：B11 relation 白名单（从 currentYaml 反解）', () => {
  it('relation 不在 L1 已用集合 ⇒ 拒 + issues 点名 relation', () => {
    const r = compose(baseInput({ expression: 'sum(fct_elsewhere.money)' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.path === 'expression' && i.message.includes('fct_elsewhere'))).toBe(true)
  })
  it('ratio 的 relation 同样受白名单管', () => {
    const r = compose(baseInput({
      expression: undefined,
      ratio: { numerator: 'sum(fct_elsewhere.a)', denominator: 'sum(fct_elsewhere.b)' },
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.path === 'ratio' && i.message.includes('fct_elsewhere'))).toBe(true)
  })
})

describe('composeMetricDeclaration：expression/sla/命名等形状（与领域门禁同尺）', () => {
  it('expression 非 agg(relation.column) 形态 ⇒ 拒', () => {
    for (const bad of ['sum(fct_retail_sale)', 'fct_retail_sale.sale_amount', 'sum(a.b) + sum(a.c)', 'avg( x.y ) * 2']) {
      const r = compose(baseInput({ expression: bad }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.issues.some((i) => i.path === 'expression')).toBe(true)
    }
  })
  it('expression 含分号 / DDL 词 ⇒ 拒（parseL1Select）', () => {
    for (const bad of ['sum(fct_retail_sale.a); drop table x', 'delete(fct_retail_sale.a)']) {
      const r = compose(baseInput({ expression: bad }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.issues.some((i) => i.path === 'expression')).toBe(true)
    }
  })
  it('count(distinct …) 形态放行', () => {
    const r = compose(baseInput({ expression: 'count(distinct fct_member_summary.vip_num)' }))
    expect(r.ok).toBe(true)
  })
  it('sla 非负整数（freshnessSlaError 同尺）：1.5 ⇒ 拒；0 ⇒ 过', () => {
    const bad = compose(baseInput({ freshnessSlaDays: 1.5 }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.some((i) => i.path === 'freshnessSlaDays')).toBe(true)
    expect(compose(baseInput({ freshnessSlaDays: 0 })).ok).toBe(true)
  })
  it('命名三段式与保留前缀 ⇒ 拒', () => {
    for (const bad of ['lemeng.member.vip', 'lemeng:member', 'Lemeng:member:vip', 'lemeng:member:Vip']) {
      const r = compose(baseInput({ name: bad }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.issues.some((i) => i.path === 'name')).toBe(true)
    }
    const reserved = compose(baseInput({ name: 't8c:member:vip' }))
    expect(reserved.ok).toBe(false)
    if (!reserved.ok) expect(reserved.issues[0]?.message).toContain('保留')
  })
  it('tier 闭集 / source 形态 / grain 标识符 / owner、label、definition 必填', () => {
    const cases: Partial<Record<string, unknown>>[] = [
      { tier: 'draft' }, { tier: '' },
      { source: 'Lemeng' },
      { grain: [] }, { grain: ['bizday', 'a.b'] }, { grain: 'bizday' },
      { owner: '' }, { label: '' }, { definition: '' },
      { definition: '两段\n定义' },   // 换行会破坏折叠标量的逐字保真 ⇒ 拒
      { synonyms: '会员消费' }, { synonyms: [''] }, { synonyms: [42] },
    ]
    for (const over of cases) {
      const r = compose(baseInput(over))
      expect(r.ok, JSON.stringify(over)).toBe(false)
    }
  })
  it('entity 指向未声明实体 ⇒ 拒（增量限定在 metrics[]，不动 entities:）', () => {
    const r = compose(baseInput({ entity: 'city' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.path === 'entity' && i.message.includes('entities'))).toBe(true)
  })
})

describe('composeMetricDeclaration：修改模式（同名已存在）', () => {
  const modifyInput = (over: Partial<Record<string, unknown>> = {}): MetricDeclarationInput => baseInput({
    name: 'lemeng:retail:sales',
    expression: 'sum(fct_retail_sale.sale_amount)',
    synonyms: undefined,   // 输入未给 synonyms ⇒ 从原条目带过（entity 同理，baseInput 本就不带）
    ...over,
  })

  it('definition 变了 ⇒ ok：条目数不变、原位替换、未触碰条目逐字、输入不管的键（unit/sources/entity/synonyms）带过', () => {
    const r = compose(modifyInput({ definition: '新的口径定义（2026-11-05 起）：测试口径第二版，冲退货规则变化。' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mode).toBe('modify')
    const out = r.pieces[0].content
    const re = parseDocument(out)
    expect(re.errors).toEqual([])
    expect(metricNamesOf(out)).toEqual(metricNamesOf(FIXTURE))   // 条目数不变、顺序不动
    expect(out.includes(entrySlice(FIXTURE, 'lemeng:outbound:net_amount'))).toBe(true)
    expect(out.includes(entrySlice(FIXTURE, 'lemeng:member:branch_vip_nums'))).toBe(true)
    expect(out.includes(entrySlice(FIXTURE, 'lemeng:wholesale:order_line'))).toBe(true)
    const node = metricsItems(out)[0]
    expect(scalarText(node, 'definition')).toContain('第二版')
    // 带过键：值保真
    expect(scalarText(node, 'unit')).toBe('元')
    expect(scalarText(node, 'entity')).toBe('branch')
    expect(seqText(node, 'synonyms')).toEqual(['销售金额', '营业额'])
    expect(asY(node.get('sources', true)).items ?? []).toHaveLength(1)
  })

  it('definition 逐字相同 ⇒ 拒（防无意义重提）', () => {
    const same = scalarText(metricsItems(FIXTURE)[0], 'definition')
    const r = compose(modifyInput({ definition: same }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.path === 'definition' && i.message.includes('相同'))).toBe(true)
  })

  it('#1427：definition 不变、只改 synonyms ⇒ 通过（alias_gap 的需求形态）', () => {
    const same = scalarText(metricsItems(FIXTURE)[0], 'definition')
    const r = compose(modifyInput({ definition: same, synonyms: ['销售金额', '营业额', 'net_sales'] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.mode).toBe('modify')
    const node = metricsItems(r.pieces[0].content).find((m) => scalarText(m, 'name') === 'lemeng:retail:sales')
    expect(seqText(node as never, 'synonyms')).toEqual(['销售金额', '营业额', 'net_sales'])
  })

  it('#1434：只改 synonyms ⇒ 键级编辑（携带键与注释逐字保留，不走整条重写）', () => {
    const yaml = [
      'version: 1',
      'metrics:',
      "  - name: 'lemeng:retail:net_sales'",
      '    label: 净销售额',
      '    # 这条注释必须留着（整条重写会丢）',
      "    definition: >-",
      '      原定义一句话。',
      "    expression: 'sum(fct_retail_sale.net_amount)'",
      '    grain: [system_book, bizday]',
      '    owner: data-platform',
      '    tier: experimental',
      '    source: lemeng',
      '    freshness_sla_days: 1',
      '    detail:',
      '      relation: vw_lemeng_retail_order_line',
      '',
    ].join('\n')
    const r = compose({
      name: 'lemeng:retail:net_sales', label: '净销售额', definition: '原定义一句话。',
      expression: 'sum(fct_retail_sale.net_amount)', grain: ['system_book', 'bizday'],
      owner: 'data-platform', tier: 'experimental', source: 'lemeng', freshnessSlaDays: 1,
      synonyms: ['净销售金额', 'net_sales'], rationale: '补别名',
    }, yaml)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.pieces[0].content
    expect(out).toContain('# 这条注释必须留着（整条重写会丢）')
    expect(out).toContain('    detail:\n      relation: vw_lemeng_retail_order_line')
    expect(out).toContain("synonyms: [ '净销售金额', 'net_sales' ]")
    expect(out).toContain('    expression: \'sum(fct_retail_sale.net_amount)\'')
    expect(parseDocument(out).errors).toHaveLength(0)
  })

  it('#1427：definition 与 synonyms 都没变 ⇒ 仍拒（防无意义重提）', () => {
    const same = scalarText(metricsItems(FIXTURE)[0], 'definition')
    const r = compose(modifyInput({ definition: same, synonyms: ['销售金额', '营业额'] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.path === 'definition' && i.message.includes('相同'))).toBe(true)
  })

  it('修改模式带 advisory：条目按输入整体重写、行内注释不保留', () => {
    const r = compose(modifyInput({ definition: '口径第二版。' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.validation.some((i) => i.path === 'name' && i.message.includes('修改'))).toBe(true)
  })

  it('同名两处（口径分叉）⇒ 拒，不猜改哪一份', () => {
    const twice = FIXTURE + entrySlice(FIXTURE, 'lemeng:retail:sales')   // 把 retail:sales 再贴一份进 metrics[]
    const r = compose(modifyInput({ definition: '口径第二版。' }), twice)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.path === 'name' && i.message.includes('同名两处'))).toBe(true)
  })
})

describe('composeMetricDeclaration：基线不可用（未知 ≠ 没有，拒而不猜）', () => {
  it('currentYaml 不可解析 ⇒ ok:false（compose 无法在坏基线上做全量拼接）', () => {
    const r = compose(baseInput(), `${FIXTURE.slice(0, 400)}metrics: [unclosed`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]?.path).toBe('currentYaml')
  })
  it('没有 metrics: 段 ⇒ ok:false', () => {
    const r = compose(baseInput(), FIXTURE.slice(0, FIXTURE.indexOf('metrics:')))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]?.path).toBe('metrics')
  })
  it('currentYaml 为空串 ⇒ ok:false', () => {
    const r = compose(baseInput(), '')
    expect(r.ok).toBe(false)
  })
})

describe('proposeMetricDeclarationImpl（路由实现，只读现行文件）', () => {
  const deps: PipelineDeps = { roots: NO_ROOTS, runs: null, env: {}, sandbox: null }

  it('真实仓 l1_metrics.yml 上组装成功且零写盘（纯读 + 纯拼）', async () => {
    const out = await proposeMetricDeclarationImpl(deps, {
      name: 'lemeng:probe:compose_smoke', label: '组装探针',
      definition: '探针口径：只进回包不落盘，验证真实基线上全量拼接可解析。',
      expression: 'sum(fct_retail_sale.sale_amount)',
      grain: ['system_book', 'bizday'], owner: 'data-platform', tier: 'experimental',
      source: 'lemeng', freshnessSlaDays: 1, rationale: 'compose 冒烟',
    })
    expect(out.isError).toBe(false)
    const payload = out.payload as Record<string, unknown>
    expect(payload).toMatchObject({ status: 'ok', note: expect.stringContaining('不落盘') })
    const pieces = payload.pieces as { path: string; content: string }[]
    expect(pieces[0].path).toBe('dbt/semantics/l1_metrics.yml')
    const re = parseDocument(pieces[0].content)
    expect(re.errors).toEqual([])
    // 56 条声明 + 本条探针 = 57（2026-11-10 新增零售商品毛利 L1）
    expect(metricNamesOf(pieces[0].content)).toHaveLength(57)
  })

  it('name / rationale 缺失 ⇒ bad_param（工具级错误）', async () => {
    const out = await proposeMetricDeclarationImpl(deps, { name: '', rationale: '' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'bad_param' })
  })

  it('形状非法的草案 ⇒ refused/invalid_draft（issues 透传）', async () => {
    const out = await proposeMetricDeclarationImpl(deps, {
      name: 'not-a-namespace', label: 'x', definition: 'x', grain: ['bizday'],
      owner: 'o', tier: 'experimental', source: 'lemeng', freshnessSlaDays: 1, rationale: 'r',
    })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
  })
})
