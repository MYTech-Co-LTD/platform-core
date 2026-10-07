// domain/metric-write.ts — L2 写入/删除的**唯一**判定链（HTTP 面与 MCP 写面共用）。
//
// 为什么抽出来：写路径的闸门（撞 L1 保留 / 基底必须是 L1 / 源接入 / 维度越界 / 禁 target）
// 每加一条就会分叉一次——两个入口各写一份 = 两个事实源，而分叉的其中一条通常是**漏判**的那条。
// 形态照 query-service.runQuery：域层拿显式 deps、返回判别式结果，**不碰 Hono**。
//
// 交付关系：`writeL2Declaration` / `deleteMetricDeclaration` 的 `http` 字段由调用方决定怎么用
// （HTTP 面直出状态码；MCP 写面翻成工具级错误 `{status:'refused', error}`）。
import type { Pool } from 'pg'
import { deleteMetric, loadPlatformCatalog, upsertMetric } from './metric-store'
import type { MetricRow } from './metric-store'
import { SemanticCompileError, compileL2, resolveL1Base } from './semantic-compiler'
import type { L2Declaration } from './semantic-compiler'

export interface MetricWriteDeps {
  pool: Pool
  /** 本租户已接入的源（宿主投影）。空集 = 一个源都没接 ⇒ 未接入源的基底一律拒（fail-closed）。 */
  adoptedSources: ReadonlySet<string>
}

/** 判别式结果：`http` 由调用方决定怎么用（HTTP 面直出；MCP 面翻成工具级错误）。
 *  `404` 是删除路径的「没这行」——**必须留在 union 里**（漏了 typecheck 会当场报，
 *  因为删除分支真的会返回它）。 */
export type MetricWriteOutcome =
  | { ok: true }
  | { ok: false; http: 400 | 403 | 404 | 409 | 500; error: string; extra?: Record<string, unknown> }

/**
 * 写路径 body 的声明部分（`id` 是行的稳定句柄，不属于「声明」本身）。
 * **刻意复用** `semantic-compiler` 的 `L2Declaration`：它就是 `L2Body` 去掉 `id`，
 * 另写一份接口等于给同一个形状立第二个事实源。
 */
export type L2DeclarationBody = L2Declaration

/**
 * 编译失败 → 判别式结果。分两类是**有意的**：
 *   · 调用方的问题（引用不存在的 base、维度越界、过滤子句错）⇒ 400，且回**具体 code**，
 *     让调用方能自助改（而不是猜「400 到底哪里不对」）。
 *   · 平台自己的问题（L1 行的 select_sql 不合形状契约）⇒ 500：那不是调用方能修的，
 *     而且它意味着 sync 物化出来的东西坏了——必须响亮（500 会被监控看见，400 不会）。
 */
function compileFailure(e: SemanticCompileError): { http: 400 | 500; error: string } {
  return e.code === 'BAD_BASE_SQL'
    ? { http: 500, error: 'L1_BASE_SQL_INVALID' }
    : { http: 400, error: e.code }
}

/** 该 id 是否是平台词表（L1）里的行（L1 行对所有租户可见，故「只读」对所有租户成立）。 */
async function isL1Id(deps: MetricWriteDeps, id: string): Promise<boolean> {
  return (await loadPlatformCatalog(deps.pool)).some((m) => m.id === id)
}

