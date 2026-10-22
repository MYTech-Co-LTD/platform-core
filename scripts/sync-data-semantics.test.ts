// sync-data-semantics.test.ts — sync 脚本**纯函数**的单测（不连库；写库行为由 Task 8 的
// 「连跑两遍幂等」实跑证据 + 真库上的集成验证覆盖）。
//
// 本文件钉两件事，都是「两侧必须同源」的契约：
//   ① **形状契约两侧同源**：sync 物化出的 select_sql 必须能被 `domain/semantic-compiler.ts`
//      的 `parseL1Select` 解析通过。这两处是同一份形状的写侧与读侧——一旦漂开，
//      L2 编译点会对**所有**租户失效（而它只会在「某租户建 L2 指标时」暴露，离因很远）。
//   ② 差集分类正确：删/改/增/未变四态判错，会让 sync 要么漏删（脏词表）要么反复重写。
//
// ③ **命令行面**（T8 评审 I1）：`--check` 是不是真 dry-run、未知 flag 会不会被静默忽略、
//    出口码怎么分。这三个纯函数（`parseArgs` / `usageError` / `exitCodeFor`）+ `formatDiff`
//    是本文件的第三组断言——`--check` 是 **T9 的门禁要消费的东西**，它的语义必须在**这里**被钉住。
//    ⚠️ 「`--check` 真的不写库」这条**不**在本文件里（本文件不连库，这是既有约定）：
//    它的硬证据是任务报告里对真库的前后行数实测。本文件钉的是机制（模式解析 + 出口码 +
//    打印器同源），实跑钉的是效果——把真库 spawn 用例塞进单测反而危险：sync 的删除侧
//    （`deleteStaleL1Metrics`）会清掉平台桶里不在仓内声明集中的行，而那正是
//    metric-store/metrics 等测试文件并行的 L1 夹具（跨文件擦数据，症状是随机红）。
// check-data-models 的 L2 同源断言**不在这里**——那是 T9 的面。
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXIT_DRIFT,
  EXIT_OK,
  EXIT_USAGE,
  MODE_CHECK,
  MODE_DRY_RUN,
  MODE_HELP,
  MODE_WRITE,
  applyDefaultMaskTier,
  buildSelectSql,
  declarationsFromYaml,
  deriveParams,
  deriveFreshnessRelations,
  deriveRelation,
  deriveTotalable,
  additivityOf,
  composeOf,
  diffDeclarations,
  drillOf,
  drillTripleOf,
  exitCodeFor,
  formatDiff,
  measuresOf,
  parseArgs,
  readDeclarations,
  usageError,
  usageText,
} from './sync-data-semantics.mjs'
import { parseL1Select } from '../modules/data/domain/semantic-compiler.ts'
// 默认档的豁免码：**从写侧同一个常量取**（别在测试里另写一份字面量）——被断言的值与被合成的值
// 必须是同一个来源，否则「改了常量、测试照绿」。
import { DEFAULT_TIER_SCOPE } from '../modules/data/domain/authz.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const yaml = (metrics: unknown[]) => ({ version: 1, metrics })

describe('declarationsFromYaml：语义事实源 → L1 行', () => {
  it('读**仓内真实事实源**：两个指标都在，字段映射齐（id/title/description/subjectColumn）', () => {
    const rows = readDeclarations(ROOT)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.has('lemeng:retail:net_sales')).toBe(true)
    expect(byId.has('lemeng:retail:order_count')).toBe(true)
    expect(byId.get('lemeng:retail:net_sales')).toMatchObject({
      title: '净销售额',
      subjectColumn: 'org',
      requiredScope: null,
      // 2026-10-12 W0：粒度随 #430 口径定案扩到门店（账套 × 业务日 × 门店）
      groupBy: 'system_book, bizday, branch_num',
    })
  })

  it('★ 声明的 `source`（源系统）→ `sourceSystem`（源维度进声明面；L1 行恒有源）', () => {
    // ⚠️ 与既有的 `sources`（对象存储路径，选填、人读）不是一回事：这里映射的是**源系统**。
    const rows = declarationsFromYaml(yaml([
      {
        name: 'x:y:z', source: 'lemeng', definition: 'd', expression: 'sum(t.c)',
        grain: ['g'], owner: 'o', tier: 'certified', freshness_sla_days: 1,
      },
    ]))
    expect(rows[0].sourceSystem).toBe('lemeng')
    // 仓内真实事实源的两条声明都带上了源（否则物化出的 L1 行没有源维度）
    for (const row of readDeclarations(ROOT)) expect(row.sourceSystem, `${row.id} 没有源`).toBe('lemeng')
  })

  it('★ 形状契约两侧同源：sync 物化的每一条都能被唯一编译点解析（写侧↔读侧）', () => {
    const rows = readDeclarations(ROOT)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // 解析失败即抛（parseL1Select 是 fail-closed 的）——过了这里就说明两侧没漂
      const shape = parseL1Select(row.selectSql)
      expect(shape.relation, `指标 ${row.id} 的关系名没从表达式里取出来`).toBeTruthy()
      expect(row.selectSql.startsWith('select ')).toBe(true)
      // 口径表达式逐字保留（L2 靠这个保证「不改 L1 口径」）——W1 起声明跨多个 fct，
      // 断言改为「表达式逐字在产物里」（而不是钉死某一个模型的列）。
      const expr = row.selectSql.slice('select '.length, row.selectSql.indexOf(' as value'))
      expect(row.selectSql).toContain(expr)
      expect(expr.length).toBeGreaterThan(0)
    }
  })

  it('★ 问数参数面逐条断言（spec 2026-10-15 §4.1，真实事实源）：bizday/system_book 必在；grain 含 domain 的恰含 domain；白名单外一个不进', () => {
    // 为什么钉真实 YAML：D1–D4 钉的是推导函数（合成 grain），钉不住「声明本身改了 grain
    // 把参数面静默改丢」——参数面是物化产物，漏推导不报错，只表现为线上问不出区间。
    // 这条对**仓内每一条**声明逐行核对（期望集从声明自己的 grain 推，不硬编码条数——
    // 加指标/改 grain 本测试自动跟着改，删列才红）。
    const rows = readDeclarations(ROOT)
    expect(rows.length).toBeGreaterThan(0)
    let withDomain = 0
    for (const row of rows) {
      // groupBy = grain.join(', ')（见 declarationsFromYaml），反推即得 grain
      const grain = row.groupBy === '' ? [] : row.groupBy.split(', ')
      expect(row.params.bizday, `${row.id} 缺 bizday 参数`).toEqual({ column: 'bizday', type: 'date_range' })
      expect(row.params.system_book, `${row.id} 缺 system_book 参数`).toEqual({ column: 'system_book', type: 'string' })
      if (grain.includes('domain')) {
        withDomain++
        expect(row.params.domain, `${row.id} grain 含 domain 却没出参数`).toEqual({ column: 'domain', type: 'string' })
      } else {
        expect(row.params.domain, `${row.id} grain 不含 domain 却出了参数`).toBeUndefined()
      }
      for (const name of Object.keys(row.params)) {
        expect(['bizday', 'system_book', 'domain'], `${row.id} 出现白名单外参数 ${name}`).toContain(name)
      }
    }
    // domain 不是全量维度（2026-10-15 清点：出库/批发族才有）——「恰好」的口径要有实证数：
    // 至少一条有、且不是全部都有，否则上面那个分支就退化成恒真式。
    expect(withDomain).toBeGreaterThan(0)
    expect(withDomain).toBeLessThan(rows.length)
  })

  it('label 缺省回落到 name（title 不许是空串：管理面靠它认指标）', () => {
    const rows = declarationsFromYaml(yaml([
      { name: 'x:y:z', source: 'lemeng', definition: 'd', expression: 'sum(t.c)', grain: ['g'], owner: 'o', tier: 'certified', freshness_sla_days: 1 },
    ]))
    expect(rows[0].title).toBe('x:y:z')
  })

  it('★ 声明缺 `source` ⇒ 抛（不许落字符串 "undefined"：源维度坏了，该指标对所有租户静默不可见）', () => {
    // 为什么这条要 fail-closed：`String(undefined)` 是**非空**字符串 ⇒ 不拦的话行照落、sync 照报成功，
    // 而消费侧的裁剪拿 `'undefined'` 去与「已接入源」比对 ⇒ 永远不匹配 ⇒ 指标查不出来且不报错。
    expect(() => declarationsFromYaml(yaml([
      { name: 'x:y:z', definition: 'd', expression: 'sum(t.c)', grain: ['g'], owner: 'o', tier: 'certified' },
    ]))).toThrow(/source/)
  })

  it('★ `source` 全为空白 / 首尾带空白 ⇒ 抛（逐字比对 ⇒ 带空白落库后该指标静默查不出来）', () => {
    // 与上一条同一类失效，只是触发条件收窄：门禁侧 `asText` 会先 trim（故门禁校验的是 `lemeng`），
    // 若本脚本原样落库，库里的值就与「已接入源」的登记值对不上 ⇒ 静默不可见。这里**拒绝**而不是 trim。
    for (const bad of ['   ', ' lemeng ', 'lemeng ', ' lemeng']) {
      expect(
        () => declarationsFromYaml(yaml([
          { name: 'x:y:z', source: bad, definition: 'd', expression: 'sum(t.c)', grain: ['g'], owner: 'o', tier: 'certified' },
        ])),
        `source: ${JSON.stringify(bad)} 没被拦下`,
      ).toThrow(/source/)
    }
  })

  it('grain 为空数组 ⇒ 抛（grain 同时是 L2 的维度白名单来源，空 = 什么都不能裁）', () => {
    expect(() => declarationsFromYaml(yaml([
      { name: 'x:y:z', definition: 'd', expression: 'sum(t.c)', grain: [], owner: 'o', tier: 'certified' },
    ]))).toThrow(/grain/)
  })

  it('指标名不合命名空间形态 ⇒ 抛（与门禁规则 ⑥ 同一句，这里是兜底）', () => {
    expect(() => declarationsFromYaml(yaml([
      { name: 'NoColon', definition: 'd', expression: 'sum(t.c)', grain: ['g'], owner: 'o', tier: 'certified' },
    ]))).toThrow(/命名空间/)
  })

  it('顶层不是对象 / 缺 metrics ⇒ 抛（不去猜一个空声明集——那会把 L1 词表整个删空）', () => {
    expect(() => declarationsFromYaml(null)).toThrow()
    expect(() => declarationsFromYaml({ version: 1 })).toThrow(/metrics/)
  })
})

