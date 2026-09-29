// report-content.test.ts — 报表**内容**指纹的单元测试（TDD 第一步：先落盘、先红）。
//
// 纪律（同 metabase.test.ts）：**桩必须收严到真机形状**。
//   · `GET /api/dashboard/{id}` 与 `GET /api/card/{id}` 是两个面，`dataset_query.stages[0]` 里
//     才有 `native`（SQL 正文）与 `template-tags`（v0.63 形态）。
//   · 未知路径 / 未知 id 一律 404（不回落成 200 空体——那会让形状断言永远成立）。
//
// 为什么指纹必须覆盖**卡片层**：Metabase 的 `dashboard.updated_at` 实测不反映卡片层改动
// （改卡片 SQL / 加卡 / 删卡 / 挪卡都不动它，只有改 name/description 才动）⇒ 拿它当"被改过"
// 的信号会漏。本文件里那条 `select 1` → `select 2` 的用例就是这一层。
import { describe, expect, it } from 'vitest'
import { MetabaseError, type FetchLike, type MetabaseDeps } from './metabase'
import { fingerprintOf, readDashboardContent } from './report-content'

const base = {
  dashcards: [{ id: 1, cardId: 11, row: 0, col: 0, sizeX: 12, sizeY: 6 }],
  parameters: [{ slug: 'tenant' }],
  embeddingParams: { tenant: 'locked' } as Record<string, string>,
  cardSqlDigests: { 11: 'aaaa' } as Record<number, string>,
}

describe('fingerprintOf', () => {
  it('同样输入 ⇒ 同样指纹（稳定性）', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base }))
  })

  it('dashcard 布局变 ⇒ 指纹变（人挪了图）', () => {
    const moved = { ...base, dashcards: [{ ...base.dashcards[0], sizeX: 6 }] }
    expect(fingerprintOf(moved)).not.toBe(fingerprintOf(base))
  })

  it('卡片 SQL 变 ⇒ 指纹变（updated_at 抓不到的那一层）', () => {
    const edited = { ...base, cardSqlDigests: { 11: 'bbbb' } }
    expect(fingerprintOf(edited)).not.toBe(fingerprintOf(base))
  })

  it('文本卡内容变 ⇒ 指纹变（内容在 visualization_settings，cardId=null）', () => {
    const textCard = { id: 2, cardId: null, row: 6, col: 0, sizeX: 12, sizeY: 4,
                       visualizationSettings: { text: '说明' } }
    const withText = { ...base, dashcards: [...base.dashcards, textCard] }
    const textEdited = { ...withText, dashcards: [
      ...base.dashcards, { ...textCard, visualizationSettings: { text: '改了' } }] }
    expect(fingerprintOf(withText)).not.toBe(fingerprintOf(textEdited))
  })

  it('参数映射变 ⇒ 指纹变（映射是 Task 5 要写的东西）', () => {
    const mapped = { ...base, dashcards: [
      { ...base.dashcards[0], parameterMappings: [{ parameter_id: 'p1' }] }] }
    expect(fingerprintOf(mapped)).not.toBe(fingerprintOf(base))
  })

  it('锁参状态变 ⇒ 指纹变', () => {
    const unlocked = { ...base, embeddingParams: {} as Record<string, string> }
    expect(fingerprintOf(unlocked)).not.toBe(fingerprintOf(base))
  })

  it('dashcards 顺序不影响（同一集合不同序 ⇒ 同指纹）', () => {
    const two = { id: 2, cardId: 12, row: 6, col: 0, sizeX: 6, sizeY: 4 }
    const one = { id: 1, cardId: 11, row: 0, col: 0, sizeX: 12, sizeY: 6 }
    const a = { ...base, dashcards: [one, two], cardSqlDigests: { 11: 'aaaa', 12: 'cccc' } }
    const b = { ...base, dashcards: [two, one], cardSqlDigests: { 11: 'aaaa', 12: 'cccc' } }
    expect(fingerprintOf(a)).toBe(fingerprintOf(b))
  })
})

// ---- readDashboardContent：真机形状的极简桩（只有 dashboard 读 + card 读两面）----

interface Rec { url: string }

/** `GET /api/dashboard/{id}` 的种子（snake_case，同真机）。 */
interface DashSeed {
  id: number
  name: string
  dashcards: { id: number; card_id: number | null; row: number; col: number; size_x: number; size_y: number }[]
  parameters?: Record<string, unknown>[]
  embedding_params?: Record<string, string>
}

/**
 * `GET /api/card/{id}` 的种子 = 该卡 `dataset_query.stages[0]` 那一阶段。**可变**：
 * 测试改它来模拟"人在 Metabase 里改了这张卡"。
 * 两种真机形态都要造得出：**native 卡**（`{ native }`，我们编译产的）与
 * **MBQL 卡**（`{ 'source-table': … }`，**没有 `native`**，人在 Metabase UI 用查询构造器建的）。
 */
type CardSeed = Record<string, unknown>

/**
 * 极简 Metabase 桩：只认 `GET /api/dashboard/{id}` 与 `GET /api/card/{id}`，其余 404。
 * 卡片种子按**引用**读 ⇒ 测试可在两次 `readDashboardContent` 之间改它。
 */
