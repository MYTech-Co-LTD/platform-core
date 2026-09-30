// scripts/reconcile-tenant-sources.test.ts — 已接入源对账（平台登记 ↔ console 声明）**纯核**的 fixture 测试。
//
// 为什么只钉纯核、不跑真库：本脚本的价值全在「**哪一格红了**」——两侧的四种差集形态各一条用例，
// 变异掉任一判据都必须有**恰一条**用例变红（task-6-report.md 里两次变异的原始输出就是这条性质的证据）。
//
// 断言口径照 `scripts/check-data-models.test.ts` T11 格②（对账脚本在同仓的唯一先例）：
// 断言**桶的完整形状**（`toEqual` 整个对象/数组），不是 `length > 0`——后者在「桶塌成一个」
// 或「元素少了一个字段」时照样绿，而那正是这套对账要防的静默退化。
//
// ⚠️ 「元素字段恒在」也是**被断言的性质**（不是靠 JSDoc 口头保证）：`scripts/` 是 checkJs，
//    JSDoc 的字符串字面量类型会被加宽 ⇒ 可辨识联合在这里会静默失效（`check-data-models.mjs`
//    头注判断③同因）⇒ 桶内元素一律「字段恒在」，并有专门一条用例把这条钉住。
import { describe, expect, it } from 'vitest'
import { ADOPTED_SOURCES_PREFIX, diffSources, parseConsoleDecls } from './reconcile-tenant-sources.mjs'

/** 平台侧一行：`platform.tenant_source` join `platform.tenant`。 */
type PlatformRow = { org: string; source: string; enabled: boolean }

/** console 侧一条声明：某账套的 env 里列出了某源。 */
type ConsoleDecl = { console: string; source: string }

/** 出口形状（四桶 + clean）。 */
type SourceDiff = {
  missingInConsole: Array<{ org: string; source: string }>
  missingInPlatform: Array<{ console: string; source: string }>
  disabledButDeclared: Array<{ org: string; source: string; consoles: string[] }>
  declaredButDisabled: Array<{ console: string; source: string; orgs: string[] }>
  clean: boolean
}

const diff = (rows: PlatformRow[], decls: ConsoleDecl[]): SourceDiff =>
  diffSources(rows, decls) as SourceDiff

const EMPTY: SourceDiff = {
  missingInConsole: [],
  missingInPlatform: [],
  disabledButDeclared: [],
  declaredButDisabled: [],
  clean: true,
}