describe('deriveRelation：从 expression 反推 FROM 关系名', () => {
  it('单关系：取限定前缀', () => {
    expect(deriveRelation('sum(fct_retail_sale.net_amount)', 'x')).toBe('fct_retail_sale')
  })

  it('schema 限定：前缀整段保留', () => {
    expect(deriveRelation('sum(dbt.fct_x.amount)', 'x')).toBe('dbt.fct_x')
  })

  it('多个关系 ⇒ 抛（单条声明的 select_sql 只有一个 FROM）', () => {
    expect(() => deriveRelation('sum(a.x) / sum(b.y)', 'x')).toThrow(/多个关系/)
  })

  it('无限定引用（如 count(*)）⇒ 抛，且错误信息说清该怎么做', () => {
    expect(() => deriveRelation('count(*)', 'x:y:z')).toThrow(/关系\.列/)
  })

  it('buildSelectSql 的两种形态（有/无维度）', () => {
    expect(buildSelectSql('sum(t.c)', ['a', 'b'], 't')).toBe('select sum(t.c) as value, a, b from t')
    expect(buildSelectSql('sum(t.c)', [], 't')).toBe('select sum(t.c) as value from t')
  })
})

describe('deriveTotalable —— 可加判定（spec §8.4：表达式形状的保守机械规则）', () => {
  it('三态：sum( 开头 ⇒ true；count(distinct …) ⇒ false；比率形状（… / nullif(…, 0)）⇒ false', () => {
    expect(deriveTotalable('sum(fct_retail_sale.net_amount)')).toBe(true)
    expect(deriveTotalable('  sum( fct_x.amount )')).toBe(true)       // 前导空白 / 括号前空格都算
    expect(deriveTotalable('SUM(fct_x.amount)')).toBe(true)           // 大小写不敏感
    expect(deriveTotalable('sum(fct_a.x) - sum(fct_a.y)')).toBe(true) // 可加指标的差（purchase:net_amount 实文形态）
    expect(deriveTotalable('count(distinct fct_purchase.supplier_num)')).toBe(false)
    expect(deriveTotalable('count(*)')).toBe(false)
    // ⚠️ 关键负样本：ratio 物化形状是 `sum(…) / nullif(sum(…), 0)`——**它也以 `sum(` 开头**。
    // 只认前缀会把四条比率指标全判成可加（自动合计直接给出错数）。除法形状必须排除。
    expect(deriveTotalable('sum(fct_a.g_gross) / nullif(sum(fct_a.r_net), 0)')).toBe(false)
    expect(deriveTotalable('')).toBe(false)
  })

  it('★ additivity 压过形状：stock / non_additive 一律 false（消费面 spec §12.3）', () => {
    // 关键负样本：**形状可加、语义不可加**——存量（日快照）的 expression 也是 sum(列)，
    // 跨时间求和无业务含义。只看形状会把它判成可加，问「近 7 天库存合计」= 7 天快照相加。
    expect(deriveTotalable('sum(fct_inventory_snapshot.inventory_quantity)')).toBe(true)          // 缺省 flow
    expect(deriveTotalable('sum(fct_inventory_snapshot.inventory_quantity)', 'stock')).toBe(false)
    expect(deriveTotalable('sum(fct_x.amount)', 'non_additive')).toBe(false)
    expect(deriveTotalable('count(*)', 'flow')).toBe(false)                                        // 形状仍然生效
  })

  it('★ additivity 拼错必须响亮失败（不是静默按 flow）', () => {
    expect(additivityOf(undefined, 'm')).toBe('flow')
    expect(additivityOf('stock', 'm')).toBe('stock')
    expect(() => additivityOf('stocks', 'm')).toThrow(/不在 flow\|stock\|non_additive/)
  })

  it('★ 真 YAML 逐条断言（spec §8.4，真实事实源）：恰 27 条可加；十六条比率/去重计数/max/存量不给合计', () => {
    // 为什么钉真实 YAML：totalable 是物化产物，漏推导/推错不报错，只表现为线上多带或
    // 少带一个合计。期望集按各指标 expression 实文核对（比率用 ratio: 声明、去重计数用
    // count(distinct …)）——加指标时改这里的集合，两条计数会替你兜住条数漂移。
    const rows = readDeclarations(ROOT)
    const NOT_TOTALABLE = new Set([
      'lemeng:outbound:gross_margin_rate',       // ratio（毛利率）
      'lemeng:transfer:batch_fill_rate',         // ratio（填写率）
      'lemeng:transfer:item_gross_margin_rate',  // ratio（商品毛利率）
      'lemeng:purchase:supplier_count',          // count(distinct)——跨行求和 = 供应商·天数，错
      'lemeng:purchase:item_count',              // count(distinct)
      'lemeng:purchase:return_rate',             // ratio（采购退货率）
      'lemeng:contribution:margin_rate',         // ratio（费用后贡献率）
      'lemeng:client_contribution:margin_rate',  // ratio（客户费用后贡献率）
      'lemeng:expense:loss_rate',                // ratio（补损率）
      'lemeng:expense:subsidy_rate',             // ratio（补贴率）
      'lemeng:purchase:cr5',                     // ratio（供应商集中度）
      'lemeng:request:day_fulfillment_rate',     // ratio（满足率）
      // max(…)：连续天数是**单店状态值**，跨行求和 = 天数相加，无意义（03-05）
      'lemeng:retail:consecutive_no_sales_days',
      // 存量（additivity: stock，消费面 spec §12.3）：日快照跨时间求和无业务含义
      'lemeng:inventory:quantity',
      'lemeng:inventory:money',
      // 带除法的 expression：cur/pri − 1，跨行求和无意义（01-05）
      'lemeng:retail:comparable_growth_rate',
    ])
    for (const row of rows) {
      expect(row.totalable, `${row.id} 的 totalable 与 expression 形状不符`).toBe(!NOT_TOTALABLE.has(row.id))
    }
    // 「恰好」要有实证数：不是全体都可加、也不是全体都不可加
    expect(rows.filter((r) => r.totalable === true).length, '可加条数（加/改指标时重核）').toBe(27)
    expect(rows.filter((r) => r.totalable === false).length).toBe(16)
    // 抽样钉两条形态极值（brief 点名）
    expect(rows.find((r) => r.id === 'lemeng:retail:net_sales')?.totalable).toBe(true)
    expect(rows.find((r) => r.id === 'lemeng:transfer:batch_fill_rate')?.totalable).toBe(false)
  })
})

