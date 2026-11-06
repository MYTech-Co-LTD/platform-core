// @vitest-environment happy-dom
// map.test.ts — 体系地图的纯函数 + 客户端渲染测试。
//
// 数据全部走注入（不碰文件系统 / 数据库）；客户端脚本在 happy-dom 里真跑一遍，
// 断言的是**结构与水位**（视图切换 / 深链 / 五步步骤条 / 搜索过滤），不是像素。
// 真机走查清单见 W5 报告（/tmp/w5-report.md）。
import { beforeEach, describe, expect, it } from 'vitest'
import type { ContractRef } from '../pipelines/defs'
import {
  buildSystemMapModel,
  escapeJsonForScript,
  parseDimensionsYaml,
  parseInvariantsYaml,
  parseSelectSql,
  parseSystemMapSemantics,
  renderSystemMapHtml,
} from './map'
import type {
  SystemMapDimension,
  SystemMapInput,
  SystemMapInvariant,
  SystemMapMetricFact,
} from './map'

const contract: ContractRef = {
  id: 'lemeng.retail_order_line',
  domain: 'lemeng',
  table: 'retail_order_line',
  path: 'contracts/common/lemeng.retail_order_line.json',
  columns: 25,
  doc: {},
}

const metric = (partial: Partial<SystemMapMetricFact> & { id: string }): SystemMapMetricFact => ({
  title: partial.id,
  description: '',
  selectSql: 'select sum(fct_retail_sale.sale_amount) as value, branch_num from fct_retail_sale',
  ...partial,
})

const DIMENSIONS: SystemMapDimension[] = [
  {
    name: 'branch_geo', label: '门店（行政区划）', relation: 'branch', key: 'branch_num',
    levels: [
      { level: 'province', column: 'province' },
      { level: 'city', column: 'city' },
      { level: 'branch', column: 'branch_num' },
    ],
  },
  {
    name: 'item', label: '商品', relation: 'item', key: 'item_num',
    levels: [{ level: 'category', column: 'item_category_name' }, { level: 'item', column: 'item_num' }],
  },
]

const INVARIANTS: SystemMapInvariant[] = [
  {
    name: 'retail_net_eq_sale_minus_return', relation: 'fct_retail_sale',
    severity: 'error', status: 'verified', owner: 'data-platform',
    why: '净额 = 销售侧 − 退货侧。',
  },
  {
    name: 'outbound_cost_nonneg', relation: 'fct_hq_outbound',
    severity: 'warn', status: 'observing', owner: 'data-platform',
    why: '成本不应为负。',
  },
]

function baseInput(metrics: SystemMapMetricFact[]): SystemMapInput {
  return {
    semantics: {
      entities: new Map([['branch', { label: '门店', synonyms: ['店铺', '分店'] }]]),
      metrics: new Map([
        ['lemeng:retail:net_sales', {
          label: '净销售额',
          definition: '销售侧 − 退货侧',
          expression: 'sum(fct_retail_sale.net_amount)',
          grain: ['system_book', 'bizday', 'branch_num'],
          entity: 'branch',
          synonyms: ['净销售金额'],
          unit: '元',
          owner: 'data-platform',
          tier: 'experimental',
        }],
        ['lemeng:retail:orphan', {
          label: '孤儿指标',
          definition: '没有实体的指标',
          expression: 'sum(fct_retail_sale.sale_amount)',
          grain: [],
          entity: null,
          synonyms: [],
          unit: null,
          owner: null,
          tier: null,
        }],
      ]),
    },
    metrics,
    contracts: [contract],
    models: [
      { name: 'fct_retail_sale', path: 'dbt/models/lemeng/marts/fct_retail_sale.sql', refs: ['stg_lemeng_retail_order_line'] },
      { name: 'stg_lemeng_retail_order_line', path: 'dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql', refs: [] },
    ],
    auditFiles: ['audit_lemeng__retail__net_sales.sql'],
    reports: [{ id: 'r1', title: '经营日报', latestVersion: 3, latestVersionTitle: '经营日报 v3', publishedVersion: 2 }],
    usage: { 'lemeng:retail:net_sales': 7 },
    demands: [
      { kind: 'alias_gap', target: '营业额', occurrences: 4, lastSeen: '2026-11-05T00:00:00.000Z', dismissedAt: null },
      { kind: 'new_metric', target: '客单价', occurrences: 2, lastSeen: '2026-11-04T00:00:00.000Z', dismissedAt: null },
    ],
    dimensions: DIMENSIONS,
    invariants: INVARIANTS,
    incidents: 2,
    generatedAt: '2026-11-06T00:00:00.000Z',
  }
}