function mbStub(
  dash: DashSeed, cards: Record<number, CardSeed>,
): { calls: Rec[]; fetcher: FetchLike } {
  const calls: Rec[] = []
  const respond = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
  const fetcher: FetchLike = async (url) => {
    calls.push({ url })
    const path = new URL(url).pathname
    if (path === `/api/dashboard/${dash.id}`) {
      return respond({
        id: dash.id, name: dash.name, dashcards: dash.dashcards,
        parameters: dash.parameters ?? [], embedding_params: dash.embedding_params ?? null,
      })
    }
    const m = /^\/api\/card\/(\d+)$/.exec(path)
    const seed = m === null ? undefined : cards[Number(m[1])]
    if (seed === undefined) return respond({ message: 'not found' }, 404)
    return respond({ dataset_query: { stages: [seed] } })
  }
  return { calls, fetcher }
}

const depsOf = (fetcher: FetchLike): MetabaseDeps =>
  ({ fetcher, baseUrl: 'https://mb.test', apiKey: 'k' })

const dc = (id: number, cardId: number | null): DashSeed['dashcards'][number] =>
  ({ id, card_id: cardId, row: 0, col: 0, size_x: 12, size_y: 6 })

const dashOf = (dashcards: DashSeed['dashcards']): DashSeed =>
  ({ id: 7, name: 'org-a/日报', dashcards })

/** 挂在卡上的 tenant 模板标签（字典形态，Metabase UI 亦同）。 */
const TENANT_TAG = { tenant: { name: 'tenant', type: 'text' } }

/** 一张挂了 tenant 标签的 **native** 卡（SQL 形态，我们编译产的）。 */
const nativeCard = (native: string): CardSeed => ({ native, 'template-tags': TENANT_TAG })

/** 一张挂了 tenant 标签的 **MBQL** 卡（人在 Metabase UI 里建的：结构化查询，**没有 `native`**）。 */
const mbqlCard = (sourceTable: number): CardSeed =>
  ({ 'source-table': sourceTable, 'template-tags': TENANT_TAG })

describe('readDashboardContent：读真实内容 + 现算指纹', () => {
  it('★ 同一张卡 SQL 从 select 1 改成 select 2（模板标签没变）⇒ 指纹变——updated_at 抓不到的正是这一层', async () => {
    const cards: Record<number, CardSeed> = { 11: nativeCard('select 1') }
    const { fetcher } = mbStub(dashOf([dc(1, 11)]), cards)
    const deps = depsOf(fetcher)
    const before = await readDashboardContent(deps, 7)
    cards[11].native = 'select 2'
    const after = await readDashboardContent(deps, 7)
    // 标签逐个相同 ⇒ 指纹的差**只能**来自 SQL 正文；只摘要标签名的实现下这条会红（那正是要防的假绿）
    expect(after.cardTags).toEqual(before.cardTags)
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('★ MBQL 卡（人在 Metabase UI 建的：无 native、只有 source-table）改查询 ⇒ 指纹变', async () => {
    // ⚠️ UI 建的卡**默认就是 MBQL**：摘要若只取 native SQL 字符串，这类卡恒得 hash('')
    // ⇒ 人改了它的查询而指纹不动 = 写保护漏掉**一整类**改动（只摘要 native 的实现下这条会红）。
    const cards: Record<number, CardSeed> = { 11: mbqlCard(3) }
    const { fetcher } = mbStub(dashOf([dc(1, 11)]), cards)
    const deps = depsOf(fetcher)
    const before = await readDashboardContent(deps, 7)
    cards[11] = mbqlCard(4)   // 人把来源表从 3 换成 4（仍是 MBQL，全程没有 native）
    const after = await readDashboardContent(deps, 7)
    expect(after.cardTags).toEqual(before.cardTags)
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('文本卡（card_id: null）跳过，且同一张卡只读一次（1 次 dashboard 读 + N 次卡片读）', async () => {
    const { calls, fetcher } = mbStub(dashOf([dc(1, null), dc(2, 11), dc(3, 11)]), { 11: nativeCard('select 1') })
    const out = await readDashboardContent(depsOf(fetcher), 7)
    expect(out.cardTags).toEqual({ 11: ['tenant'] })
    // 文本卡没有卡可读、重复的卡只读一次 ⇒ 卡片请求恰好 1 次（不是 3 次）
    expect(calls.filter((c) => c.url.includes('/api/card/'))).toHaveLength(1)
    expect(calls.filter((c) => c.url.includes('/api/dashboard/'))).toHaveLength(1)
  })

  it('★ 卡片读失败 ⇒ 抛（不静默当成「这张报表没卡」）', async () => {
    // cards 里没有 11 ⇒ 桩回 404；吞掉它 = 把「读不到」伪装成「对得上」（对账机制最怕的假绿）
    const { fetcher } = mbStub(dashOf([dc(1, 11)]), {})
    await expect(readDashboardContent(depsOf(fetcher), 7)).rejects.toThrow(MetabaseError)
  })

  it('全量内容原样带出（dashcards / parameters / embeddingParams 一个不少）', async () => {
    const param = { id: 'p-tenant', name: 'tenant', slug: 'tenant', type: 'category' }
    const { fetcher } = mbStub(
      { ...dashOf([dc(1, 11), dc(2, null)]), parameters: [param], embedding_params: { tenant: 'locked' } },
      { 11: nativeCard('select 1') },
    )
    const out = await readDashboardContent(depsOf(fetcher), 7)
    expect(out.name).toBe('org-a/日报')
    expect(out.dashcards).toHaveLength(2)
    expect(out.parameters).toEqual([param])
    expect(out.embeddingParams).toEqual({ tenant: 'locked' })
    expect(out.fingerprint).toMatch(/^[0-9a-f]{24}$/)
  })
})