describe('diffDeclarations：双向差集的四态分类', () => {
  const row = (id: string, title: string, sourceSystem: string | null = 'lemeng') => ({
    id, title, description: '', requiredScope: null,
    subjectColumn: 'org', selectSql: 'select sum(t.c) as value from t', groupBy: 'g', params: {}, sourceSystem,
    totalable: false, slaDays: 1, freshnessRelations: [] as string[], masks: null,
    drillExpr: null, drillDims: null, drillDetail: null,
  })
  const declared = [row('a', 'A'), row('b', 'B2'), row('c', 'C')]
  const current = [row('a', 'A'), row('b', 'B1'), row('d', 'D')]

  it('新增 = 声明有库里没有；更新 = 同 id 但内容不同；未变 = 内容逐字相同；删除 = 库里有声明没有', () => {
    const diff = diffDeclarations(declared, current)
    expect(diff.added).toEqual(['c'])
    expect(diff.updated).toEqual(['b'])
    expect(diff.unchanged).toEqual(['a'])
    expect(diff.removed).toEqual(['d'])
  })

  it('幂等的判据面：同一份声明对同一份现状 ⇒ 四态全空（第二次重跑不该产生任何写）', () => {
    const diff = diffDeclarations(declared, declared.map((r) => ({ ...r })))
    expect(diff.added).toEqual([])
    expect(diff.updated).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged.length).toBe(3)
  })

  it('★ 参数键序不影响判等（#700）：jsonb 读回键序被 PG 重排 ⇒ 不回一会恒判「更新」', () => {
    // 现场：写完再 --check 也回不到无漂移（对已物化库恒报「更新 27」）。根因=PG 的 jsonb 按
    // （长度, 字节序）存键，读回来的 params 键序与声明侧的对象字面量不同；comparableOf 直接
    // stringify ⇒ 恒不等 ⇒ 漂移信号退化成「狼来了」，真漂移来了也没人信。
    const P_STR = {
      bizday: { column: 'bizday', type: 'date_range' },
      system_book: { column: 'system_book', type: 'string' },
    } as const
    const declaredP = [{ ...row('a', 'A'), params: P_STR }]
    // 库侧读回：外层与内层键序都被重排（内容一字未改）
    const fromDb = [{
      ...row('a', 'A'),
      params: {
        system_book: { type: 'string', column: 'system_book' },
        bizday: { type: 'date_range', column: 'bizday' },
      },
    } as const]
    const diff = diffDeclarations(declaredP, fromDb)
    expect(diff.updated).toEqual([])
    expect(diff.unchanged).toEqual(['a'])
    // 反向对照：参数**内容**变了仍须判「更新」——规范化不许把真漂移吃掉
    const P_NUM = {
      bizday: { column: 'bizday', type: 'date_range' },
      system_book: { column: 'system_book', type: 'number' },
    } as const
    expect(diffDeclarations(declaredP, [{ ...row('a', 'A'), params: P_NUM }]).updated).toEqual(['a'])
  })

  it('内容比对不含时间戳类字段（sync 每次都刷 updated_at，拿它比会把「未变」全判成「更新」）', () => {
    const withTs = declared.map((r) => ({ ...r, created_at: new Date(0), updated_at: new Date(1) }))
    const newer = declared.map((r) => ({ ...r, created_at: new Date(0), updated_at: new Date(9) }))
    expect(diffDeclarations(withTs, newer).updated).toEqual([])
    expect(diffDeclarations(withTs, newer).unchanged.length).toBe(3)
  })

  it('★ 改了声明的 source 而库里没跟上 ⇒ 判为「更新」（漂移可比；缺这条 --check 会假绿）', () => {
    // 这条用例存在的理由：`--check` 的全部价值是「声明的变化能被检出」。
    // `sourceSystem` 若**不进** comparableOf，改了声明的 source 而库里还是旧值 ⇒ 判「未变」
    // ⇒ 门禁报「无漂移」（假绿），而库里的源维度已经与声明分叉。
    const declaredSrc = [row('a', 'A', 'lemeng')]
    const currentOld = [row('a', 'A', 'legacy_erp')]
    expect(diffDeclarations(declaredSrc, currentOld)).toMatchObject({
      added: [], updated: ['a'], removed: [], unchanged: [],
    })
    // 反向对照：source 一致 ⇒ 仍然判「未变」（否则「可比」会退化成「恒判更新」）
    expect(diffDeclarations(declaredSrc, [row('a', 'A', 'lemeng')]).unchanged).toEqual(['a'])
  })

  it('★ totalable 进 comparableOf：声明与库内不一致 ⇒ 判「更新」（缺这条 --check 假绿）', () => {
    // spec §8.4：totalable 是物化面的一部分——声明推导出了 true 而库里还是 false（首次
    // 加列后的常态）必须被 --check 检出，否则可加指标永远拿不到自动合计且无任何信号。
    const declaredT = [{ ...row('a', 'A'), totalable: true }]
    expect(diffDeclarations(declaredT, [row('a', 'A')]).updated).toEqual(['a'])
    // 反向对照：两侧一致（含同为 true）⇒ 判「未变」
    expect(diffDeclarations(declaredT, [{ ...row('a', 'A'), totalable: true }]).unchanged).toEqual(['a'])
  })

  it('★ slaDays / freshnessRelations 进 comparableOf：新鲜度链路变了 ⇒ 判「更新」（spec §10.7）', () => {
    // spec §10.7：SLA/关系集是物化面的一部分——声明改了而库内还是旧值必须被 --check 检出，
    // 否则水位/固定行永远按旧链路算且门禁假绿。
    const declaredSla = [{ ...row('a', 'A'), slaDays: 2 }]
    expect(diffDeclarations(declaredSla, [row('a', 'A')]).updated).toEqual(['a'])
    const declaredRels = [{ ...row('a', 'A'), freshnessRelations: ['stg_lemeng_retail_order_line'] }]
    expect(diffDeclarations(declaredRels, [row('a', 'A')]).updated).toEqual(['a'])
    // 反向对照：两侧一致 ⇒ 判「未变」（可比不退化成恒更新）
    expect(diffDeclarations(declaredSla, [{ ...row('a', 'A'), slaDays: 2 }]).unchanged).toEqual(['a'])
    expect(diffDeclarations(declaredRels, [{ ...row('a', 'A'), freshnessRelations: ['stg_lemeng_retail_order_line'] }]).unchanged)
      .toEqual(['a'])
  })
})

describe('命令行面：模式解析（T8 评审 I1）', () => {
  it('不给模式 = write（默认是**写库**）；--check / --dry-run / --help(-h) 各自成模式', () => {
    expect(parseArgs([]).mode).toBe(MODE_WRITE)
    expect(parseArgs(['--dry-run']).mode).toBe(MODE_DRY_RUN)
    expect(parseArgs(['--check']).mode).toBe(MODE_CHECK)
    expect(parseArgs(['--help']).mode).toBe(MODE_HELP)
    expect(parseArgs(['-h']).mode).toBe(MODE_HELP)
  })

  it('★ --check 不是写模式（改前它根本不被识别 ⇒ 打了 --check 实际进写模式）', () => {
    const args = parseArgs(['--check'])
    expect(args.mode).not.toBe(MODE_WRITE)
    expect(args.unknown, '--check 被当成未知参数').toEqual([])
  })

  it('★ 未知 flag 一律拒绝：--check 打成 --chekc 不许静默变成写库', () => {
    const args = parseArgs(['--chekc'])
    expect(args.unknown).toEqual(['--chekc'])
    expect(args.mode, '未知 flag 掉进了写模式').toBe(MODE_WRITE)
    expect(usageError(args)).toMatch(/未知参数 --chekc/)
    // 支持项必须列全（否则调用方只能猜/去翻源码）
    const msg = usageError(args) ?? ''
    for (const flag of ['--check', '--dry-run', '--help']) expect(msg).toContain(flag)
  })

  it('模式互斥：--check --dry-run ⇒ 用法错（静默取第一个会让语义取决于参数顺序）', () => {
    expect(usageError(parseArgs(['--check', '--dry-run']))).toMatch(/互斥/)
    expect(usageError(parseArgs(['--check']))).toBeNull()
    expect(usageError(parseArgs(['--dry-run']))).toBeNull()
    expect(usageError(parseArgs([]))).toBeNull()
  })

  it('--help 优先于其它模式（--check --help = 看说明，不是跑检查）', () => {
    expect(parseArgs(['--check', '--help']).mode).toBe(MODE_HELP)
    expect(usageError(parseArgs(['--check', '--help']))).toBeNull()
  })

  it('--help 正文写明「会不会写库」与退出码含义（默认模式 = 写库必须显式说出来）', () => {
    const text = usageText()
    expect(text).toMatch(/不给模式 = \*\*写库\*\*/)
    expect(text).toMatch(/不写库/)
    expect(text).toMatch(/退出码/)
    for (const flag of ['--check', '--dry-run', '--help']) expect(text).toContain(flag)
  })
})

describe('命令行面：出口码与 diff 打印器（T8 评审 I1 / T9 消费）', () => {
  const noDrift = { added: [], updated: [], removed: [], unchanged: ['a', 'b'] }
  const added = { ...noDrift, added: ['x'] }
  const updated = { ...noDrift, updated: ['x'] }
  const removed = { ...noDrift, removed: ['x'] }

  it('★ --check：三种漂移全判非 0（新增/更新/删除任一都算漂移）；无漂移 ⇒ 0', () => {
    for (const diff of [added, updated, removed]) {
      expect(exitCodeFor(MODE_CHECK, diff), `${JSON.stringify(diff)} 没被判成漂移`).toBe(EXIT_DRIFT)
    }
    expect(exitCodeFor(MODE_CHECK, noDrift)).toBe(EXIT_OK)
  })

  it('--dry-run 恒 0（它不是门禁，头注写着）；write 模式也恒 0（失败走异常路径）', () => {
    expect(exitCodeFor(MODE_DRY_RUN, added)).toBe(EXIT_OK)
    expect(exitCodeFor(MODE_WRITE, added)).toBe(EXIT_OK)
  })

  it('用法错的出口码与「检出漂移」**不同**（否则 T9 会把手误读成漂移）', () => {
    expect(EXIT_USAGE).not.toBe(EXIT_DRIFT)
    expect(EXIT_USAGE).not.toBe(EXIT_OK)
  })

  it('formatDiff：--check 与 --dry-run 共用同一个打印器（计数摘要 + 每行一条漂移）', () => {
    expect(formatDiff({ added: ['a'], updated: ['b'], removed: ['c'], unchanged: ['d', 'e'] }))
      .toEqual(['新增 1 / 更新 1 / 删除 1 / 未变 2', '  + a', '  ~ b', '  - c'])
    expect(formatDiff(noDrift)).toEqual(['新增 0 / 更新 0 / 删除 0 / 未变 2'])
  })
})

