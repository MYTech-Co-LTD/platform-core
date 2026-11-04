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
import type { CandidateOrigin } from './metric-candidates'
import { deleteMetric, loadPlatformCatalog, selectMetricSnapshot, upsertMetric } from './metric-store'
import { writeMetricAudit } from './metric-audit-store'
import type { MetricCertification } from './metric-governance'
import { validatePrivateMeasure } from './private-measure'
import type { PrivateMeasureDeps, PrivateMeasureValidation } from './private-measure'
import {
  SemanticCompileError,
  collectRefIds,
  compileColumnAgg,
  compileL2,
  parseL1Select,
  resolveL1Base,
} from './semantic-compiler'
import type { ColumnAggDeclaration, CompiledColumnAgg, CompiledL2, L2Declaration } from './semantic-compiler'

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

/** 该 id 是否是平台词表（L1）里的行（L1 行对所有租户可见，故「只读」对所有租户成立）。
 *  入参只收 pool：本判定与「已接入源」无关，私有测度写路径也要复用（不给它凑假的 adoptedSources）。 */
async function isL1Id(deps: { pool: Pool }, id: string): Promise<boolean> {
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
      // ★ 跨档闸（W2，Task 1 评审遗留）：树形 L2 写不得落到私有测度行上。
      //   upsert 的冲突分支**不翻档**（首插定档），放过去会写成「select_sql 是树形、basis 仍是
      //   column_agg」的自相矛盾行——运行期按树形跑、生命周期按私有测度淘汰，两个事实源。
      //   私有测度的修改/复活只经 `writePrivateMeasure`（新建即时；修改走 D6 是树形档的规则）。
      const cur = await c.query(
        `select created_by, basis from data.metrics where org = $1 and id = $2 and source = 'l2'`,
        [org, id],
      )
      const basis: string | undefined = cur.rows[0]?.basis
      if (basis === 'column_agg') {
        return { ok: false, http: 409, error: 'BASIS_CONFLICT', extra: { existing_basis: basis } }
      }
      // creator 闸（判定说明见上面函数体外的注释块）：update 才判，create 不判。
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

/**
 * 元数据写路径（spec 2026-11-01 §10.4.3 P1）：业务描述 / 单位 / 口径说明。
 *
 * 写闸（manage ∪ creator）：治理标注不是口径，**管理员可代任何人修**（标注要有人接手，
 * 与 D7 认证管理的逻辑同源）；creator（data:query 档）可修自己的。判定在域层——HTTP
 * 与 MCP 共用本函数 = 共用同一份闸（同 creator 闸的落法）。
 *
 * 边界（fail-closed 是结构自足的）：
 *   · **只落本租户桶**（update where org=…）——L1 行在平台桶，租户 UPDATE 天然 404：
 *     「租户不得注解平台口径」，那是跨租户污染；平台侧元数据来源是另一议题；
 *   · 草稿/可信度不动——三个治理动作各管各的字段；
 *   · `undefined` = 不改该字段（部分更新），`null`/空串 = 显式清空；
 *   · 审计动作词 `meta`：前后态只带被改的 meta 字段（行快照稀释信号）。
 */
export interface MetricMetaPatch {
  bizDescription?: string | null
  unit?: string | null
  caliberNote?: string | null
}

export async function updateMetricMeta(
  deps: MetricWriteDeps, org: string, id: string, next: MetricMetaPatch,
): Promise<MetricWriteOutcome> {
  const actor = deps.requester
  return withTx(deps.pool, async (c) => {
    const cur = await c.query(
      `select source, created_by, biz_description, unit, caliber_note
         from data.metrics where org = $1 and id = $2`,
      [org, id],
    )
    if ((cur.rowCount ?? 0) === 0) return { ok: false, http: 404, error: 'NOT_FOUND' }
    const row = cur.rows[0] as {
      source: string; created_by: string | null
      biz_description: string | null; unit: string | null; caliber_note: string | null
    }
    const createdBy: string | null = row.created_by ?? null
    const isCreator = row.source === 'l2' && createdBy !== null && createdBy === actor.userId
    if (!isCreator && !actor.hasScope('data:manage')) {
      return { ok: false, http: 403, error: 'NOT_METRIC_CREATOR' }
    }
    // 空串/纯空白 → null（显式清空）；undefined → 不改该字段（不进 SET）
    /** @param v 声明侧来的原始值 @returns 入库值；undefined 透传 */
    const clean = (v: string | null | undefined): string | null | undefined => {
      if (v === undefined) return undefined
      const s = v === null ? null : v.trim()
      return s === '' ? null : s
    }
    /** 物理列 → [键, 前值, 新值]；undefined 新值 = 该字段不参与本次更新。 */
    const fields: Array<{ key: string; column: string; prev: string | null; nextVal: string | null | undefined }> = [
      { key: 'bizDescription', column: 'biz_description', prev: row.biz_description, nextVal: clean(next.bizDescription) },
      { key: 'unit', column: 'unit', prev: row.unit, nextVal: clean(next.unit) },
      { key: 'caliberNote', column: 'caliber_note', prev: row.caliber_note, nextVal: clean(next.caliberNote) },
    ]
    const changing = fields.filter((f) => f.nextVal !== undefined)
    if (changing.length === 0) return { ok: false, http: 400, error: 'EMPTY_META_PATCH' }
    const sets: string[] = []
    const params: unknown[] = [org, id]
    const beforeMeta: Record<string, string | null> = {}
    const afterMeta: Record<string, string | null> = {}
    for (const f of changing) {
      sets.push(`${f.column} = $${params.length + 1}`)
      params.push(f.nextVal)
      beforeMeta[f.key] = f.prev
      afterMeta[f.key] = f.nextVal as string | null
    }
    await c.query(`update data.metrics set ${sets.join(', ')} where org = $1 and id = $2`, params)
    await writeMetricAudit(c, {
      org,
      metricId: id,
      action: 'meta',
      userId: actor.userId,
      channel: actor.channel,
      keyId: actor.keyId,
      before: beforeMeta as never,
      after: afterMeta as never,
    })
    return { ok: true }
  })
}

// ── 私有测度（W2 Task 3，`basis='column_agg'`）────────────────────────────────────
/**
 * 私有测度写路径的入参：**行句柄/标题** + 列级聚合声明。
 *
 * 与 L2 的 `id + L2DeclarationBody` 同构：声明决定 select_sql（唯一编译点
 * `compileColumnAgg`），id/title 是行属性。description 可省（'' = 未写）。
 */
export interface PrivateMeasureWriteInput extends ColumnAggDeclaration {
  id: string
  title: string
  description?: string
  /**
   * 血统（W2 Task 5）：`demand`（缺省）= 对话/人手即时创建；`profile` = 候选池一键采用。
   *
   * **只进审计快照，不进指标行**——它是「这条口径怎么来的」，不是口径本身；新增列会让读侧
   * 多一个与授权无关的字段，而审计已经提供了逐条历史。取值非法 ⇒ BAD_INPUT（不落坏血统）。
   */
  origin?: CandidateOrigin
}

/**
 * 依赖 = 三闸的 deps（平台库 / 数据面列清单可注入）+ 写路径的操作人。
 *
 * 刻意**不**复用 `MetricWriteDeps`：私有测度不过「源接入闸」（spec §4.2 的三闸只到
 * relation/column/dims；运行期授权仍由 authorize 的 org 主体钉死兜底）。把 `adoptedSources`
 * 挂进来会让人以为还有第四道闸——而它并没有被消费。
 */
export type PrivateMeasureWriteDeps = PrivateMeasureDeps & { requester: Requester }

/**
 * 私有测度写入（新建即时可用；D6 只管修改）。
 *
 * 判定链（全部在域层，HTTP 面只做形状与错误码映射）：
 *   ① 三闸 `validatePrivateMeasure`（relation 白名单 / 实际列 / dims）——失败按码映射，
 *      `COLUMNS_UNAVAILABLE` 是**环境**问题 ⇒ 500（别折成「列名写错」的 400）；
 *   ② 编译 `compileColumnAgg`（纯函数；与 L1 同一份形状契约）；
 *   ③ 不得占 L1 的 id（占下会被加载侧丢弃 ⇒ 一次「成功的空操作」）；
 *   ④ 同 id 已存在时**显式**处理，绝不静默 upsert：
 *      · 跨档（basis 不是 column_agg）⇒ 409 `BASIS_CONFLICT`（upsert 的冲突分支不翻档，
 *        放过去会写成「SQL 是列聚合、basis 还是树形」的自相矛盾行）；
 *      · 同档且在用 ⇒ 409 `METRIC_EXISTS`（本端点只建不改；修改走 D6 草稿流）；
 *      · 同档但已归档 ⇒ 可复活，但要过 creator/manage 闸（归档行不能被别人静默复活）。
 *
 * 落库：**写生效列**（select_sql/group_by）+ `basis='column_agg'` + `certified='draft'` +
 * `created_by`；**不写 draft_spec**（新建即时可用）。审计与变更同事务（`action='create'`，
 * 复活也记 create——它是一次生命周期事件，不是内容修改）。
 * 血统（`input.origin`，缺省 demand）写进审计 `after.origin`：`profile` = 候选池采用，
 * `demand` = 对话即时创建（W2 Task 5；不新增指标列）。
 */
export async function writePrivateMeasure(
  deps: PrivateMeasureWriteDeps, org: string, input: PrivateMeasureWriteInput,
): Promise<MetricWriteOutcome> {
  const actor = deps.requester

  // 行句柄/标题的形状闸也放域层（路由的 zod 只挡 HTTP；未来 MCP 工具共用本函数时不该
  // 因为「没人校验」写出无 id / 无标题的行）。
  if (
    typeof input.id !== 'string' || input.id === ''
    || typeof input.title !== 'string' || input.title.trim() === ''
    || (input.description !== undefined && typeof input.description !== 'string')
    || (input.origin !== undefined && input.origin !== 'profile' && input.origin !== 'demand')
  ) {
    return { ok: false, http: 400, error: 'BAD_INPUT', extra: { detail: 'id/title 必填且为非空字符串；origin ∈ {profile,demand}' } }
  }
  // 血统缺省 = demand（对话/人手即时创建是常规入口；批量采用必须显式标 profile）
  const origin: CandidateOrigin = input.origin ?? 'demand'

  // ① 三闸（只读校验，失败不留半成品）
  const validation = await validatePrivateMeasure(deps, input)
  if (!validation.ok) {
    return {
      ok: false,
      // 环境/可见性问题响亮成 500（监控看得见）；其余是调用方可自助修正的输入问题 ⇒ 400。
      http: validation.code === 'COLUMNS_UNAVAILABLE' ? 500 : 400,
      error: validation.code,
      ...(validation.detail === undefined ? {} : { extra: { detail: validation.detail } }),
    }
  }

  // ② 编译（validate 已用同一函数收过形状；这里再调一次是「产物就是落库物」的单点）
  let compiled: CompiledColumnAgg
  try {
    compiled = compileColumnAgg(input)
  } catch (e) {
    if (e instanceof SemanticCompileError) {
      return { ok: false, http: 400, error: 'BAD_INPUT', extra: { detail: e.message } }
    }
    throw e
  }

  // ③ 与 writeL2Declaration 同一条纪律：L2 不能占 L1 的 id
  if (await isL1Id(deps, input.id)) return { ok: false, http: 409, error: 'ID_RESERVED_BY_L1' }

  const row = {
    id: input.id,
    title: input.title,
    description: input.description ?? '',
    requiredScope: null,
    // 编译产物给出 'org'（私有测度是租户行）——不在这里另推导一次
    subjectColumn: compiled.subjectColumn,
    selectSql: compiled.selectSql,
    groupBy: compiled.groupBy,
    params: {},
  }

  return withTx(deps.pool, async (c): Promise<MetricWriteOutcome> => {
    const cur = await c.query(
      `select source, basis, archived_at, created_by, certified
         from data.metrics where org = $1 and id = $2`,
      [org, input.id],
    )
    let before: Awaited<ReturnType<typeof selectMetricSnapshot>> = null
    /** 复活时保留既有可信度（upsertMetric 的冲突分支不碰 certified）；新建恒 draft。 */
    let certified: MetricCertification = 'draft'
    if ((cur.rowCount ?? 0) > 0) {
      const existing = cur.rows[0] as {
        source: string; basis: string; archived_at: Date | null
        created_by: string | null; certified: string | null
      }
      // ④ 跨档：显式拒绝（理由见函数头注）
      if (existing.source !== 'l2' || existing.basis !== 'column_agg') {
        return {
          ok: false, http: 409, error: 'BASIS_CONFLICT',
          extra: { existing_basis: existing.basis },
        }
      }
      // ④ 同档在用：只建不改（修改走 D6），不静默覆盖
      if (existing.archived_at === null) return { ok: false, http: 409, error: 'METRIC_EXISTS' }
      // ④ 同档已归档：可复活，但只能由 creator ∪ data:manage（与 D6 草稿端点的写闸同源）
      if (existing.created_by === null) return { ok: false, http: 403, error: 'METRIC_CREATOR_UNKNOWN' }
      if (existing.created_by !== actor.userId && !actor.hasScope('data:manage')) {
        return { ok: false, http: 403, error: 'NOT_METRIC_CREATOR' }
      }
      before = await selectMetricSnapshot(c, org, input.id)
      certified = existing.certified === 'certified' ? 'certified' : 'draft'
      await c.query(
        `update data.metrics set archived_at = null, revived_at = now()
          where org = $1 and id = $2 and source = 'l2' and basis = 'column_agg'`,
        [org, input.id],
      )
    }

    await upsertMetric(c, org, row, actor.userId, { basis: 'column_agg' })
    await writeMetricAudit(c, {
      org,
      metricId: input.id,
      action: 'create',
      userId: actor.userId,
      channel: actor.channel,
      keyId: actor.keyId,
      before,
      after: {
        title: row.title, description: row.description, subjectColumn: row.subjectColumn,
        selectSql: row.selectSql, groupBy: row.groupBy, params: row.params, certified,
        origin,
      },
    })
    return { ok: true }
  })
}

/** 私有测度三闸失败 → 判别式结果（write 与 D6 confirm 共用同一份状态码映射）。 */
function privateMeasureFailure(v: Extract<PrivateMeasureValidation, { ok: false }>): MetricWriteOutcome {
  return {
    ok: false,
    // 环境/可见性问题响亮成 500（监控看得见）；其余是调用方可自助修正的输入问题 ⇒ 400。
    http: v.code === 'COLUMNS_UNAVAILABLE' ? 500 : 400,
    error: v.code,
    ...(v.detail === undefined ? {} : { extra: { detail: v.detail } }),
  }
}

/**
 * 私有测度的 D6 确认路径（评审 Important：修改必须走草稿→确认，不能靠「归档再复活」）。
 *
 * 草稿形状（`metric-governance.ts` 的 `ColumnAggDraftSchema`）只含 `{kind,agg,column,dims}`——
 * **没有 relation**：修改只能在原 mart 内换列/换聚合/换维度，换源要重新走 `POST /metrics/private`。
 * 故 relation 从**当前生效行**的 select_sql 反解（`parseL1Select`，与运行期同一份形状契约）。
 *
 * 流程与树形 D6 同形：三闸重校验（数据面列可能已漂移）→ `compileColumnAgg` 重编译 →
 * 事务内更新生效列 + 审计（`action='update'`）。`basis` 保持 `column_agg`；`draft_spec` 的
 * 条件清除由路由在成功后执行（与树形路径共用同一份「并发新稿不被吞」的守卫）。
 */
export async function confirmPrivateMeasureDraft(
  deps: PrivateMeasureWriteDeps, org: string, id: string,
  draft: Omit<ColumnAggDeclaration, 'relation'>,
): Promise<MetricWriteOutcome> {
  const actor = deps.requester
  const cur = await deps.pool.query(
    `select created_by, select_sql from data.metrics
      where org = $1 and id = $2 and source = 'l2' and basis = 'column_agg'`,
    [org, id],
  )
  if ((cur.rowCount ?? 0) === 0) return { ok: false, http: 409, error: 'BASIS_CONFLICT' }
  const row = cur.rows[0] as { created_by: string | null; select_sql: string }
  if (row.created_by === null) return { ok: false, http: 403, error: 'METRIC_CREATOR_UNKNOWN' }
  if (row.created_by !== actor.userId) return { ok: false, http: 403, error: 'NOT_METRIC_CREATOR' }

  let relation: string
  try {
    relation = parseL1Select(row.select_sql).relation
  } catch {
    // 私有测度行的 select_sql 只由 compileColumnAgg 写入；解析不了 = 平台数据坏了（500）
    return { ok: false, http: 500, error: 'COLUMN_AGG_BASE_SQL_INVALID' }
  }
  const input: ColumnAggDeclaration = {
    agg: draft.agg,
    column: draft.column,
    ...(draft.dims === undefined ? {} : { dims: draft.dims }),
    relation,
  }

  const validation = await validatePrivateMeasure(deps, input)
  if (!validation.ok) return privateMeasureFailure(validation)

  let compiled: CompiledColumnAgg
  try {
    compiled = compileColumnAgg(input)
  } catch (e) {
    if (e instanceof SemanticCompileError) {
      return { ok: false, http: 400, error: 'BAD_INPUT', extra: { detail: e.message } }
    }
    throw e
  }

  return withTx(deps.pool, async (c): Promise<MetricWriteOutcome> => {
    const before = await selectMetricSnapshot(c, org, id)
    if (before === null) return { ok: false, http: 409, error: 'BASIS_CONFLICT' }
    const upd = await c.query(
      `update data.metrics
          set select_sql = $3, group_by = $4, updated_by = $5,
              version = version + 1, updated_at = now()
        where org = $1 and id = $2 and source = 'l2' and basis = 'column_agg'`,
      [org, id, compiled.selectSql, compiled.groupBy, actor.userId],
    )
    // 读与写之间被删/换档 ⇒ 不静默成功
    if ((upd.rowCount ?? 0) === 0) return { ok: false, http: 409, error: 'BASIS_CONFLICT' }
    await writeMetricAudit(c, {
      org,
      metricId: id,
      action: 'update',
      userId: actor.userId,
      channel: actor.channel,
      keyId: actor.keyId,
      before,
      after: {
        ...before,
        selectSql: compiled.selectSql,
        groupBy: compiled.groupBy,
        certified: before.certified ?? 'draft',
      },
    })
    return { ok: true }
  })
}
