// domain/metric-write.ts — L2 写入/删除的**唯一**判定链（HTTP 面与 MCP 写面共用）。
//
// 为什么抽出来：写路径的闸门（撞 L1 保留 / 基底必须是 L1 / 源接入 / 维度越界 / 禁 target）
// 每加一条就会分叉一次——两个入口各写一份 = 两个事实源，而分叉的其中一条通常是**漏判**的那条。
// 形态照 query-service.runQuery：域层拿显式 deps、返回判别式结果，**不碰 Hono**。
//
// 交付关系：`writeL2Declaration` / `deleteMetricDeclaration` 的 `http` 字段由调用方决定怎么用
// （HTTP 面直出状态码；MCP 写面翻成工具级错误 `{status:'refused', error}`）。
import type { Pool, PoolClient } from 'pg'
import type { Requester } from './authz'
import { deleteMetric, loadPlatformCatalog, selectMetricSnapshot, upsertMetric } from './metric-store'
import { writeMetricAudit } from './metric-audit-store'
import type { MetricCertification } from './metric-governance'
import { SemanticCompileError, collectRefIds, compileL2, resolveL1Base } from './semantic-compiler'
import type { CompiledL2, L2Declaration } from './semantic-compiler'

export interface MetricWriteDeps {
  pool: Pool
  /** 本租户已接入的源（宿主投影）。空集 = 一个源都没接 ⇒ 未接入源的基底一律拒（fail-closed）。 */
  adoptedSources: ReadonlySet<string>
  /** 谁在写（#489）。**必填**——审计要记人；无身份必须在入口被拒（见 routes/metrics.ts 的守卫），
   *  不能流到这里来（留，等于允许写一条「无主」审计）。 */
  requester: Requester
}

/**
 * 事务包裹：**审计与变更同生共死**（spec §4①）——「改了没记」与「记了没改」在取证上都是致命伤。
 * 失败一律回滚，绝不半提交。只包**写入**：判定链里的闸门是只读校验，留在事务外（少占连接、早拒）。
 */
async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
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
function compileFailure(e: SemanticCompileError): { http: 400 | 500; error: string; extra?: Record<string, unknown> } {
  if (e.code === 'BAD_BASE_SQL') return { http: 500, error: 'L1_BASE_SQL_INVALID' }
  // 编译错带的可机检细节（如 L2_BASE_MASKED 的 base / masks）原样透给调用方 ——
  // 否则调用方只拿到一个码，得靠猜才知道是哪条 L1 的哪条掩码挡住了它。
  return { http: 400, error: e.code, ...(e.extra === undefined ? {} : { extra: e.extra }) }
}

/** 该 id 是否是平台词表（L1）里的行（L1 行对所有租户可见，故「只读」对所有租户成立）。 */
async function isL1Id(deps: MetricWriteDeps, id: string): Promise<boolean> {
  return (await loadPlatformCatalog(deps.pool)).some((m) => m.id === id)
}