describe('ratio 声明（与 expression 互斥，spec 2026-10-12 §5.3）', () => {
  const base = {
    name: 'lemeng:retail:test_rate',
    label: '率夹具',
    definition: '测试夹具：不可加，上滚=重算。',
    grain: ['system_book', 'bizday'],
    owner: 'data-platform',
    tier: 'experimental',
    source: 'lemeng',
    freshness_sla_days: 1,
  }

  it('ratio 只给分子分母时，物化出 nullif 除法表达式（零分母 → 不适用）', () => {
    const rows = declarationsFromYaml(
      yaml([{ ...base, ratio: {
        numerator: 'sum(fct_retail_sale.net_amount)',
        denominator: 'sum(fct_retail_sale.order_count)',
      } }]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].selectSql).toBe(
      'select sum(fct_retail_sale.net_amount) / nullif(sum(fct_retail_sale.order_count), 0) as value, system_book, bizday from fct_retail_sale',
    )
  })

  it('ratio 与 expression 同时给 → 响亮拒绝（两处各写一份口径 = 两处事实源）', () => {
    expect(() =>
      declarationsFromYaml(
        yaml([{ ...base, expression: 'sum(fct_retail_sale.net_amount)', ratio: {
          numerator: 'sum(fct_retail_sale.net_amount)', denominator: 'sum(fct_retail_sale.order_count)',
        } }]),
      ),
    ).toThrow(/互斥/)
  })

  it('ratio 缺分子或缺分母 → 响亮拒绝', () => {
    expect(() =>
      declarationsFromYaml(yaml([{ ...base, ratio: { numerator: 'sum(fct_retail_sale.net_amount)' } }])),
    ).toThrow(/denominator|分母/)
    expect(() =>
      declarationsFromYaml(yaml([{ ...base, ratio: { denominator: 'sum(fct_retail_sale.order_count)' } }])),
    ).toThrow(/numerator|分子/)
  })

  it('ratio 分子分母引用不同关系 → 响亮拒绝（复用 deriveRelation 的单一关系约束）', () => {
    expect(() =>
      declarationsFromYaml(
        yaml([{ ...base, ratio: {
          numerator: 'sum(fct_retail_sale.net_amount)', denominator: 'sum(fct_wholesale_out.r_net)',
        } }]),
      ),
    ).toThrow(/多个关系/)
  })

  it('ratio 里带分号 → 响亮拒绝（写侧先拦，不等读侧 parseL1Select）', () => {
    expect(() =>
      declarationsFromYaml(
        yaml([{ ...base, ratio: {
          numerator: 'sum(fct_retail_sale.net_amount); drop table x',
          denominator: 'sum(fct_retail_sale.order_count)',
        } }]),
      ),
    ).toThrow(/分号/)
  })

  it('ratio 物化出的 select_sql 仍过读侧形状契约（parseL1Select，同源性既有约定）', () => {
    const rows = declarationsFromYaml(
      yaml([{ ...base, ratio: {
        numerator: 'sum(fct_retail_sale.net_amount)',
        denominator: 'sum(fct_retail_sale.order_count)',
      } }]),
    )
    expect(() => parseL1Select(rows[0].selectSql)).not.toThrow()
  })
})

describe('deriveFreshnessRelations —— 新鲜度关系集推导（spec §10.7.3）', () => {
  it('单源：取路径段 lemeng/<资产> ⇒ stg_lemeng_<资产>（命名约定即仓内事实）', () => {
    expect(deriveFreshnessRelations([
      's3://<bucket>/lemeng/retail_order_line/system_book=<账套>/bizday=<日期>/hour=<时>/all.parquet',
    ])).toEqual(['stg_lemeng_retail_order_line'])
  })

  it('多源取全部（保序去重）：outbound 的三段路径 ⇒ 三个关系', () => {
    expect(deriveFreshnessRelations([
      's3://<bucket>/lemeng/transfer_out/system_book=<账套>/bizday=<日期>/all.parquet',
      's3://<bucket>/lemeng/wholesale_out/system_book=<账套>/bizday=<日期>/all.parquet',
      's3://<bucket>/lemeng/wholesale_return/system_book=<账套>/bizday=<日期>/all.parquet',
    ])).toEqual(['stg_lemeng_transfer_out', 'stg_lemeng_wholesale_out', 'stg_lemeng_wholesale_return'])
    // 同资产重复声明 ⇒ 去重（木桶短板只算一次）
    expect(deriveFreshnessRelations([
      's3://b/lemeng/inventory_snapshot/x/all.parquet',
      's3://b/lemeng/inventory_snapshot/y/all.parquet',
    ])).toEqual(['stg_lemeng_inventory_snapshot'])
  })

  it('无 sources（undefined / 空数组）⇒ 空数组（= 无自动水位，响应字段缺席，不猜）', () => {
    expect(deriveFreshnessRelations(undefined)).toEqual([])
    expect(deriveFreshnessRelations([])).toEqual([])
  })

  it('路径里没有 lemeng/ 段 ⇒ 抛（命名约定推导不出来的，宁可响亮失败也不瞎猜关系名）', () => {
    expect(() => deriveFreshnessRelations(['s3://bucket/other_source/t/all.parquet'])).toThrow(/lemeng/)
  })

  it('资产段形态不合规（空 / 大写 / 带点）⇒ 抛（要拼进 SQL 标识符的名字必须是安全形状）', () => {
    expect(() => deriveFreshnessRelations(['s3://b/lemeng//all.parquet'])).toThrow(/资产/)
    expect(() => deriveFreshnessRelations(['s3://b/lemeng/Retail/all.parquet'])).toThrow(/资产/)
    expect(() => deriveFreshnessRelations(['s3://b/lemeng/a.b/all.parquet'])).toThrow(/资产/)
  })
})

describe('declarationsFromYaml：freshness_sla_days（spec §10.7.1，缺声明响亮失败）', () => {
  const base = {
    name: 'x:y:z', source: 'lemeng', definition: 'd', expression: 'sum(t.c)',
    grain: ['g'], owner: 'o', tier: 'certified',
  }

  it('合法值 → slaDays 物化；sources → freshnessRelations 推导', () => {
    const rows = declarationsFromYaml(yaml([
      { ...base, freshness_sla_days: 2, sources: ['s3://b/lemeng/inventory_snapshot/x/all.parquet'] },
    ]))
    expect(rows[0].slaDays).toBe(2)
    expect(rows[0].freshnessRelations).toEqual(['stg_lemeng_inventory_snapshot'])
  })

  it('缺 freshness_sla_days ⇒ 抛（27 条必须全部显式声明，不许静默默认——默认值会让新指标永远「未知」且无人发现）', () => {
    expect(() => declarationsFromYaml(yaml([base]))).toThrow(/freshness_sla_days/)
  })

  it('非非负整数（小数/负数/字符串）⇒ 抛（它是状态转译的算术判据，垃圾值 = 判错且不报错）', () => {
    for (const bad of [1.5, -1, '2', true, null]) {
      expect(
        () => declarationsFromYaml(yaml([{ ...base, freshness_sla_days: bad }])),
        `freshness_sla_days: ${JSON.stringify(bad)} 没被拦`,
      ).toThrow(/freshness_sla_days/)
    }
  })
})

describe('declarationsFromYaml：required_scope（列级授权声明面，spec 2026-10-17 §4.2）', () => {
  const base = {
    name: 'x:y:z', source: 'lemeng', definition: 'd', expression: 'sum(t.c)',
    grain: ['g'], owner: 'o', tier: 'certified', freshness_sla_days: 1,
  }

  it('缺声明 ⇒ null（与 2026-10-17 之前的恒 null 行为一致，不改变任何既有指标的可见性）', () => {
    expect(declarationsFromYaml(yaml([base]))[0].requiredScope).toBeNull()
  })

  it('显式 null ⇒ null', () => {
    expect(declarationsFromYaml(yaml([{ ...base, required_scope: null }]))[0].requiredScope).toBeNull()
  })

  it('合法码 ⇒ 原样物化（不做任何归一，权限码是逐字比对）', () => {
    expect(declarationsFromYaml(yaml([{ ...base, required_scope: 'data:cost' }]))[0].requiredScope)
      .toBe('data:cost')
  })

  it('空串 / 纯空白 ⇒ 抛（空白码谁也匹配不上 ⇒ 该指标对所有人静默不可见）', () => {
    for (const bad of ['', '   ', '\t']) {
      expect(
        () => declarationsFromYaml(yaml([{ ...base, required_scope: bad }])),
        `required_scope: ${JSON.stringify(bad)} 没被拦`,
      ).toThrow(/required_scope/)
    }
  })

  it('首尾带空白 ⇒ 抛（**不 trim**：trim 等于替作者改声明，而库里存的值必须与声明逐字相同）', () => {
    for (const bad of [' data:cost', 'data:cost ', ' data:cost ']) {
      expect(
        () => declarationsFromYaml(yaml([{ ...base, required_scope: bad }])),
        `required_scope: ${JSON.stringify(bad)} 没被拦`,
      ).toThrow(/required_scope/)
    }
  })

  it('非字符串（YAML 裸数字/布尔）⇒ 抛（强转会造出一个不存在的码）', () => {
    for (const bad of [123, true]) {
      expect(
        () => declarationsFromYaml(yaml([{ ...base, required_scope: bad }])),
        `required_scope: ${JSON.stringify(bad)} 没被拦`,
      ).toThrow(/required_scope/)
    }
  })
})