describe('diffSources：两侧一致 / 四条差集形态', () => {
  it('两侧一致（平台启用 lemeng + console 声明 lemeng）→ 四桶全空、clean', () => {
    expect(diff([{ org: 'shanhai-org', source: 'lemeng', enabled: true }], [{ console: '3120', source: 'lemeng' }]))
      .toEqual(EMPTY)
  })

  it('① 平台已启用、没有任何 console 声明 → 逐条列出（含多租户的两行）', () => {
    const d = diff(
      [
        { org: 'acme-org', source: 'lemeng', enabled: true },
        { org: 'beta-org', source: 'lemeng', enabled: true },
        { org: 'acme-org', source: 'woke', enabled: true },
      ],
      [{ console: '3120', source: 'woke' }],
    )
    // 逐行列出（哪几个租户的哪条登记没人声明），不是只给个计数
    expect(d.missingInConsole).toEqual([
      { org: 'acme-org', source: 'lemeng' },
      { org: 'beta-org', source: 'lemeng' },
    ])
    expect(d.missingInPlatform).toEqual([])
    expect(d.disabledButDeclared).toEqual([])
    expect(d.declaredButDisabled).toEqual([])
    expect(d.clean).toBe(false)
  })

  it('② console 声明、平台**一行都没有** → 逐条列出（「有人接了源没登记」的形态）', () => {
    const d = diff(
      [{ org: 'acme-org', source: 'lemeng', enabled: true }],
      [
        { console: '3120', source: 'lemeng' },
        { console: '3120', source: 'ghost' },
        { console: '64188', source: 'ghost' },
      ],
    )
    expect(d.missingInPlatform).toEqual([
      { console: '3120', source: 'ghost' },
      { console: '64188', source: 'ghost' },
    ])
    expect(d.missingInConsole).toEqual([])
    expect(d.clean).toBe(false)
  })

  it('③④ 整源停用（平台只有 enabled=false 的行）却仍被声明 → **两侧各报一次**（键空间不同）', () => {
    const d = diff(
      [
        { org: 'acme-org', source: 'lemeng', enabled: false },
        { org: 'beta-org', source: 'lemeng', enabled: false },
      ],
      [
        { console: '3120', source: 'lemeng' },
        { console: '64188', source: 'lemeng' },
      ],
    )
    // ③ 按**平台行**出：停在 enabled=false 的那几行（要恢复启用、或确认停用是有意的）
    expect(d.disabledButDeclared).toEqual([
      { org: 'acme-org', source: 'lemeng', consoles: ['3120', '64188'] },
      { org: 'beta-org', source: 'lemeng', consoles: ['3120', '64188'] },
    ])
    // ④ 按 **console 声明**出：打在「平台侧整源无启用」上的那几条 env（要登记、或从 env 摘掉）
    expect(d.declaredButDisabled).toEqual([
      { console: '3120', source: 'lemeng', orgs: ['acme-org', 'beta-org'] },
      { console: '64188', source: 'lemeng', orgs: ['acme-org', 'beta-org'] },
    ])
    expect(d.missingInConsole).toEqual([])
    expect(d.missingInPlatform).toEqual([])
    expect(d.clean).toBe(false)
  })

  it('③ 启停混合：有租户停用、也有租户启用 ⇒ 只报停用那几行；④（整源停用）**不**命中', () => {
    const d = diff(
      [
        { org: 'acme-org', source: 'lemeng', enabled: true },
        { org: 'beta-org', source: 'lemeng', enabled: false },
      ],
      [{ console: '3120', source: 'lemeng' }],
    )
    expect(d.disabledButDeclared).toEqual([{ org: 'beta-org', source: 'lemeng', consoles: ['3120'] }])
    // ④ 的判据是「平台侧**有没有**任何租户启用」⇒ 混合态不算「整源停用」，这条判据不许被放宽成「有停用行」
    expect(d.declaredButDisabled).toEqual([])
    expect(d.missingInConsole).toEqual([])
    expect(d.clean).toBe(false)
  })

  it('平台停用且**无人声明** → 四桶全空（停用与不声明是一致的，不是漂移）', () => {
    expect(diff([{ org: 'acme-org', source: 'lemeng', enabled: false }], [])).toEqual(EMPTY)
  })

  it('启停混合且**无人声明** → 只报①（启用的那行），③ 不命中（没人声明它）', () => {
    const d = diff(
      [
        { org: 'acme-org', source: 'lemeng', enabled: true },
        { org: 'beta-org', source: 'lemeng', enabled: false },
      ],
      [],
    )
    expect(d.missingInConsole).toEqual([{ org: 'acme-org', source: 'lemeng' }])
    expect(d.disabledButDeclared).toEqual([])
    expect(d.clean).toBe(false)
  })

  it('②④ 互斥：平台无行 ⇒ ②；平台上全是停用行 ⇒ ④（同一份声明不落两桶）', () => {
    const d = diff([{ org: 'acme-org', source: 'lemeng', enabled: false }], [{ console: '3120', source: 'lemeng' }])
    expect(d.missingInPlatform).toEqual([])
    expect(d.declaredButDisabled).toEqual([
      { console: '3120', source: 'lemeng', orgs: ['acme-org'] },
    ])
  })
})

