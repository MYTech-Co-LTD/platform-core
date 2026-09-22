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
  buildSelectSql,
  declarationsFromYaml,
  deriveRelation,
  diffDeclarations,
  exitCodeFor,
  formatDiff,
  parseArgs,
  readDeclarations,
  usageError,
  usageText,
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