describe('真 YAML：43 条 sla_days / freshnessRelations 逐条断言（spec §10.7.1/10.7.3，真实事实源）', () => {
  // 为什么钉真实 YAML：sla_days 是人工登记值（不是推导产物），漏登记/登错不报错，只表现为
  // 线上状态转译错。逐字断言 + 计数兜底（加指标时这两条会替你守住「新指标必须显式登记」）。
  const rows = readDeclarations(ROOT)
  // 2026-10-18 按实测发布时钟重新标定（issue #849）：sla_days 的语义就是「T+N 可用」，
  // 采集窗口落在上海 00:25/00:35（刚过午夜）⇒ 除零售（tick 每 5 分钟）外都够不到 T+1。
  const SLA3 = new Set(['lemeng:inventory:quantity', 'lemeng:inventory:money'])
  const SLA1 = new Set([
    'lemeng:retail:sales', 'lemeng:retail:net_sales', 'lemeng:retail:order_count',
    'lemeng:retail:net_quantity', 'lemeng:retail:consecutive_no_sales_days',
    'lemeng:retail:comparable_growth_rate',
    // 2026-10-21（issue #965）：明细透传指标，读同一份 retail_order_line 湖资产 ⇒ 与上面六条同档。
    'lemeng:retail:order_line',
  ])

  it('恰 43 条；inventory 两指标 sla_days=3、retail 七条=1、其余 34 条=2（按实测发布时钟标定，#849）', () => {
    expect(rows.length).toBe(43)
    for (const row of rows) {
      const want = SLA3.has(row.id) ? 3 : SLA1.has(row.id) ? 1 : 2
      expect(row.slaDays, `${row.id} 的 sla_days 与标定不符`).toBe(want)
    }
    expect(rows.filter((r) => r.slaDays === 3).length).toBe(2)
    expect(rows.filter((r) => r.slaDays === 2).length).toBe(34)
    expect(rows.filter((r) => r.slaDays === 1).length).toBe(7)
  })

  it('freshnessRelations 与声明 sources 推导逐字一致；没声明 sources 的 = 空（无自动水位）', () => {
    const DECLARED_SOURCES = {
      'lemeng:retail:net_sales': ['stg_lemeng_retail_order_line'],
      'lemeng:retail:sales': ['stg_lemeng_retail_order_line'],
      'lemeng:retail:order_count': ['stg_lemeng_retail_order_line'],
      'lemeng:retail:net_quantity': ['stg_lemeng_retail_order_line'],
      'lemeng:retail:consecutive_no_sales_days': ['stg_lemeng_retail_order_line'],
      'lemeng:retail:comparable_growth_rate': ['stg_lemeng_retail_order_line'],
      // 2026-10-21（issue #965）：明细透传指标，读 retail_order_line 湖资产
      'lemeng:retail:order_line': ['stg_lemeng_retail_order_line'],
      'lemeng:outbound:net_amount': ['stg_lemeng_transfer_out', 'stg_lemeng_wholesale_out', 'stg_lemeng_wholesale_return'],
      'lemeng:expense:branch_payable': ['stg_lemeng_branch_expense'],
      'lemeng:expense:client_payable': ['stg_lemeng_client_expense'],
      'lemeng:inventory:quantity': ['stg_lemeng_inventory_snapshot'],
      'lemeng:purchase:amount': ['stg_lemeng_item_purchase'],
      'lemeng:purchase:return_rate': ['stg_lemeng_item_purchase'],
      'lemeng:purchase:zero_amount_rows': ['stg_lemeng_item_purchase'],
      // 组合族 W2：全域口径挂四源（出库三份 + 门店费用），门店域口径只挂两源
      // （transfer + 门店费用）——推导按声明的 sources 逐字走，不在这里放宽。
      'lemeng:contribution:net_amount': ['stg_lemeng_transfer_out', 'stg_lemeng_wholesale_out', 'stg_lemeng_wholesale_return', 'stg_lemeng_branch_expense'],
      'lemeng:contribution:margin_rate': ['stg_lemeng_transfer_out', 'stg_lemeng_wholesale_out', 'stg_lemeng_wholesale_return', 'stg_lemeng_branch_expense'],
      'lemeng:contribution:region_net': ['stg_lemeng_transfer_out', 'stg_lemeng_branch_expense'],
      'lemeng:contribution:region_l1_net': ['stg_lemeng_transfer_out', 'stg_lemeng_branch_expense'],
      // 客户级组合族（#744 甲方案）：批发出库/退货 + 客户费用三源
      'lemeng:client_contribution:net_amount': ['stg_lemeng_wholesale_out', 'stg_lemeng_wholesale_return', 'stg_lemeng_client_expense'],
      'lemeng:client_contribution:margin_rate': ['stg_lemeng_wholesale_out', 'stg_lemeng_wholesale_return', 'stg_lemeng_client_expense'],
      'lemeng:expense:loss_rate': ['stg_lemeng_transfer_out', 'stg_lemeng_branch_expense'],
      'lemeng:expense:subsidy_rate': ['stg_lemeng_transfer_out', 'stg_lemeng_branch_expense'],
      // 组合族 W3：只声明采购源。**刻意不声明 dim_item**——路径段推导出的关系名是
      // `stg_lemeng_dim_item`，而实际 staging 叫 `stg_lemeng_item`（对不上 ⇒ 水位恒未知）。
      'lemeng:purchase:cr5': ['stg_lemeng_item_purchase'],
      // ── 2026-10-17 补齐：此前 20 条没声明 sources ⇒ 固定新鲜度行只能出「未知」。
      //    逐条按各指标真实读的湖资产补；**dim_* 一律不列**（推导出的关系名与实际 staging 对不上）。
      'lemeng:outbound:gross_profit': ['stg_lemeng_transfer_out', 'stg_lemeng_wholesale_out', 'stg_lemeng_wholesale_return'],
      'lemeng:outbound:gross_margin_rate': ['stg_lemeng_transfer_out', 'stg_lemeng_wholesale_out', 'stg_lemeng_wholesale_return'],
      'lemeng:outbound:order_count': ['stg_lemeng_transfer_out', 'stg_lemeng_wholesale_out'],
      'lemeng:outbound:line_count': ['stg_lemeng_transfer_out', 'stg_lemeng_wholesale_out'],
      'lemeng:transfer:batch_fill_rate': ['stg_lemeng_transfer_out'],
      'lemeng:transfer:item_gross_margin_rate': ['stg_lemeng_transfer_out'],
      'lemeng:transfer:negative_order_count': ['stg_lemeng_transfer_out'],
      'lemeng:transfer:zero_cost_exposure_amount': ['stg_lemeng_transfer_out'],
      'lemeng:expense:branch_net': ['stg_lemeng_branch_expense'],
      'lemeng:expense:branch_receivable': ['stg_lemeng_branch_expense'],
      'lemeng:expense:client_net': ['stg_lemeng_client_expense'],
      'lemeng:expense:client_receivable': ['stg_lemeng_client_expense'],
      'lemeng:inventory:money': ['stg_lemeng_inventory_snapshot'],
      'lemeng:purchase:net_amount': ['stg_lemeng_item_purchase'],
      'lemeng:purchase:present_amount': ['stg_lemeng_item_purchase'],
      'lemeng:purchase:return_amount': ['stg_lemeng_item_purchase'],
      'lemeng:purchase:supplier_count': ['stg_lemeng_item_purchase'],
      'lemeng:purchase:item_count': ['stg_lemeng_item_purchase'],
      'lemeng:request:quantity': ['stg_lemeng_request_order', 'stg_lemeng_transfer_in'],
      'lemeng:request:day_fulfillment_rate': ['stg_lemeng_request_order', 'stg_lemeng_transfer_in'],
    }
    for (const row of rows) {
      const expected = DECLARED_SOURCES[row.id as keyof typeof DECLARED_SOURCES] ?? []
      expect(row.freshnessRelations, `${row.id} 的 freshness_relations 与 sources 推导不一致`).toEqual(expected)
    }
    // 推导一致性：**43 条全部**声明了 sources（2026-10-17 补齐前是 15 条，另 20 条水位恒未知）。
    // 计数兜底保留：以后新增指标若忘声明 sources，下面的 43 会立刻红。
    expect(rows.filter((r) => (r.freshnessRelations ?? []).length > 0).length).toBe(43)
    expect(rows.filter((r) => (r.freshnessRelations ?? []).length === 0).length).toBe(0)
  })
})

describe('deriveParams —— 问数参数面白名单推导（spec 2026-10-15 §2.2）', () => {
  it('D1 全维 grain → 只剩白名单三件，参数名=列名', () => {
    expect(deriveParams(['system_book', 'bizday', 'domain', 'branch_num', 'region_id'])).toEqual({
      bizday: { column: 'bizday', type: 'date_range' },
      system_book: { column: 'system_book', type: 'string' },
      domain: { column: 'domain', type: 'string' },
    })
  })
  it('D2 无 domain 的 grain → 两件（bizday + system_book）', () => {
    expect(deriveParams(['system_book', 'bizday', 'branch_num'])).toEqual({
      bizday: { column: 'bizday', type: 'date_range' },
      system_book: { column: 'system_book', type: 'string' },
    })
  })
  it('D3 编码维度一个不进（branch_num/item_num/supplier_num/storehouse_num/client_fid/region_id/expense_type/other_inout_kind）', () => {
    const p = deriveParams(['system_book', 'bizday', 'branch_num', 'storehouse_num', 'item_num', 'client_fid', 'supplier_num', 'region_id', 'expense_type', 'other_inout_kind'])
    expect(Object.keys(p).sort()).toEqual(['bizday', 'system_book'])
  })
  it('D4 required 恒缺省（空参=全量，历史调用形态不破坏）', () => {
    expect(Object.values(deriveParams(['system_book', 'bizday', 'domain'])).every((p) => p.required === undefined)).toBe(true)
  })
})