const METRICS: SystemMapMetricFact[] = [
  metric({ id: 'lemeng:retail:net_sales', title: '净销售额', entity: 'branch', source: 'l1' }),
  metric({
    id: 'lemeng:retail:orphan',
    title: '孤儿指标',
    entity: null,
    source: 'l1',
    selectSql: 'select sum(fct_retail_sale.sale_amount) as value from fct_retail_sale',
  }),
  metric({
    id: 'l2_self_built',
    title: '自建指标',
    entity: null,
    source: 'l2',
    basis: 'l1_tree',
    selectSql: 'select sum(fct_retail_sale.net_amount) as value from fct_retail_sale',
  }),
  metric({
    id: 'private_metric',
    title: '私有测度',
    entity: null,
    source: 'l2',
    basis: 'column_agg',
    selectSql: 'select sum(fct_retail_sale.sale_amount) as value from fct_retail_sale',
  }),
]

describe('buildSystemMapModel：健康五数（healthOf 唯一实现）', () => {
  it('实体绑定 / 对账覆盖 / 零使用 / 未消解需求 / 口径事故逐项正确', () => {
    const model = buildSystemMapModel(baseInput(METRICS))
    expect(model.health).toEqual({
      metricTotal: 4,
      entityBound: 1,
      entityBoundPct: 25,
      auditCovered: 1,
      auditCoveredPct: 25,
      zeroUse: 3,
      openDemands: 2,
      incidents: 2,
      l1Metrics: 2,
      l2Metrics: 1,
      privateMetrics: 1,
      incidentsTracked: true,
    })
  })

  it('空词表不除零：覆盖率 0，不产生 NaN', () => {
    const model = buildSystemMapModel({ ...baseInput([]), metrics: [] })
    expect(model.health.entityBoundPct).toBe(0)
    expect(model.health.auditCoveredPct).toBe(0)
    expect(Number.isNaN(model.health.entityBoundPct)).toBe(false)
  })

  it('事故计数未接入时 incidentsTracked=false（页面据此标「未接入」而非冒充 0）', () => {
    const model = buildSystemMapModel({
      ...baseInput(METRICS),
      incidents: 0,
      incidentsTracked: false,
    })
    expect(model.health.incidents).toBe(0)
    expect(model.health.incidentsTracked).toBe(false)
    const html = renderSystemMapHtml(model)
    expect(html).toContain('未接入')
  })
})

describe('buildSystemMapModel：W4 声明（维度层级 / 业务不变量）', () => {
  it('维度与不变量按声明进入模型（名称/级数/关系、status/severity）', () => {
    const model = buildSystemMapModel(baseInput(METRICS))
    expect(model.dimensions.map((d) => d.name)).toEqual(['branch_geo', 'item'])
    expect(model.dimensions[0]?.levels.length).toBe(3)
    expect(model.dimensions[0]?.relation).toBe('branch')
    expect(model.invariants.map((i) => i.name)).toEqual([
      'retail_net_eq_sale_minus_return', 'outbound_cost_nonneg',
    ])
    expect(model.invariants[0]).toMatchObject({ status: 'verified', severity: 'error' })
  })

  it('声明不可读 ⇒ 空清单 + warning（未知 ≠ 没有声明）', () => {
    const input = baseInput(METRICS)
    delete input.dimensions
    delete input.invariants
    const model = buildSystemMapModel({ ...input, dimensionsYaml: null, invariantsYaml: null })
    expect(model.dimensions).toEqual([])
    expect(model.invariants).toEqual([])
    expect(model.warnings.join('\n')).toContain('dimensions.yml')
    expect(model.warnings.join('\n')).toContain('invariants.yml')
  })

  it('parseDimensionsYaml / parseInvariantsYaml：坏 YAML 不抛、缺字段不编', () => {
    expect(parseDimensionsYaml('dimensions: [oops').length).toBe(0)
    expect(parseInvariantsYaml(null).length).toBe(0)
    const dims = parseDimensionsYaml(`
dimensions:
  - name: branch_geo
    relation: branch
    key: branch_num
    hierarchy:
      - { level: province, column: province }
      - { level: branch, column: branch_num }
`)
    expect(dims).toEqual([{
      name: 'branch_geo', label: 'branch_geo', relation: 'branch', key: 'branch_num',
      levels: [{ level: 'province', column: 'province' }, { level: 'branch', column: 'branch_num' }],
    }])
    const invs = parseInvariantsYaml(`
invariants:
  - name: x
    relation: fct_x
    severity: error
    status: verified
`)
    expect(invs).toEqual([{
      name: 'x', relation: 'fct_x', severity: 'error', status: 'verified', owner: null, why: '',
    }])
  })
})