export async function writeL2Declaration(
  deps: MetricWriteDeps, org: string, id: string, decl: L2DeclarationBody,
  /** 透传 upsertMetric：确认生效路径 keepDraft（草稿由 confirm 的条件清除收尾，见那里）。 */
  opts?: { keepDraft?: boolean },
): Promise<MetricWriteOutcome> {
  // `target` 在 data.metrics 里**没有存储列**（003 只加了 source）。显式拒绝而不是静默丢弃：
  // 静默丢弃会让调用方以为目标值生效了。见 README「L2 的已知边界」。
  if ('target' in decl && decl.target !== undefined) return { ok: false, http: 400, error: 'TARGET_NOT_SUPPORTED' }

  // ★ L2 不能占 L1 的 id：占下之后**加载侧会丢 L2 行**（L1 赢）⇒ 这次写会**静默无效**
  //   （返回 200 而线上口径没变）。故在这里响亮拒绝，而不是让它变成一次「成功的空操作」。
  if (await isL1Id(deps, id)) return { ok: false, http: 409, error: 'ID_RESERVED_BY_L1' }

  // 词表只取一次（expr 有 N 个 ref，别在循环里反复 load）
  const catalog = await loadPlatformCatalog(deps.pool)
  // ref 是**唯一**要过 adopted 闸的东西：读侧不做二次校验（增补 §4.2）。
  // 用 collectRefIds 而不是按档位分支：它在形状不对时返回 []（不抛），
  // 形状错留给 compileL2 响亮地拒 —— 别把 zod 该报的错伪装成编译错。
  //
  // ★ 源维度的**写入闸**（spec §3⑧ 的第二道，计划 5 Task 5）：L1 是**逐源**的标准口径，
  //   租户只能在自己的源上裁 L2。任一 ref 属于「本租户未接入的源」⇒ **拒绝**（不是静默忽略）。
  //
  //   为什么闸在**这里**（resolveL1Base 之后）：那是本函数第一次拿到 ref 行、也就第一次
  //   看得到 `refBase.sourceSystem` 的地方；在它之前只有 id 字符串，判不了源。
  //   为什么用 `loadPlatformCatalog`（**不裁源**）解析 ref：若先把未接入源的 L1 从基底面
  //   裁掉，调用方只会拿到含混的 `L1_BASE_NOT_FOUND`（400）——而真相是「这条口径在，但它在
  //   别的源上」，那是**403 + 可解释体**该说的话（`its_source` / `your_sources` 让调用方自助判断）。
  //   顺序上它还必须**先于** compileL2：拒绝要拒绝得早，不留半成品。
  //
  //   与裁剪的关系（spec：「只装一道都不够」）：裁剪让**读**看不见未接入源的指标（歧义消失），
  //   本闸让**写**造不出基于未接入源的 L2（否则那条 L2 会在写入时看着成功、随后在读取侧
  //   被裁掉——一次「成功的空操作」，最难查的那种）。
  try {
    for (const refId of collectRefIds(decl)) {
      const refBase = resolveL1Base(catalog, refId)
      if (refBase.sourceSystem !== null && !deps.adoptedSources.has(refBase.sourceSystem)) {
        return {
          ok: false, http: 403, error: 'METRIC_SOURCE_NOT_ADOPTED',
          extra: { its_source: refBase.sourceSystem, your_sources: [...deps.adoptedSources] },
        }
      }
    }
  } catch (e) {
    if (e instanceof SemanticCompileError) return { ok: false, ...compileFailure(e) }
    throw e
  }

  let compiled: CompiledL2
  try {
    compiled = compileL2(catalog, decl)
  } catch (e) {
    if (e instanceof SemanticCompileError) return { ok: false, ...compileFailure(e) }
    throw e
  }

  // 闸门全过（都是只读校验）⇒ 开事务：读前态 → 落库 → 写审计
  // ★ creator 闸（spec 2026-11-01 §10.2）在**这里**而不是路由：HTTP 的 PUT 与 MCP 的 customize
  //   共用本函数——「改别人的 L2」在哪个面都一样拒。判定：
  //   · 行不存在 ⇒ 创建路径，无闸（谁建谁就是 creator）；
  //   · 行是 L2 且 created_by = 别人 ⇒ 403（草稿流是唯一的变更通路，见 routes 的 /metrics/:id/draft）；
  //   · created_by 为 NULL（027 前存量且 028 回填也没找到 create 审计）⇒ 403 METRIC_CREATOR_UNKNOWN
  //     ——「不知道谁建的」按 fail-closed 处理，孤儿治理流程是 spec §10.4.3 P1（本期不做）。
  //   · 行是 L1 ⇒ 不在本闸判（撞 L1 的 id 已在前面 409；L1 行经 API 本来只读）。
  const row = {
    id,
    title: compiled.title,
    // 派生关系写进 description：管理面要能看出「这条 L2 是从哪个平台指标裁出来的」
    description: compiled.description,
    requiredScope: null,
    // 主体列**继承** L1（编译产物给出）：它是主体钉死的依据，租户改不了（改了就是跨租户读别人的数据）
    subjectColumn: compiled.subjectColumn,
    selectSql: compiled.selectSql,
    groupBy: compiled.groupBy,
    params: {},
  }
  const actor = deps.requester
  // 回调返回 `MetricWriteOutcome`：creator 闸拒绝时带回失败结果（事务空转即回滚，无害）；
  // 正常路径回调返回 `{ ok: true }`，本函数原样透传——**不能无视回调返回值**（那等于闸白装）。
  const outcome = await withTx(deps.pool, async (c): Promise<MetricWriteOutcome> => {
    // 「建」还是「改」的判据就是**写之前有没有这行**（HTTP 的 POST/PUT 与 MCP 的 customize 都走这里，
    // 不为「建/改」各留一条分支）。同一读也给出审计要的**前态**。
    const before = await selectMetricSnapshot(c, org, id)
    if (before !== null) {
      // creator 闸（判定说明见上面函数体外的注释块）：update 才判，create 不判。
      const cur = await c.query(
        `select created_by from data.metrics where org = $1 and id = $2 and source = 'l2'`,
        [org, id],
      )
      const createdBy: string | null = cur.rows[0]?.created_by ?? null
      if (createdBy === null) return { ok: false, http: 403, error: 'METRIC_CREATOR_UNKNOWN' }
      if (createdBy !== actor.userId) return { ok: false, http: 403, error: 'NOT_METRIC_CREATOR' }
    }
    await upsertMetric(c, org, row, actor.userId, opts)
    await writeMetricAudit(c, {
      org,
      metricId: id,
      action: before === null ? 'create' : 'update',
      userId: actor.userId,
      channel: actor.channel,
      keyId: actor.keyId,
      before,
      after: {
        title: row.title, description: row.description, subjectColumn: row.subjectColumn,
        selectSql: row.selectSql, groupBy: row.groupBy, params: row.params,
      },
    })
    return { ok: true }
  })
  return outcome
}