describe('declarationsFromYaml：mask（值级脱敏声明面，spec 2026-10-17 §5.2）', () => {
  // expression 决定 selectSql = `select sum(fct_x.net_amount) as value, g from fct_x`
  // —— mask 的 column 出现性以它为比对基准。
  const base = {
    name: 'x:y:z', source: 'lemeng', definition: 'd', expression: 'sum(fct_x.net_amount)',
    grain: ['g'], owner: 'o', tier: 'certified', freshness_sla_days: 1,
  }

  it('缺声明 ⇒ masks = null（未声明；默认档由 `readDeclarations`/`applyDefaultMaskTier` 合成，本纯函数不推）', () => {
    expect(declarationsFromYaml(yaml([base]))[0].masks).toBeNull()
    expect(declarationsFromYaml(yaml([{ ...base, mask: null }]))[0].masks).toBeNull()
  })

  it('合法 round（column 在 selectSql 里）⇒ 逐字物化（含 step；不做任何归一）', () => {
    const rows = declarationsFromYaml(yaml([
      { ...base, mask: [{ column: 'fct_x.net_amount', kind: 'round', step: 1000, grantedBy: 'data:precise' }] },
    ]))
    expect(rows[0].masks).toEqual([
      { column: 'fct_x.net_amount', kind: 'round', step: 1000, grantedBy: 'data:precise' },
    ])
  })

  it('★ 手写整值声明（column: null / column 键缺省 / 整值配 round）⇒ 一律拒（spec §5.3.1 R10 配套 2；#830）', () => {
    // 变异确认锚点 C：删掉 maskItemError 的整值拒绝 ⇒ **恰好**本用例红（本用例是唯一能红的一条）。
    // 本任务之前这里断言的是「被接受并物化」——那是旧世界（YAML 写得出手写整值）；
    // 现在整值形态只由默认档合成，手写它等于重开 #820 同型洞。
    for (const mask of [
      { column: null, kind: 'nullify', grantedBy: 'data:precise' },
      { kind: 'nullify', grantedBy: 'data:precise' },   // column 缺省 = null（整值）
      { column: null, kind: 'round', step: 1000, grantedBy: 'p' },   // 整值 + round 同样拒
    ]) {
      expect(
        () => declarationsFromYaml(yaml([{ ...base, mask: [mask] }])),
        `mask: ${JSON.stringify(mask)} 没被拦`,
      ).toThrow(/整值/)
    }
  })

  it('nullify 带多余 step ⇒ step 被剥掉（nullify 无步长概念，不落一个没人读的键进库）', () => {
    const rows = declarationsFromYaml(yaml([
      { ...base, mask: [{ column: 'fct_x.net_amount', kind: 'nullify', step: 100, grantedBy: 'p' }] },
    ]))
    expect(rows[0].masks).toEqual([{ column: 'fct_x.net_amount', kind: 'nullify', grantedBy: 'p' }])
  })

  it('mask 写成非数组 ⇒ 抛（写错形状的掩码静默不生效，宁响亮勿静默）', () => {
    for (const bad of ['round', 42, { kind: 'nullify', grantedBy: 'p' }]) {
      expect(
        () => declarationsFromYaml(yaml([{ ...base, mask: bad }])),
        `mask: ${JSON.stringify(bad)} 没被拦`,
      ).toThrow(/mask/)
    }
  })

  it('未知 kind ⇒ 抛（词表是代码常量 MASK_KINDS，能选不能扩——写错的 kind 不报错也不生效）', () => {
    for (const kind of ['bucket', 'truncate', 'ROUND', '']) {
      expect(
        () => declarationsFromYaml(yaml([{ ...base, mask: [{ column: 'fct_x.net_amount', kind, step: 1000, grantedBy: 'p' }] }])),
        `kind: ${JSON.stringify(kind)} 没被拦`,
      ).toThrow(/kind/)
    }
  })

  it('round 缺 step / step 非正整数 ⇒ 抛（运行期展开成 round(col, -step)，坏 step 到查询时才炸）', () => {
    for (const step of [undefined, 0, -1000, 1.5, '1000', null]) {
      const item: Record<string, unknown> = { column: 'fct_x.net_amount', kind: 'round', grantedBy: 'p' }
      if (step !== undefined) item.step = step
      expect(
        () => declarationsFromYaml(yaml([{ ...base, mask: [item] }])),
        `step: ${JSON.stringify(step ?? null)} 没被拦`,
      ).toThrow(/step/)
    }
  })

  it('grantedBy 空 / 带空白 ⇒ 抛（逐字比对的豁免码，带空白谁也匹配不上 ⇒ 对持码人照掩不误）', () => {
    for (const grantedBy of ['', '   ', 'data precise', 'data:precise ']) {
      expect(
        () => declarationsFromYaml(yaml([{ ...base, mask: [{ column: 'fct_x.net_amount', kind: 'nullify', grantedBy }] }])),
        `grantedBy: ${JSON.stringify(grantedBy)} 没被拦`,
      ).toThrow(/grantedBy/)
    }
  })

  it('未知键 ⇒ 抛（键闭集 {column, kind, step, grantedBy}——拼错的键会被静默忽略）', () => {
    expect(() => declarationsFromYaml(yaml([
      { ...base, mask: [{ column: 'fct_x.net_amount', kind: 'nullify', grantedBy: 'p', edges: [1, 2] }] },
    ]))).toThrow(/未知键|edges/)
  })

  it('★ column 不在 selectSql 里 ⇒ 抛（运行期定点替换命中不了 ⇒ 掩码静默不生效——本设计最怕的形态）', () => {
    // 变异确认锚点：去掉 masksOf 里的「column 须逐字在 selectSql 里」检查 ⇒ **恰好**本用例红。
    expect(() => declarationsFromYaml(yaml([
      { ...base, mask: [{ column: 'fct_y.cost_money', kind: 'nullify', grantedBy: 'p' }] },
    ]))).toThrow(/selectSql|逐字/)
  })

  it('★ 维度/grain 列不许按列掩码 ⇒ 抛（运行期会撞 must appear in GROUP BY；C-m3，#824）', () => {
    // grain 含 net_amount ⇒ 口径表达式与维度表引用的是**同一列**：运行期展开会把维度表那一处
    // 也换成掩码表达式，而 GROUP BY 仍是原列名 ⇒ SQL 报「must appear in GROUP BY」（运行期才炸）。
    const g = { ...base, grain: ['net_amount'] }
    expect(declarationsFromYaml(yaml([g]))[0].masks).toBeNull()   // 不声明掩码 ⇒ 照常（只拦掩码声明）
    expect(() => declarationsFromYaml(yaml([
      { ...g, mask: [{ column: 'fct_x.net_amount', kind: 'round', step: 1000, grantedBy: 'p' }] },
    ]))).toThrow(/维度\/grain/)
  })

  it('★ column 只命中固定别名位 `value` ⇒ 抛（运行期跳过别名 ⇒ 静默不掩码 = fail-open；T2-m3②）', () => {
    // `… as value` 是形状契约的记号、不是列引用：运行期的按列展开跳过它（mask.ts），
    // 若这里仍把别名算作「逐字出现在 selectSql 里」，这类声明会过闸而运行期一个都不掩。
    expect(() => declarationsFromYaml(yaml([
      { ...base, mask: [{ column: 'value', kind: 'nullify', grantedBy: 'p' }] },
    ]))).toThrow(/selectSql|逐字/)
  })

  it('★ masks 进 comparableOf：声明带了掩码而库内没跟上 ⇒ 判「更新」（缺这条 --check 假绿）', () => {
    // 掩码声明变了而库内没刷 = 掩码静默按旧声明生效（安全面）——必须被 --check 检出。
    const row = (masks: Array<{ column: string | null; kind: 'round' | 'nullify'; step?: number; grantedBy: string }> | null) => ({
      id: 'a', title: 'A', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(t.c) as value from t', groupBy: 'g', params: {}, sourceSystem: 'lemeng',
      totalable: false, slaDays: 1, freshnessRelations: [] as string[], masks,
      drillExpr: null, drillDims: null, drillDetail: null,
    })
    const declared = [row([{ column: 't.c', kind: 'round', step: 1000, grantedBy: 'data:precise' }])]
    expect(diffDeclarations(declared, [row(null)]).updated).toEqual(['a'])
    // 反向对照：两侧一致 ⇒ 判「未变」（可比不退化成恒更新；jsonb 键序由 canonical 兜住）
    const fromDb = [row([{ grantedBy: 'data:precise', step: 1000, kind: 'round', column: 't.c' }])]
    expect(diffDeclarations(declared, fromDb).unchanged).toEqual(['a'])
  })
})