describe('buildSystemMapModel：孤儿指标 / 实体 / 数据源 / 回溯链', () => {
  const model = buildSystemMapModel(baseInput(METRICS))

  it('未绑定实体或源关系不在模型图的指标被列为孤儿，并给出原因', () => {
    expect(model.orphans.map((o) => o.id).sort()).toEqual([
      'l2_self_built',
      'lemeng:retail:orphan',
      'private_metric',
    ])
    expect(model.orphans.find((o) => o.id === 'lemeng:retail:orphan')?.reasons).toContain('未绑定实体')
  })

  it('实体分组带上 YAML 标签与同义词，并挂上指标与关系', () => {
    const branch = model.entities.find((e) => e.name === 'branch')
    expect(branch).toMatchObject({
      label: '门店',
      synonyms: ['店铺', '分店'],
      metricIds: ['lemeng:retail:net_sales'],
      relations: ['fct_retail_sale'],
    })
  })

  it('数据源关系聚合引用指标，并带两层上游链与契约', () => {
    const src = model.sources.find((s) => s.name === 'fct_retail_sale')
    expect(src?.metricIds.sort()).toEqual([
      'l2_self_built',
      'lemeng:retail:net_sales',
      'lemeng:retail:orphan',
      'private_metric',
    ])
    expect(src?.upstream).toEqual([
      {
        name: 'stg_lemeng_retail_order_line',
        depth: 1,
        path: 'dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql',
        contracts: ['lemeng.retail_order_line'],
      },
    ])
    expect(src?.contracts, 'marts 本身无契约时应透出上游 staging 匹配到的契约').toEqual([
      'lemeng.retail_order_line',
    ])
  })

  it('指标回溯链：指标 → 实体 → 关系 → 上游模型 → 契约', () => {
    const m = model.metrics.find((x) => x.id === 'lemeng:retail:net_sales')
    expect(m?.trace).toEqual({
      metric: 'lemeng:retail:net_sales',
      entity: 'branch',
      relation: 'fct_retail_sale',
      model: 'fct_retail_sale',
      modelPath: 'dbt/models/lemeng/marts/fct_retail_sale.sql',
      upstream: [{
        name: 'stg_lemeng_retail_order_line',
        depth: 1,
        path: 'dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql',
        contracts: ['lemeng.retail_order_line'],
      }],
      contracts: ['lemeng.retail_order_line'],
    })
    expect(m?.auditFile).toBe('audit_lemeng__retail__net_sales.sql')
    expect(m?.auditExists).toBe(true)
    expect(m?.usage30d).toBe(7)
  })
})