export async function writeL2Declaration(
  deps: MetricWriteDeps, org: string, id: string, decl: L2DeclarationBody,
): Promise<MetricWriteOutcome> {
  // `target` 在 data.metrics 里**没有存储列**（003 只加了 source）。显式拒绝而不是静默丢弃：
  // 静默丢弃会让调用方以为目标值生效了。见 README「L2 的已知边界」。
  if (decl.target !== undefined) return { ok: false, http: 400, error: 'TARGET_NOT_SUPPORTED' }

  // ★ L2 不能占 L1 的 id：占下之后**加载侧会丢 L2 行**（L1 赢）⇒ 这次写会**静默无效**
  //   （返回 200 而线上口径没变）。故在这里响亮拒绝，而不是让它变成一次「成功的空操作」。
  if (await isL1Id(deps, id)) return { ok: false, http: 409, error: 'ID_RESERVED_BY_L1' }

  let base: MetricRow
  try {
    base = resolveL1Base(await loadPlatformCatalog(deps.pool), decl.baseMetric)
  } catch (e) {
    if (e instanceof SemanticCompileError) return { ok: false, ...compileFailure(e) }
    throw e
  }

  // ★ 源维度的**写入闸**（spec §3⑧ 的第二道，计划 5 Task 5）：L1 是**逐源**的标准口径，
  //   租户只能在自己的源上裁 L2。基底属于「本租户未接入的源」⇒ **拒绝**（不是静默忽略）。
  //
  //   为什么闸在**这里**（resolveL1Base 之后）：那是本函数第一次拿到 base 行、也就第一次
  //   看得到 `base.sourceSystem` 的地方；在它之前只有 id 字符串，判不了源。
  //   为什么用 `loadPlatformCatalog`（**不裁源**）解析基底：若先把未接入源的 L1 从基底面
  //   裁掉，调用方只会拿到含混的 `L1_BASE_NOT_FOUND`（400）——而真相是「这条口径在，但它在
  //   别的源上」，那是**403 + 可解释体**该说的话（`its_source` / `your_sources` 让调用方自助判断）。
  //   顺序上它还必须**先于** compileL2：拒绝要拒绝得早，不留半成品。
  //
  //   与裁剪的关系（spec：「只装一道都不够」）：裁剪让**读**看不见未接入源的指标（歧义消失），
  //   本闸让**写**造不出基于未接入源的 L2（否则那条 L2 会在写入时看着成功、随后在读取侧
  //   被裁掉——一次「成功的空操作」，最难查的那种）。
  if (base.sourceSystem !== null && !deps.adoptedSources.has(base.sourceSystem)) {
    return {
      ok: false, http: 403, error: 'METRIC_SOURCE_NOT_ADOPTED',
      extra: { its_source: base.sourceSystem, your_sources: [...deps.adoptedSources] },
    }
  }

  let compiled: { selectSql: string; title: string; groupBy: string }
  try {
    compiled = compileL2(base, decl)
  } catch (e) {
    if (e instanceof SemanticCompileError) return { ok: false, ...compileFailure(e) }
    throw e
  }

  // ⚠️ T3 临时值：Task 4 改为 deps.requester.userId（那时 deps 才有 requester）。
  //    本提交的意义只是让「updatedBy 必填」这一条先把全部调用点扫过一遍。不发布。
  await upsertMetric(deps.pool, org, {
    id,
    title: compiled.title,
    // 派生关系写进 description：管理面要能看出「这条 L2 是从哪个平台指标裁出来的」
    // （纯 L2 行没有 lineage 面，description 是当前唯一的可见去处）
    description: `L2 派生自 ${base.id}`,
    requiredScope: null,
    // 主体列**继承** L1：它是主体钉死的依据，租户改不了（改了就是跨租户读别人的数据）
    subjectColumn: base.subjectColumn,
    selectSql: compiled.selectSql,
    groupBy: compiled.groupBy,
    params: {},
  }, '(t4)')
  return { ok: true }
}

export async function deleteMetricDeclaration(
  deps: MetricWriteDeps, org: string, id: string,
): Promise<MetricWriteOutcome> {
  // ★ 顺序：**先删本租户自己的 L2 行，再判 L1**（T8 评审 M-①，勿回退）。不能反——
  //   「租户先建 L2、平台事后同 id 物化」是**合法时序**（写侧闸门只拦相反方向），
  //   撞 id 之后那行 L2 在合并词表里被 L1 顶掉（消费面看不见它），若 DELETE 先判 L1
  //   就恒 409 ⇒ **永久孤儿**：租户再也清不掉自己声明过的那行，而存储层的
  //   `deleteMetric` 本来完全能删它（`org = 本 org` 与 `source = 'l2'` 都钉在 WHERE 里，
  //   碰不到平台桶那行）。删自己的行不影响任何人：「L1 赢」是**解析**规则，
  //   不是「租户的行归平台所有」。
  const gone = await deleteMetric(deps.pool, org, id)
  if (gone) return { ok: true }
  // 没删到：若这个 id 是平台词表里的 ⇒ **显式** 409（不是含混的 404）：404 会让管理员
  // 以为「这行不存在」，真相是「它在，但只能改 dbt 声明再物化」。故先认出来再拒。
  if (await isL1Id(deps, id)) return { ok: false, http: 409, error: 'READONLY_L1' }
  return { ok: false, http: 404, error: 'NOT_FOUND' }
}