describe('diffSources：元素字段恒在（checkJs 下不许靠联合类型表达）', () => {
  it('③④ 的元素**任何取值下都带全字段**（空 consoles/orgs 也以 [] 出现，不是缺键）', () => {
    const d = diff(
      [
        { org: 'acme-org', source: 'a', enabled: false },
        { org: 'acme-org', source: 'b', enabled: false },
      ],
      [{ console: '3120', source: 'a' }, { console: '64188', source: 'b' }],
    )
    for (const e of d.disabledButDeclared) expect(Object.keys(e).sort()).toEqual(['consoles', 'org', 'source'])
    for (const e of d.declaredButDisabled) expect(Object.keys(e).sort()).toEqual(['console', 'orgs', 'source'])
    // 两条停用行各进 ③ 一条（各自带上声明它的那个 console —— 一条可能对多个 console，故是数组）
    expect(d.disabledButDeclared).toEqual([
      { org: 'acme-org', source: 'a', consoles: ['3120'] },
      { org: 'acme-org', source: 'b', consoles: ['64188'] },
    ])
    // 反向：每条 ④ 的 orgs 恒是数组（哪怕只有一个租户）
    expect(d.declaredButDisabled.every((e) => Array.isArray(e.orgs))).toBe(true)
  })

  it('输入顺序不影响输出（对账输出要能逐字 diff，顺序不许随插入顺序抖）', () => {
    const rows: PlatformRow[] = [
      { org: 'b-org', source: 'lemeng', enabled: true },
      { org: 'a-org', source: 'lemeng', enabled: true },
      { org: 'c-org', source: 'woke', enabled: false },
    ]
    const decls: ConsoleDecl[] = [
      { console: '64188', source: 'woke' },
      { console: '3120', source: 'lemeng' },
    ]
    const shuffled = diff([...rows].reverse(), [...decls].reverse())
    expect(shuffled).toEqual(diff(rows, decls))
    expect(shuffled.disabledButDeclared).toEqual([
      { org: 'c-org', source: 'woke', consoles: ['64188'] },
    ])
  })

  it('重复喂进来的行/声明不会让桶里出现两遍（幂等）', () => {
    const row: PlatformRow = { org: 'acme-org', source: 'lemeng', enabled: true }
    const decl: ConsoleDecl = { console: '3120', source: 'ghost' }
    const d = diff([row, { ...row }], [decl, { ...decl }])
    expect(d.missingInConsole).toEqual([{ org: 'acme-org', source: 'lemeng' }])
    expect(d.missingInPlatform).toEqual([{ console: '3120', source: 'ghost' }])
  })
})

describe('parseConsoleDecls：console env 键 → 声明清单', () => {
  it('前缀键 → 账套号 + 逗号分隔的源（trim、去空、去重、排序）', () => {
    const parsed = parseConsoleDecls({
      [ADOPTED_SOURCES_PREFIX + '64188']: ' lemeng ',
      [ADOPTED_SOURCES_PREFIX + '3120']: 'woke,lemeng,, lemeng ,',
      PATH: '/usr/bin',
    })
    expect(parsed.consoles).toEqual(['3120', '64188'])
    expect(parsed.decls).toEqual([
      { console: '3120', source: 'lemeng' },
      { console: '3120', source: 'woke' },
      { console: '64188', source: 'lemeng' },
    ])
  })

  it('键在场但值为空 ⇒ **零条声明**（合法：该 console 确实一个源都没声明）', () => {
    const parsed = parseConsoleDecls({ [ADOPTED_SOURCES_PREFIX + '3120']: '' })
    expect(parsed.consoles).toEqual(['3120'])
    expect(parsed.decls).toEqual([])
  })

  it('没有任何前缀键 ⇒ consoles 为空（调用方据此判「对不成账」，见 main 的 exit 2）', () => {
    expect(parseConsoleDecls({ DATABASE_URL: 'postgres://x' })).toEqual({ consoles: [], decls: [] })
  })

  it('裸 `ADOPTED_SOURCES`（没有账套后缀）⇒ 抛：账套号是输出的身份，缺了对不成账', () => {
    expect(() => parseConsoleDecls({ ADOPTED_SOURCES: 'lemeng' })).toThrow(/ADOPTED_SOURCES_/)
  })

  it('空账套号（`ADOPTED_SOURCES_=`）⇒ 抛（同上，不静默拼一个匿名 console）', () => {
    expect(() => parseConsoleDecls({ [ADOPTED_SOURCES_PREFIX]: 'lemeng' })).toThrow()
    expect(() => parseConsoleDecls({ [ADOPTED_SOURCES_PREFIX + '   ']: 'lemeng' })).toThrow()
  })
})