export async function deleteMetricDeclaration(
  deps: MetricWriteDeps, org: string, id: string,
): Promise<MetricWriteOutcome> {
  const actor = deps.requester
  return withTx(deps.pool, async (c) => {
    // ★ 先读快照（只读，**不改顺序语义**）：它同时充当「这行在不在」与「删的是什么」。
    //   顺序纪律不变：**先看本租户自己的 L2 行，删不到才判 L1**（T8 评审 M-①）——
    //   「租户先建 L2、平台事后同 id 物化」是合法时序，若先判 L1 就恒 409 ⇒ 永久孤儿。
    const before = await selectMetricSnapshot(c, org, id)
    if (before === null) {
      // 没删到本租户的 L2 行：若这个 id 是平台词表里的 ⇒ **显式** 409（不是含混的 404）：
      // 404 会让管理员以为「这行不存在」，真相是「它在，但只能改 dbt 声明再物化」。
      if (await isL1Id(deps, id)) return { ok: false, http: 409, error: 'READONLY_L1' }
      return { ok: false, http: 404, error: 'NOT_FOUND' }
    }
    // creator 闸（spec §10.2，与 writeL2Declaration 同一条判定）：删别人的 L2 也是「改了
    // 看数人的世界」——同样只能走 creator 自己的手。NULL（存量且无 create 审计）fail-closed。
    {
      const cur = await c.query(
        `select created_by from data.metrics where org = $1 and id = $2 and source = 'l2'`,
        [org, id],
      )
      const createdBy: string | null = cur.rows[0]?.created_by ?? null
      if (createdBy === null) return { ok: false, http: 403, error: 'METRIC_CREATOR_UNKNOWN' }
      if (createdBy !== actor.userId) return { ok: false, http: 403, error: 'NOT_METRIC_CREATOR' }
    }
    await deleteMetric(c, org, id)
    await writeMetricAudit(c, {
      org,
      metricId: id,
      action: 'delete',
      userId: actor.userId,
      channel: actor.channel,
      keyId: actor.keyId,
      before,          // ★ 删除留证：被删的内容在 before 里（after 为 null）
      after: null,
    })
    return { ok: true }
  })
}

/**
 * 可信度分级升降（spec 2026-11-01 §10.4 D7）：管理员把 L2 在 certified/draft 之间切换。
 *
 *   · **只作用于 L2**——L1 的可信度读侧恒从 `source='l1'` 推导（sync 会重写整行，
 *     写列会被下一次物化冲掉，骗人），对 L1 调用是 403 不是静默成功；
 *   · 审计与变更同生共死（与 writeL2/delete 同一事务纪律），动作词 `certify`：
 *     它不是定义变更（spec/SQL 没动），独立成词让审计流里「改了口径」与「只改了标」可分辨；
 *   · 草稿（draft_spec）不受影响——可信度是「审核态」，草稿是「待审核的下一版」，两回事。
 */
export async function certifyMetric(
  deps: MetricWriteDeps, org: string, id: string, next: MetricCertification,
): Promise<MetricWriteOutcome> {
  const actor = deps.requester
  return withTx(deps.pool, async (c) => {
    // 快照只读 L2 行（selectMetricSnapshot 的形状契约）；没读到 = L1 或不存在，区分着回：
    // L1 ⇒ 403（L1 只读，读侧恒 certified——给它「降级」是语义错误）；真没有 ⇒ 404。
    const before = await selectMetricSnapshot(c, org, id)
    if (before === null) {
      if (await isL1Id(deps, id)) return { ok: false, http: 403, error: 'L1_NOT_EDITABLE' }
      return { ok: false, http: 404, error: 'NOT_FOUND' }
    }
    await c.query(
      `update data.metrics set certified = $3 where org = $1 and id = $2 and source = 'l2'`,
      [org, id, next],
    )
    await writeMetricAudit(c, {
      org,
      metricId: id,
      action: 'certify',
      userId: actor.userId,
      channel: actor.channel,
      keyId: actor.keyId,
      // 前后态 = 整行快照 + 可信度（certify 唯一变化物）；「从什么到什么」直接可读
      before: { ...before, certified: before.certified ?? 'draft' },
      after: { ...before, certified: next },
    })
    return { ok: true }
  })
}