describe('applyDefaultMaskTier —— 默认档合成（spec §4.1.1 裁决；issue #821）', () => {
  // ⚠️ 夹具**必须内联**、不得依赖生产数据：本仓今天**零** `reads`、**零** `sensitivity !== 'none'`
  // 的契约列（下一条用例正是钉这个零）⇒ 拿真仓当夹具的话本组断言全是恒真式，默认档将来静默失效
  // 也没人知道。夹具行 = `declarationsFromYaml` 产物的**最小形状**（默认档只读这三件：
  // `reads` / `selectSql` / `masks`）。
  const row = (
    reads: string[] | null,
    masks: Array<{ column: string | null; kind: 'round' | 'nullify'; step?: number; grantedBy: string }> | null,
  ) => ({
    id: 'x:y:z', title: 'Z', description: '', requiredScope: null, subjectColumn: 'org',
    selectSql: 'select sum(fct_x.net_amount) as value, g from fct_x',
    groupBy: 'g', params: {}, sourceSystem: 'lemeng', totalable: false, slaDays: 1,
    freshnessRelations: [] as string[], masks, reads,
  })
  const sensitive = (col: string) => new Map([[col, 'pii']])

  it('★ 今天真仓零 reads 零 sensitivity ⇒ 默认档合成 0 条（零行为变更）', () => {
    // 这条是「本任务不改变今天的任何产物」的硬证据：加了默认档而真仓仍合成 0 条 ⇒
    // `--check` 无漂移、库内 masks 一个不变。将来给源列打了 sensitivity、或给指标补了 reads，
    // 这条会红——**那是预期**（默认档开始生效），届时改断言而不是删断言。
    const rows = readDeclarations(ROOT)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => (r.masks ?? []).every((s) => s.grantedBy !== DEFAULT_TIER_SCOPE))).toBe(true)
  })

  it('读了敏感列且无列键命中 ⇒ 合成整值 nullify（严档：整个值都不给）', () => {
    const rows = applyDefaultMaskTier(
      [row(['lemeng.retail_order_line.sale_money'], null)],
      sensitive('lemeng.retail_order_line.sale_money'),
    )
    expect(rows[0].masks).toEqual([{ column: null, kind: 'nullify', grantedBy: DEFAULT_TIER_SCOPE }])
    // 整值形态 = column 为 null（运行期把 `… as value` 整个换成 typed NULL）——**不是**按列。
    expect(rows[0].masks[0].column).toBeNull()
  })

  it('读了敏感列但列键命中 ⇒ 不叠加（① 优先于 ②，spec §5.2）', () => {
    // 全仓任一 metric 有 column 非 null 的声明、且该列出现在**本行**的 selectSql 里 ⇒ 默认档不叠加。
    const declarer = row(null, [{ column: 'fct_x.net_amount', kind: 'round', step: 1000, grantedBy: 'p' }])
    const reader = row(['lemeng.retail_order_line.sale_money'], null)
    const rows = applyDefaultMaskTier([declarer, reader], sensitive('lemeng.retail_order_line.sale_money'))
    expect(rows[1].masks).toBeNull()   // 未叠加（原对象原样返回）
  })

  it('reads 全是 none 列 ⇒ 不合成（没读敏感列就不套默认档）', () => {
    const rows = applyDefaultMaskTier(
      [row(['lemeng.retail_order_line.sale_money'], null)],
      new Map([['lemeng.retail_order_line.sale_money', 'none']]),
    )
    expect(rows[0].masks).toBeNull()
  })

  it('reads 含不存在的列 ⇒ 不合成（未声明 sensitivity 的按 none 计）', () => {
    const rows = applyDefaultMaskTier(
      [row(['lemeng.retail_order_line.no_such_col'], null)],
      sensitive('lemeng.retail_order_line.sale_money'),
    )
    expect(rows[0].masks).toBeNull()
  })

  it('已声明按列掩码的行不因默认档被改写（叠加只发生在 masks 为空的行上）', () => {
    const declared = [{ column: 'fct_x.net_amount', kind: 'round' as const, step: 1000, grantedBy: 'p' }]
    const rows = applyDefaultMaskTier(
      [row(['lemeng.retail_order_line.sale_money'], declared)],
      sensitive('lemeng.retail_order_line.sale_money'),
    )
    expect(rows[0].masks).toEqual(declared)
  })
})

