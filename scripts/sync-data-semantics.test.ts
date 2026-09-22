// sync-data-semantics.test.ts — sync 脚本**纯函数**的单测（不连库；写库行为由 Task 8 的
// 「连跑两遍幂等」实跑证据 + 真库上的集成验证覆盖）。
//
// 本文件钉两件事，都是「两侧必须同源」的契约：
//   ① **形状契约两侧同源**：sync 物化出的 select_sql 必须能被 `domain/semantic-compiler.ts`
//      的 `parseL1Select` 解析通过。这两处是同一份形状的写侧与读侧——一旦漂开，
//      L2 编译点会对**所有**租户失效（而它只会在「某租户建 L2 指标时」暴露，离因很远）。
//   ② 差集分类正确：删/改/增/未变四态判错，会让 sync 要么漏删（脏词表）要么反复重写。
//
// T9 的 `--check` 模式（dry-run + 有 diff 即 exit 1）与 check-data-models 的 L2 同源断言
// **不在这里**——那是 T9 的面，本文件只覆盖本脚本自己的纯函数。
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSelectSql,
  declarationsFromYaml,
  deriveRelation,
  diffDeclarations,
  readDeclarations,
} from './sync-data-semantics.mjs'
import { parseL1Select } from '../modules/data/domain/semantic-compiler.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const yaml = (metrics: unknown[]) => ({ version: 1, metrics })

describe('declarationsFromYaml：语义事实源 → L1 行', () => {
  it('读**仓内真实事实源**：两个指标都在，字段映射齐（id/title/description/subjectColumn）', () => {
    const rows = readDeclarations(ROOT)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.has('retail:net_sales')).toBe(true)
    expect(byId.has('retail:order_count')).toBe(true)
    expect(byId.get('retail:net_sales')).toMatchObject({
      title: '净销售额',
      subjectColumn: 'org',
      requiredScope: null,
      groupBy: 'system_book, bizday',
    })
  })

  it('★ 形状契约两侧同源：sync 物化的每一条都能被唯一编译点解析（写侧↔读侧）', () => {
    const rows = readDeclarations(ROOT)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // 解析失败即抛（parseL1Select 是 fail-closed 的）——过了这里就说明两侧没漂
      const shape = parseL1Select(row.selectSql)
      expect(shape.relation, `指标 ${row.id} 的关系名没从表达式里取出来`).toBeTruthy()
      expect(row.selectSql.startsWith('select ')).toBe(true)
      // 口径表达式逐字保留（L2 靠这个保证「不改 L1 口径」）
      expect(row.selectSql).toContain('sum(fct_retail_sale.')
    }
  })

  it('label 缺省回落到 name（title 不许是空串：管理面靠它认指标）', () => {
    const rows = declarationsFromYaml(yaml([
      { name: 'x:y', definition: 'd', expression: 'sum(t.c)', grain: ['g'], owner: 'o', tier: 'certified' },
    ]))
    expect(rows[0].title).toBe('x:y')
  })

  it('grain 为空数组 ⇒ 抛（grain 同时是 L2 的维度白名单来源，空 = 什么都不能裁）', () => {
    expect(() => declarationsFromYaml(yaml([
      { name: 'x:y', definition: 'd', expression: 'sum(t.c)', grain: [], owner: 'o', tier: 'certified' },
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
    expect(() => deriveRelation('count(*)', 'x:y')).toThrow(/关系\.列/)
  })

  it('buildSelectSql 的两种形态（有/无维度）', () => {
    expect(buildSelectSql('sum(t.c)', ['a', 'b'], 't')).toBe('select sum(t.c) as value, a, b from t')
    expect(buildSelectSql('sum(t.c)', [], 't')).toBe('select sum(t.c) as value from t')
  })
})

describe('diffDeclarations：双向差集的四态分类', () => {
  const row = (id: string, title: string) => ({
    id, title, description: '', requiredScope: null,
    subjectColumn: 'org', selectSql: 'select sum(t.c) as value from t', groupBy: 'g', params: {},
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

  it('内容比对不含时间戳类字段（sync 每次都刷 updated_at，拿它比会把「未变」全判成「更新」）', () => {
    const withTs = declared.map((r) => ({ ...r, created_at: new Date(0), updated_at: new Date(1) }))
    const newer = declared.map((r) => ({ ...r, created_at: new Date(0), updated_at: new Date(9) }))
    expect(diffDeclarations(withTs, newer).updated).toEqual([])
    expect(diffDeclarations(withTs, newer).unchanged.length).toBe(3)
  })
})