describe('渲染：中文标题 / XSS / 零外链 / 体积', () => {
  const htmlOf = (input: SystemMapInput = baseInput(METRICS)): string =>
    renderSystemMapHtml(buildSystemMapModel(input))

  it('HTML 含关键中文标题与数据脚本', () => {
    const html = htmlOf()
    for (const title of [
      '数据体系地图', '总览', '指标', '实体', '数据源', '需求台账',
      '回溯链', '维度层级', '业务不变量', '口径事故数',
    ]) {
      expect(html).toContain(title)
    }
    expect(html).toContain('<script type="application/json" id="system-map-data">')
  })

  it('零外链：页面不引用任何外部脚本/样式/图片', () => {
    const html = htmlOf()
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i)
    expect(html).not.toContain('url(http')
    expect(html).not.toContain('<link ')
  })

  it('恶意 definition（含 </script>）在嵌入 JSON 里被转义，不能逃逸脚本块', () => {
    const input = baseInput(METRICS)
    input.semantics = {
      entities: new Map([['branch', { label: '门店', synonyms: [] }]]),
      metrics: new Map([[
        'lemeng:retail:net_sales',
        {
          label: '净销售额',
          definition: '</script><script>alert("xss")</script>',
          expression: 'sum(fct_retail_sale.net_amount)',
          grain: [],
          entity: 'branch',
          synonyms: [],
          unit: null,
          owner: null,
          tier: null,
        },
      ]]),
    }
    const html = htmlOf(input)
    expect(html).not.toContain('<script>alert("xss")</script>')
    expect(html).not.toContain('</script><script>alert')
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert')
  })

  it('escapeJsonForScript 同时处理 & < > 与 U+2028/U+2029', () => {
    const out = escapeJsonForScript({ text: '&<>' + '\u2028' + '\u2029' })
    expect(out).toContain('\\u0026')
    expect(out).toContain('\\u003c')
    expect(out).toContain('\\u003e')
    expect(out).toContain('\\u2028')
    expect(out).toContain('\\u2029')
    expect(JSON.parse(out)).toEqual({ text: '&<>' + '\u2028' + '\u2029' })
  })

  it('单文件 HTML ≤ 400KB（W5 移动端硬约束）', () => {
    const bytes = Buffer.byteLength(htmlOf(), 'utf8')
    expect(bytes).toBeLessThan(400 * 1024)
  })
})