// ── 下钻编译（Task 6，spec 2026-10-21 §2.3）：compose→drill_expr、dims/detail 三键、comparableOf 第六组 ──
// 门禁（check-data-models 规则 ⑤⑥）是声明形状的 CI 权威；这里的判据是 **sync 侧兜底**——
// 本脚本会被手跑（不经 CI），取不到/说不准就响亮失败，绝不静默物化一个坏下钻。
describe('declarationsFromYaml：下钻编译（measures + compose，spec 2026-10-21 §2.3）', () => {
  const base = {
    name: 'lemeng:retail:net_sales', label: 't', definition: 'd', source: 'lemeng',
    expression: 'sum(fct_retail_sale.net_amount)',
    grain: ['system_book', 'bizday', 'branch_num'], owner: 'o', tier: 'certified', freshness_sla_days: 1,
  }
  const dims = ['system_book', 'bizday', 'branch_num', 'order_no']
  const detail = { relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'" }

  it('compose：组件引用替换为括号包裹的组件体', () => {
    // ⚠️ 对计划的一处**逐字偏离**（本文件唯一）：计划 Step-1 期望串写的是
    // `((sum(x)) - (sum(y)))`，但同计划 Step-3 的 composeOf（逐字采纳）是「每引用替换为
    // `(<组件体>)`、不整串再包」——体自带括号时会得到 `((sum(x))) - (sum(y))`。取实现为准：
    // 整串的括号由 Task 7 `buildDrillSql` 的 `(${expr})` 再包，终态 SQL 恰为已落地不变量
    // （assert_drill_net_sales_matches_fct）atomic_value 的两层括号形状
    // `((case…) - (sum(case…)))`；若在这里再整串包一层，终态会多出第三层（无害但无典）。
    const rows = declarationsFromYaml({
      measures: { 'sale_amount@order': '(sum(x))', 'return_amount@line': 'sum(y)' },
      metrics: [{ ...base, compose: 'sale_amount@order - return_amount@line', dimensions: dims, detail }],
    })
    expect(rows[0].drillExpr).toBe('((sum(x))) - (sum(y))')
    expect(rows[0].drillDims).toEqual(['system_book', 'bizday', 'branch_num', 'order_no'])
    expect(rows[0].drillDetail).toEqual({ relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'" })
  })

  it('compose 引用未声明组件 ⇒ 响亮失败', () => {
    expect(() => declarationsFromYaml({
      metrics: [{ ...base, compose: 'ghost@order', dimensions: ['system_book'],
        detail: { relation: 'vw_x', filter: 'true' } }],
    })).toThrow(/未声明的度量组件/)
  })

  it('compose 含乘除/数字等文法外记号 ⇒ 响亮失败', () => {
    expect(() => declarationsFromYaml({
      metrics: [{ ...base, compose: 'sale_amount@order * 2', dimensions: dims, detail }],
    })).toThrow(/文法外|组件引用与/)
  })

  it('文法检查先于引用替换：未知引用与文法外记号同时在场 ⇒ 报文法（先挡记号，再谈引用）', () => {
    expect(() => declarationsFromYaml({
      metrics: [{ ...base, compose: 'ghost@order * 2', dimensions: dims, detail }],
    })).toThrow(/文法外/)
  })

  it('未声明 compose ⇒ 三字段 null（聚合照旧）', () => {
    const rows = declarationsFromYaml(yaml([base]))
    expect(rows[0].drillExpr).toBeNull()
    expect(rows[0].drillDims).toBeNull()
    expect(rows[0].drillDetail).toBeNull()
  })

  it('半套声明（compose 在、dimensions/detail 缺）⇒ 行级半键（同现判据在 def 组装面兜底，见 drillOf）', () => {
    // 行组装面按键各自判缺省（null = 未声明），「三键同现」由写库前的 drillOf 兜手跑——
    // 门禁的同现规则（check-data-models 规则 ⑥）是 CI 权威，行组装面不重复抛。
    const rows = declarationsFromYaml({
      measures: { 'sale_amount@order': 'sum(x)' },
      metrics: [{ ...base, compose: 'sale_amount@order' }],
    })
    expect(rows[0].drillExpr).toBe('(sum(x))')
    expect(rows[0].drillDims).toBeNull()
    expect(rows[0].drillDetail).toBeNull()
  })

  it('dimensions/detail 形状坏 ⇒ 各自落 null（不猜、不半物化）', () => {
    const rows = declarationsFromYaml({
      measures: { 'sale_amount@order': 'sum(x)' },
      metrics: [
        { ...base, compose: 'sale_amount@order', dimensions: [], detail },
        { ...base, compose: 'sale_amount@order', dimensions: [123], detail },
        { ...base, compose: 'sale_amount@order', dimensions: dims, detail: 'vw_x' },
        { ...base, compose: 'sale_amount@order', dimensions: dims, detail: { relation: 'vw_x' } },
      ],
    })
    for (const r of rows) {
      expect(r.drillDims === null || r.drillDetail === null, JSON.stringify(r.drillDims)).toBe(true)
    }
  })

  it('★ 真事实源：net_sales 的下钻三键物化；未声明 compose 的指标全 null', () => {
    const rows = readDeclarations(ROOT)
    const byId = new Map(rows.map((r) => [r.id, r]))
    const net = byId.get('lemeng:retail:net_sales')
    expect(net?.drillDims).toEqual(['system_book', 'bizday', 'branch_num', 'order_no'])
    expect(net?.drillDetail).toEqual({ relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'" })
    // 组件体替换 + 括号包裹：sale 侧组件体在前（case when 判别式形态），return 在后，` - ` 连接
    expect(net?.drillExpr).toMatch(/^\(case when /)
    expect(net?.drillExpr).toMatch(/ - \(sum\(case when order_transaction_type like '%RETURN%'/)
    expect(net?.drillExpr).toMatch(/\)$/)
    for (const id of ['lemeng:retail:sales', 'lemeng:retail:order_count']) {
      expect(byId.get(id)?.drillExpr, `${id} 未声明 compose`).toBeNull()
    }
  })

  it('★ 下钻三键进 comparableOf：声明带了下钻而库内没跟上 ⇒ 判「更新」（缺这条 --check 假绿）', () => {
    const row = (drillExpr: string | null, drillDetail: { relation: string; filter: string } | null) => ({
      id: 'a', title: 'A', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(t.c) as value from t', groupBy: 'g', params: {}, sourceSystem: 'lemeng',
      totalable: false, slaDays: 1, freshnessRelations: [] as string[], masks: null,
      drillExpr, drillDims: drillExpr === null ? null : (['system_book', 'bizday'] as string[]), drillDetail,
    })
    const declared = [row('(sum(x))', { relation: 'vw_x', filter: 'true' })]
    expect(diffDeclarations(declared, [row(null, null)]).updated).toEqual(['a'])
    // 反向对照：两侧一致（jsonb 键序重排由 canonical 兜住）⇒ 判「未变」（可比不退化成恒更新）
    const fromDb = [row('(sum(x))', { filter: 'true', relation: 'vw_x' })]
    expect(diffDeclarations(declared, fromDb).unchanged).toEqual(['a'])
  })

  it('detail.columns：物化进 drillDetail；未声明时**不写键**（不是空数组）', () => {
    const cols = [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }]
    const withCols = declarationsFromYaml({
      metrics: [{ ...base, compose: 'a@b', dimensions: dims, detail: { ...detail, columns: cols } }],
      measures: { 'a@b': 'sum(x)' },
    })
    expect(withCols[0].drillDetail).toEqual({
      relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'", columns: cols,
    })

    const without = declarationsFromYaml({
      metrics: [{ ...base, compose: 'a@b', dimensions: dims, detail }],
      measures: { 'a@b': 'sum(x)' },
    })
    expect(without[0].drillDetail).toEqual({ relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'" })
  })

  it('detail.columns 形状坏 ⇒ 响亮失败（sync 手跑路径，不静默物化坏权限声明）', () => {
    const mk = (columns: unknown) => () => declarationsFromYaml({
      metrics: [{ ...base, compose: 'a@b', dimensions: dims, detail: { ...detail, columns } }],
      measures: { 'a@b': 'sum(x)' },
    })
    expect(mk([])).toThrow(/非空数组/)
    expect(mk([{ col: 'order_detail_std_price', granted_by: 'data:cost' }])).toThrow(/未知键/)
    expect(mk([{ col: 'system_book', grantedBy: 'data:cost' }])).toThrow(/dimensions/)
    expect(mk([{ col: 'value', grantedBy: 'data:cost' }])).toThrow(/value/)
    expect(mk([{ col: 'x_price', grantedBy: '' }])).toThrow(/grantedBy/)
    expect(mk([{ col: 'x_price', grantedBy: 'data:cost' }, { col: 'x_price', grantedBy: 'data:cost' }])).toThrow(/重复/)
  })

  it('drillOf / drillTripleOf 透传 columns（库侧不透传 ⇒ --check 恒报更新）', () => {
    const cols = [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }]
    const detailWithCols = { relation: 'vw_x', filter: 'true', columns: cols }
    expect(drillOf({
      id: 'a', title: 'A', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(t.c) as value from t', groupBy: 'g', params: {}, sourceSystem: 'lemeng',
      totalable: false, slaDays: 1, freshnessRelations: [], masks: null,
      drillExpr: '(sum(x))', drillDims: ['system_book'], drillDetail: detailWithCols,
    })?.columns).toEqual(cols)

    expect(drillTripleOf({ drill: { expr: '(sum(x))', dims: ['system_book'], relation: 'vw_x', filter: 'true', columns: cols } }))
      .toEqual({ drillExpr: '(sum(x))', drillDims: ['system_book'], drillDetail: detailWithCols })

    // 反向对照：未声明 ⇒ 两侧都不写键（否则恒不等）
    expect(drillTripleOf({ drill: { expr: '(sum(x))', dims: ['s'], relation: 'vw_x', filter: 'true' } }).drillDetail)
      .toEqual({ relation: 'vw_x', filter: 'true' })
  })
})

describe('measuresOf / composeOf —— 下钻编译的纯函数面（spec 2026-10-21 §2.3）', () => {
  it('measuresOf：缺省 ⇒ 空 Map；形状坏（数组 / 键不合 <snake>@<snake> / 空体 / 分号）⇒ 响亮失败', () => {
    expect(measuresOf({}).size).toBe(0)
    expect(measuresOf({ measures: undefined }).size).toBe(0)
    expect(measuresOf(null).size).toBe(0)
    expect(() => measuresOf({ measures: ['a@b'] })).toThrow(/映射/)
    expect(() => measuresOf({ measures: { 'Sale@b': 'sum(x)' } })).toThrow(/形态不合规/)
    expect(() => measuresOf({ measures: { 'a@b': '' } })).toThrow(/形态不合规/)
    expect(() => measuresOf({ measures: { 'a@b': 'sum(x); delete' } })).toThrow(/分号/)
    // 合法：剥首尾空白（YAML 折叠标量的常态），体原样进 Map
    expect(measuresOf({ measures: { 'a@b': '  sum(x)  ' } }).get('a@b')).toBe('sum(x)')
  })

  it('composeOf：括号包裹保优先级（(a) - (b) 形态）；文法检查先于引用替换；compose 缺省 ⇒ null', () => {
    const measures = measuresOf({ measures: { 'sale@x': 'sum(a)', 'return@y': 'sum(b)' } })
    expect(composeOf('sale@x - return@y', 'm:1:m', measures)).toBe('(sum(a)) - (sum(b))')
    // 乘除/数字/其它标识符 ⇒ 文法外（先于「未声明组件」被报告）
    expect(() => composeOf('ghost@x * 2', 'm:1:m', measures)).toThrow(/文法外/)
    expect(() => composeOf('ghost@x', 'm:1:m', measures)).toThrow(/未声明的度量组件/)
    expect(() => composeOf('', 'm:1:m', measures)).toThrow(/非空/)
    expect(() => composeOf('sale@x;', 'm:1:m', measures)).toThrow(/非空|分号/)
    expect(composeOf(undefined, 'm:1:m', measures)).toBeNull()
    expect(composeOf(null, 'm:1:m', measures)).toBeNull()
  })

  it('drillOf：三键全 null ⇒ undefined（drill 字段缺省，不造字面 null）；半套 ⇒ 同现判据响亮失败', () => {
    const row = (drillExpr: string | null, drillDims: string[] | null, drillDetail: { relation: string; filter: string } | null) => ({
      id: 'a', title: 'A', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(t.c) as value from t', groupBy: 'g', params: {}, sourceSystem: 'lemeng',
      totalable: false, slaDays: 1, freshnessRelations: [] as string[], masks: null,
      drillExpr, drillDims, drillDetail,
    })
    expect(drillOf(row(null, null, null))).toBeUndefined()
    expect(drillOf(row('(sum(x))', ['g'], { relation: 'vw_x', filter: 'true' })))
      .toEqual({ expr: '(sum(x))', dims: ['g'], relation: 'vw_x', filter: 'true' })
    // 半套三态：任一为 null 而另两个非 null ⇒ 抛（门禁同款判据，这里兜手跑）
    expect(() => drillOf(row('(sum(x))', null, { relation: 'vw_x', filter: 'true' }))).toThrow(/同现/)
    expect(() => drillOf(row(null, ['g'], { relation: 'vw_x', filter: 'true' }))).toThrow(/同现/)
    expect(() => drillOf(row('(sum(x))', ['g'], null))).toThrow(/同现/)
  })

  it('drillTripleOf：库行 drill 缺省 ⇒ 三键 null；有绑定 ⇒ 三键（dims 拷贝，detail 形状逐字）', () => {
    expect(drillTripleOf({})).toEqual({ drillExpr: null, drillDims: null, drillDetail: null })
    expect(drillTripleOf({ drill: undefined })).toEqual({ drillExpr: null, drillDims: null, drillDetail: null })
    const dims = ['system_book', 'bizday']
    const t = drillTripleOf({ drill: { expr: '(sum(x))', dims, relation: 'vw_x', filter: 'true' } })
    expect(t).toEqual({
      drillExpr: '(sum(x))', drillDims: ['system_book', 'bizday'],
      drillDetail: { relation: 'vw_x', filter: 'true' },
    })
    // dims 是拷贝不是引用：库行数组后续变更不得渗进比对行
    expect(t.drillDims).not.toBe(dims)
  })
})