describe('渲染：移动端结构（CSS 断点 + 底部标签栏 + 44px + 无横向滚动）', () => {
  const html = renderSystemMapHtml(buildSystemMapModel(baseInput(METRICS)))

  it('三档断点：≥1024 侧栏 / 768–1023 顶部标签 / <768 底部标签栏', () => {
    expect(html).toContain('@media (min-width: 768px) and (max-width: 1023px)')
    expect(html).toContain('@media (max-width: 767px)')
    expect(html).toContain('nav.mobile-tabbar')
    expect(html).toContain('env(safe-area-inset-bottom')
  })

  it('<768：底部四个入口（总览/指标/实体/需求）+ 搜索吸顶 + 详情全屏 + 不渲染 SVG', () => {
    const mobile = html.slice(html.indexOf('@media (max-width: 767px)'))
    expect(mobile).toContain('nav.tabs { display: none; }')
    expect(mobile).toContain('position: fixed')
    expect(mobile).toContain('.graph-panel { display: none !important; }')
    expect(html).toMatch(/<nav class="mobile-tabbar"[\s\S]*href="#\/overview"[\s\S]*href="#\/metrics"[\s\S]*href="#\/entities"[\s\S]*href="#\/demands"/)
    expect(html).toContain('.search-bar { position: sticky; top: 0;')
    expect(html).toContain('body.detail-open #metric-detail')
    expect(html).toMatch(/body\.detail-open #metric-detail \{[^}]*position: fixed; inset: 0;/)
  })

  it('375px：底部 4 项严格均分（flex:1 1 0 / min-width:0 / nowrap），nav 无横向 padding', () => {
    const mobile = html.slice(html.indexOf('@media (max-width: 767px)'))
    expect(mobile).toMatch(/nav\.mobile-tabbar \{[^}]*width: 100%; box-sizing: border-box;/)
    expect(mobile).toMatch(/nav\.mobile-tabbar \{[^}]*padding: 0; padding-bottom: env\(safe-area-inset-bottom/)
    expect(mobile).toMatch(/nav\.mobile-tabbar a \{[^}]*flex: 1 1 0; min-width: 0;/)
    expect(mobile).toMatch(/nav\.mobile-tabbar a \{[^}]*white-space: nowrap;/)
  })

  it('375px：健康卡单列 + 副标题不折行（缩字号、隐藏时间戳）', () => {
    const mobile = html.slice(html.indexOf('@media (max-width: 767px)'))
    expect(mobile).toContain('.cards { grid-template-columns: 1fr; gap: 8px; }')
    expect(mobile).toContain('header.top .sub { font-size: 12px; }')
    expect(mobile).toContain('header.top .sub .ts { display: none; }')
    expect(html).toContain('<span class="ts" id="generated-at">')
  })

  it('点击目标 ≥44px 用 CSS 类；无横向滚动断 min-width 而非只 overflow-x', () => {
    expect(html).toContain('.tap { min-height: 44px; min-width: 44px; }')
    expect(html).toContain('nav.mobile-tabbar a {')
    expect(html).toContain('min-height: 56px')
    expect(html).toContain('html, body { max-width: 100%; overflow-x: hidden; }')
    expect(html).toContain('min-width: 0')
    expect(html).toContain('.table-wrap { max-width: 100%; overflow-x: auto; }')
    // 手机不靠「表格横向滚」兜底：桌面表格整块隐藏，改渲染卡片清单
    expect(html).toContain('table-wrap desktop-only')
    expect(html).toContain('metric-cards mobile-only')
  })
})

// ── 客户端脚本真跑（happy-dom）──────────────────────────────────────────────

/** 把服务端 HTML 塞进当前 document 并执行内联客户端脚本。 */
function mount(html: string, hash: string): void {
  const start = html.indexOf('<body>') + '<body>'.length
  const end = html.lastIndexOf('</body>')
  document.body.innerHTML = html.slice(start, end)
  window.location.hash = hash
  const scripts = [...document.querySelectorAll('script')]
  const main = scripts.find((s) => s.getAttribute('type') !== 'application/json')
  if (main === null || main === undefined) throw new Error('client script not found')
  // eslint-disable-next-line no-new-func
  new Function(main.textContent ?? '')()
}

const visible = (id: string): boolean => {
  const el = document.getElementById(id)
  return el !== null && !el.hasAttribute('hidden')
}

describe('客户端路由与视图（深链 / 刷新 / 返回 / 搜索）', () => {
  const html = renderSystemMapHtml(buildSystemMapModel(baseInput(METRICS)))

  beforeEach(() => {
    document.body.className = ''
    document.body.innerHTML = ''
    window.location.hash = ''
  })

  it('默认（无 hash）落总览；其余视图隐藏；健康卡片渲染六张（含口径事故）', () => {
    mount(html, '#/overview')
    expect(visible('view-overview')).toBe(true)
    expect(visible('view-metrics')).toBe(false)
    expect(visible('view-entities')).toBe(false)
    expect(visible('view-sources')).toBe(false)
    expect(visible('view-demands')).toBe(false)
    const cards = document.querySelectorAll('#health .card')
    expect(cards.length).toBe(6)
    const text = document.getElementById('health')?.textContent ?? ''
    expect(text).toContain('实体绑定率')
    expect(text).toContain('对账覆盖率')
    expect(text).toContain('近 30 天零使用指标')
    expect(text).toContain('未消解需求')
    expect(text).toContain('口径事故数')
    expect(text).toContain('25%')
    // 375px 底部标签栏：4 项（总览/指标/实体/需求）
    expect(document.querySelectorAll('nav.mobile-tabbar a').length).toBe(4)
  })

  it('W4 声明在总览渲染成清单与计数（维度级数 / 不变量 status+severity）', () => {
    mount(html, '#/overview')
    const dims = document.getElementById('dimensions')?.textContent ?? ''
    expect(dims).toContain('维度层级（2 个）')
    expect(dims).toContain('门店（行政区划）')
    expect(dims).toContain('province(province) → city(city) → branch(branch_num)')
    const invs = document.getElementById('invariants')?.textContent ?? ''
    expect(invs).toContain('业务不变量（2 条）')
    expect(invs).toContain('retail_net_eq_sale_minus_return')
    expect(invs).toContain('verified')
    expect(invs).toContain('严重度 error')
    expect(invs).toContain('按状态：observing 1 / verified 1')
  })

  it('桌面 SVG 图：实体—指标二部图渲染（≤80 节点）', () => {
    mount(html, '#/overview')
    const graph = document.getElementById('graph')
    expect(graph?.querySelector('svg')).not.toBeNull()
    expect(graph?.textContent).toContain('门店')
    expect(graph?.textContent).toContain('净销售额')
  })

  it('深链 #/metrics/<id> 直接落指标详情（刷新同视图）', () => {
    mount(html, '#/metrics/lemeng:retail:net_sales')
    expect(visible('view-metrics')).toBe(true)
    expect(visible('view-overview')).toBe(false)
    const detail = document.getElementById('metric-detail')
    expect(detail?.textContent).toContain('净销售额')
    expect(document.body.classList.contains('detail-open')).toBe(true)
    expect(document.querySelectorAll('[data-step]').length).toBe(5)
    expect([...document.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step')))
      .toEqual(['metric', 'entity', 'relation', 'model', 'contract'])
  })

  it('hash 切换（#/overview ↔ #/metrics）隐藏/显示对应视图，并退出全屏详情', () => {
    mount(html, '#/metrics/lemeng:retail:net_sales')
    window.location.hash = '#/overview'
    window.dispatchEvent(new window.Event('hashchange'))
    expect(visible('view-overview')).toBe(true)
    expect(visible('view-metrics')).toBe(false)
    expect(document.body.classList.contains('detail-open')).toBe(false)

    window.location.hash = '#/metrics'
    window.dispatchEvent(new window.Event('hashchange'))
    expect(visible('view-metrics')).toBe(true)
    expect(visible('view-overview')).toBe(false)
  })

  it('未知 hash 回落总览（深链不会白屏）', () => {
    mount(html, '#/no-such-view')
    expect(visible('view-overview')).toBe(true)
  })

  it('外部进入详情：无同源 referrer ⇒ 「← 返回」回 #/metrics（不 history.back）', () => {
    mount(html, '#/metrics/lemeng:retail:net_sales')
    const back = document.querySelector('.back-button')
    expect(back).not.toBeNull()
    ;(back as HTMLElement).click()
    expect(window.location.hash).toBe('#/metrics')
  })

  it('搜索即过滤（前端过滤，无请求）', () => {
    mount(html, '#/metrics')
    const input = document.getElementById('metric-search') as HTMLInputElement
    expect(document.querySelectorAll('#metric-list .metric-item').length).toBe(4)
    input.value = '净销售'
    input.dispatchEvent(new window.Event('input'))
    const items = [...document.querySelectorAll('#metric-list .metric-item')]
    expect(items.length).toBe(1)
    expect(items[0]?.textContent).toContain('净销售额')
  })

  it('点击指标卡进入详情并写入可分享深链', () => {
    mount(html, '#/metrics')
    const first = document.querySelector('#metric-list .metric-item') as HTMLElement
    first.click()
    expect(document.body.classList.contains('detail-open')).toBe(true)
    expect(window.location.hash.startsWith('#/metrics/')).toBe(true)
    expect(decodeURIComponent(window.location.hash)).toContain('lemeng:retail:net_sales')
  })
})

describe('解析器', () => {
  it('parseSelectSql 拆出表达式 / 维度 / 关系（支持 schema 限定与引号）', () => {
    expect(parseSelectSql('select sum(fct.x) as value, a, b from dbt.fct_retail_sale')).toEqual({
      expression: 'sum(fct.x)',
      dimensions: ['a', 'b'],
      relation: 'dbt.fct_retail_sale',
    })
    expect(parseSelectSql('select 1 as value from "fct_x"')).toEqual({
      expression: '1',
      dimensions: [],
      relation: 'fct_x',
    })
    expect(parseSelectSql('not sql')).toEqual({ expression: '', dimensions: [], relation: '' })
  })

  it('parseSelectSql 兼容 L2 expr 的嵌套产物（取内层真实关系）', () => {
    const sql = 'select sum(t.value) as value from (select sum(fct_retail_sale.net_amount) as value from fct_retail_sale) t'
    expect(parseSelectSql(sql)).toEqual({
      expression: 'sum(t.value)',
      dimensions: [],
      relation: 'fct_retail_sale',
    })
  })

  it('parseSystemMapSemantics 对坏 YAML 不抛（空结构）', () => {
    expect(parseSystemMapSemantics('metrics: [oops').metrics.size).toBe(0)
    expect(parseSystemMapSemantics(null).entities.size).toBe(0)
  })
})
