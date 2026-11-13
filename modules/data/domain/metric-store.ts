// metric-store.ts — 指标词表的存储层（语义层声明在平台库里的投影）。
//
// 隔离键一律是 **org（text，值 = 该租户的 Casdoor org）**，不是 tenant_id：
// 正典 docs/module-protocol.md「租户数据隔离」，机器判据 scripts/check-tenant-isolation.mjs。
// 三处读写**全部**带 `where org = $1`——漏一处就是跨租户串数据。
import type { Pool, PoolClient } from 'pg'
import type { DrillBinding, DrillColumn, MaskSpec, MetricDef, MetricParamDef } from './authz'
import type { MetricRowSnapshot } from './metric-audit-store'
import type { CompiledTenantDeclaration } from './declaration-compiler'
import type { MetricCertification } from './metric-governance'

/**
 * 指标行的**来源分层**（003_metrics_source.sql）——「这行 select_sql 谁写的、谁可以改」。
 *
 * `l1` = 平台语义声明，由 `scripts/sync-data-semantics.mjs` 从仓内 dbt YAML 物化；
 *        管理 API **只读**（改 L1 口径要改 dbt 声明并重新物化，不能经 API 就地改）。
 * `l2` = 租户声明，由 `domain/semantic-compiler.ts`（唯一编译点）从结构化声明编译。
 */
export type MetricSource = 'l1' | 'l2'

/**
 * 测度口径基（034 迁移，W2 三档闭环）——「这行的 select_sql 是哪一档产出的」。
 *
 * `l1_tree`   = 树形口径：L1 平台声明、以及由 L1 ref 树编译的 L2（合并/派生/refine）。
 * `column_agg`= **私有测度**：单列聚合（sum/count/avg/min/max），写入期编译成与 L1 同形的
 *               `select <agg>(<col>) as value[, dims] from <relation>`。运行期零新路径，
 *               与树形行一样过 authorize/掩码/行域。不可被 L2 ref 引用（编译器另加断言）。
 *
 * 恒有值（列 not null default 'l1_tree'）：L1 行恒 `l1_tree`（sync 物化时写死）；
 * L2 行由写入口显式给档（缺省 = 树形）。
 */
export type MetricBasis = 'l1_tree' | 'column_agg' | 'declared'

/**
 * 库里的 L1 桶 org 值（**不是** env 的 `PLATFORM_ORG`）。
 *
 * L1 行落 `org = 'platform'`（全局约束 5：平台级声明也是合法 org 值，**不豁免** org 列纪律）。
 * 与 `PLATFORM_ORG` 的区别：那个是 single 模式下「本部署唯一租户」的解析来源（apps/server/src/tenant.ts），
 * 值是某个真实公司的 casdoor org；这个只是 data.metrics 里的一个固定桶名。
 */
export const L1_ORG = 'platform'

/**
 * 存储行 = 授权契约（`MetricDef`）+ **来源标注** + **源系统**。
 *
 * 为什么把 `source` 放在剥壳类型上而不是塞进 `MetricDef`：`MetricDef` 是**授权核心的契约**
 * （domain/authz.ts 只消费语义字段），来源是**存储/治理**属性，与授权判定无关。
 * 混进去会让授权核心的每次构造都要带上它，而它一个字都不读。
 *
 * `sourceSystem`（库列 `source_system`）与 `source` 是本文件里最容易混的一对：
 *   · `source`       = 取值 `l1`/`l2` ——「**谁写的**」（来源分层，决定谁能改）。
 *   · `sourceSystem` = 取值如 `lemeng` ——「**数据来自哪个源系统**」（源维度，spec §3⑧）。
 * 故列的命名刻意错开（`source_system` 而不是塞进 `source`）——同名不同义是静默错答的温床。
 * 可空：L2 行由租户声明编译而来，**没有**源系统；L1 行的值恒等于声明的 `source`。
 */
export interface MetricRow extends MetricDef {
  source: MetricSource
  sourceSystem: string | null
  /** 最后操作人（Casdoor 用户名）；L1 行走 sync 物化 ⇒ 恒 null。 */
  updatedBy: string | null
  /** 单调计数（每次经 API 写 +1）；L1 行恒 1。与报表 005 同形，但此处是为**追溯**不是乐观并发。 */
  version: number
  /**
   * 可加标记（016 迁移，spec §8.4）：存储行恒携带**规范化后的布尔**（`MetricDef` 上的可选
   * 字段在这里收窄成必有——「行里没有这个字段」不是合法态，缺省就是 false）。
   * 真值只来自 L1 物化路径；L2 行恒 false。
   */
  totalable: boolean
  /**
   * 口径射程与排除项（020 迁移，消费面 spec 2026-10-17 §12.6）。**运行期恒为字符串**
   * （`toMetricRow` 归一：空串 = 未声明）；类型上刻意保持可选——`MetricRow extends MetricDef`
   * 而要兼容按 `MetricDef` 形状写的夹具（否则每处夹具都得补一个与语义无关的空串）。
   * 真值只来自 L1 物化路径；L2 行恒 ''。
   */
  scopeNote?: string
  /**
   * 新鲜度 SLA 承诺天数（017 迁移，spec §10.7.1）：水位距今天 ≤N 个业务日即「正常」。
   * 真值只来自 L1 物化路径（sync 从声明 `freshness_sla_days` 物化，缺声明 sync 响亮失败）；
   * L2 行恒 null——「没接新鲜度链路」与「承诺 0 天」必须可辨，所以是 null 不是 0。
   */
  slaDays: number | null
  /**
   * 新鲜度关系集（017 迁移，spec §10.7.3）：sync 从声明 sources 的存储路径段推导的
   * staging 关系名数组；水位 = 这些关系在 load_log 上 min(max_bizday)。
   * L2 行恒 null；L1 未声明 sources 时为空数组（两者都 = 无自动水位，响应字段缺席）。
   */
  freshnessRelations: string[] | null
  /**
   * 值级掩码声明（018 迁移，spec 2026-10-17 §5.2）：`mask_spec` jsonb 的规范化形态。
   * 存储行恒携带**数组或 null**（「行里没有这个字段」不是合法态，缺省就是 null = 未声明）——
   * 与 sla_days/freshness_relations 同一条纪律。真值只来自 L1 物化路径（sync 从声明 `mask`
   * 物化，声明侧已拦「列不在 selectSql 里」的静默失效形态）；L2 行恒 null。
   */
  masks: MaskSpec[] | null
  /**
   * 实体名（W0，031 迁移）：L1 声明侧物化的「这条指标说的是哪个实体」（如 `branch`）。
   * 恒有值：未声明 = null（「行里没有这个字段」不是合法态——读侧 Task 3 直接比对）；
   * L2 行恒 null（租户声明没有实体面）。
   */
  entity: string | null
  /**
   * 同义词（W0，031 迁移）：L1 声明侧物化的别称数组（如 `['营业额', '销售金额']`）。
   * 恒数组：未声明 / 坏形状 = []（读侧 Task 3 直接 `.some(...)`，不给 undefined 留门）；
   * L2 行恒 []（租户声明没有同义词面）。
   */
  synonyms: string[]
  /**
   * 可信度分级（027 迁移，spec 2026-11-01 §10.4 D7）：**读侧推导后的值**——
   * L1 行恒 `'certified'`（平台口径，从 `source='l1'` 推导，不读列：sync 重写整行，列不可信）；
   * L2 行读列（新建走 API 时写 `'draft'`；列 NULL = 027 之前的存量行，按 `'draft'` 报——
   * 它们本来就没经过审核，与迁移 027 头注同口径）。
   */
  certified: MetricCertification
  /** L2 创建者（027 迁移）；L1 行恒 null（平台口径无「创建者」概念），存量 L2 行可能 null（诚实状态）。 */
  createdBy: string | null
  /**
   * 租户口径覆盖（041 迁移，W8 2026-11-09）：非空 = 本行是该 org 对 `<id>` 的**平台口径覆盖**。
   * 只可能出现在 `source='l2'` 的租户行（值 = 被覆盖的平台 L1 id，与 `id` 相同）；
   * L1 行恒 null。读侧优先级见 `loadMergedCatalog`（覆盖行对本 org 胜出）。
   * 类型可选：历史夹具不必补字段；读侧一律用 `!= null` 判（undefined 与 null 同义 = 非覆盖）。
   */
  overrideOf?: string | null
  /**
   * 元数据（030 迁移，spec §10.4.3 P1）：业务描述 / 单位 / 口径说明——**治理标注**，不经编译点。
   * NULL = 未标注（迁移头注：空着比编一个错的好）。L1 行恒 null——租户不得注解平台口径
   * （L1 行在平台桶，写面对租户天然 404，列自然不被污染；平台侧元数据来源是另一议题）。
   */
  bizDescription: string | null
  unit: string | null
  caliberNote: string | null
  /**
   * 明细下钻绑定（021 迁移，下钻 spec 2026-10-21 §2.3）：三列（drill_expr/drill_dims/drill_detail）
   * 经 `drillBindingOf` 归一后的产物。**读侧不信任存储形状**——任一列缺/坏 ⇒ undefined（= 未声明），
   * 绝不半绑（半个绑定比没有绑定更危险，spec §2.5：未声明即不下钻）。
   * 真值只来自 L1 物化路径；L2 行三列恒 NULL ⇒ 恒 undefined（「L2 不支持下钻」由存储形状自然涌现）。
   */
  drill?: DrillBinding
  /**
   * 测度口径基（034 迁移，W2 三档闭环）：`l1_tree`（树形，缺省）| `column_agg`（私有测度）。
   * 恒有值——列缺省/坏值由 `toMetricRow` 归一成 `l1_tree`（读侧不给 undefined 留门）。
   * L1 行恒 `l1_tree`（sync 物化写死并在冲突分支回收）。
   */
  basis: MetricBasis
  /**
   * 归档时刻（034 迁移，W2 生命周期）：ISO 字符串；NULL = 在用。
   *
   * 归档是**隐藏**不是删除：三个查询面默认滤掉（`archived_at is null`），行与审计保留；
   * upsert 的冲突分支不碰它（一次普通写不得让归档行静默复活）。
   * L1 行恒 null（平台口径的生命周期由声明/PR 管，不由租户归档动作管）。
   */
  archivedAt: string | null
  /**
   * 部门归属（047 迁移，P1 Task 3）：**部门内同名互斥**（`metrics_title_per_dept_uq`）的桶键——
   * null = 平台通用桶（coalesce 后与空串同桶参与互斥）。真值只来自变更单（submitChange 校验
   * `assertConcept`/`assertTitleFree` 后经 opts.ownership 落库）；L1 物化路径不写，恒 null。
   * 类型可选（与 `overrideOf?` 同一条理由）：历史夹具不必补字段，读侧 `toMetricRow` 恒产出。
   */
  ownerDept?: string | null
  /**
   * 差异说明（047 迁移，P1 Task 3）：「这条变体与平台口径差在哪」的人读注记，纯治理标注
   * （口径本身在 select_sql/声明里，这里不做权威）。同 `ownerDept`：变更单写入，L1 恒 null。
   */
  variantNote?: string | null
  /**
   * 显式共享（047 迁移 `visible_depts`，P2 Task 4 读侧接线）：归属部门把指标开给哪些
   * **直属**部门（兄弟开门的唯一途径——判定只认直属，见 `metric-visibility.ts` 谓词）。
   * NULL = 仅按 `owner_dept` 部门链。恒有值（null，不是键缺席）——与 `ownerDept` 同一条
   * 「读侧恒产出」纪律。写侧暂无 API 面（P2 只接读；共享要走授权变更，归后续波次）。
   */
  visibleDepts?: string[] | null
}

/**
 * L2 归属四字段的**可选写面形状**（P1 Task 3，spec §5.1）：create/update 变更单 payload 顶层的
 * `entity/synonyms/ownerDept/variantNote` 经 adoptChange → writeL2Declaration opts 透传到这里。
 * **缺席键 = 保留行上既有值**（upsert 冲突分支 coalesce）——「一次不带归属的普通写不得把
 * 已声明的归属静默洗掉」。
 * ⚠️ 唯一的显式清空案例是 `synonyms: []`（终审 Item 4 订正：docstring 曾错写「显式清空不是
 * P1 的案例」）——提交面 zod 允许空数组（只限元素、不限个数），而空数组参数化成 `'[]'`
 * 非 NULL，coalesce 挡不住 ⇒ 冲突分支照写，既有同义词被清空。entity/ownerDept/variantNote
 * 的显式清空确实不是 P1 案例（提交面 zod 拒空串，只能换值、不能清）。
 */
export interface MetricOwnership {
  entity?: string
  synonyms?: string[]
  ownerDept?: string
  variantNote?: string
}

/**
 * **L1 写入口**的入参形状：授权契约 + 源系统（`upsertL1Metric` 专用）。
 *
 * 为什么把源系统写成**必填**而不是可选：L1 声明里 `source` 是必填字段（门禁规则 ⑤），
 * 物化出的 L1 行因此恒有源。写成可选会给「漏传 ⇒ 静默落 null」留门，而那正是
 * 「平台行的源维度凭空消失、Task 5 的裁剪把它判成未接入源」的失败形态。
 */
export interface L1MetricDef extends Omit<MetricDef, 'drill'> {
  sourceSystem: string | null
  /** 新鲜度 SLA 承诺天数（spec §10.7.1，声明 `freshness_sla_days` 的物化值）。 */
  slaDays: number
  /** 新鲜度关系集（spec §10.7.3，声明 sources 路径段的推导值；未声明 sources = 空数组）。 */
  freshnessRelations: string[]
  /** 值级掩码声明（spec 2026-10-17 §5.2，声明 `mask` 的物化值；未声明 = null）。 */
  masks: MaskSpec[] | null
  /**
   * 口径射程与排除项（消费面 spec 2026-10-17 §12.6，声明 `scope_note` 的物化值；未声明 = ''）。
   * **可选**（与 `MetricDef.scopeNote?` 同形）：合成契约与测试夹具可以不带——缺省即「未声明射程」，
   * 与显式 '' 同义（写库侧统一 `?? ''` 收口）。
   */
  scopeNote?: string
  /**
   * 单位（spec 2026-11-01 §10.4.3，声明 `unit` 的物化值；可选）：null = 未声明——赋值留给
   * 口径责任人（sync 代编错一个就是产品可见的错误数据），机制先于值在位。
   */
  unit?: string | null
  /**
   * 实体名（W0，031 迁移，声明 `entities` / 指标 `entity` 的物化值；可选）：未声明 = null。
   * 与 `unit` 同一条可选理由——合成契约与测试夹具可以不带；写侧 `?? null` 收口。
   */
  entity?: string | null
  /**
   * 同义词（W0，031 迁移，声明 `synonyms` 的物化值；可选）：未声明 = 空数组。
   * 写侧 `?? []` 收口——库里 jsonb 恒数组（不留 NULL 给读侧猜）。
   */
  synonyms?: string[]
  /**
   * 明细下钻绑定（下钻 spec 2026-10-21 §2.3，声明 compose/dimensions/detail 的物化值）：
   * **sync 物化路径必传**（声明有 compose/dimensions/detail 就给绑定；未声明 compose = 缺省，
   * 与读侧 `MetricDef.drill?` 的「未声明 = 字段缺席」同一口径）。类型上可选与 `scopeNote`
   * 同一条理由——合成契约与测试夹具可以不带；写侧 `== null` 收口（显式 null/undefined 同义，
   * 都落 NULL = 未声明下钻）。
   */
  drill?: DrillBinding
}

/** 行 → MetricRow：只映射契约里的字段（created_at/updated_at 不外泄给授权核心）。 */
function toMetricRow(row: Record<string, unknown>): MetricRow {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string,
    requiredScope: row.required_scope as string | null,
    subjectColumn: row.subject_column as string,
    selectSql: row.select_sql as string,
    groupBy: row.group_by as string,
    // params 是 jsonb：pg 已把它反序列化成对象，**不要**再 JSON.parse（那是第二个事实源）
    params: row.params as Record<string, MetricParamDef>,
    source: row.source as MetricSource,
    sourceSystem: row.source_system as string | null,
    updatedBy: (row.updated_by ?? null) as string | null,
    version: Number(row.version ?? 1),
    // 可加标记（spec §8.4）：`=== true` 归一——列缺省/未来形状变化都不会让 undefined 冒充真值
    totalable: row.totalable === true,
    // 口径射程（spec §12.6）：字符串列，缺省/坏形状归 ''（= 未声明），不让 undefined 冒充
    scopeNote: typeof row.scope_note === 'string' ? row.scope_note : '',
    // 新鲜度链路（spec §10.7）：sla_days 归一成 number|null；freshness_relations 是 jsonb 数组
    // （pg 已反序列化），只认真数组——列缺省/坏形状宁可落 null（= 无链路），不让 undefined 冒充。
    slaDays: row.sla_days === null || row.sla_days === undefined ? null : Number(row.sla_days),
    freshnessRelations: Array.isArray(row.freshness_relations)
      ? (row.freshness_relations as string[]).map(String)
      : null,
    // 掩码声明（spec §5.2）：mask_spec 是 jsonb 数组（pg 已反序列化），只认真数组——
    // 列缺省/坏形状宁可落 null（= 未声明），不让 undefined 冒充真值（同 freshness_relations）。
    masks: Array.isArray(row.mask_spec) ? (row.mask_spec as MaskSpec[]) : null,
    // 实体与同义词（W0，031）：L1 声明侧物化，读侧**恒有值**——刻意不收窄成可选，
    // 让「列缺省 / 坏形状」也落在 null / [] 上（Task 3 可直接 .some(...)，不给 undefined 留门）。
    entity: typeof row.entity === 'string' ? row.entity : null,
    synonyms: Array.isArray(row.synonyms) ? row.synonyms.map(String) : [],
    // 可信度分级（spec 2026-11-01 §10.4 D7）：推导收口在**这一处**——
    // L1 恒 certified（source 推导，不读列）；L2 读列，NULL（存量）按 draft 报。
    // toolbox 的 tier 投影消费本值，不再各自从 source 推导（第二事实源会打架）。
    certified: row.source === 'l1' ? 'certified' : row.certified === 'certified' ? 'certified' : 'draft',
    createdBy: (row.created_by ?? null) as string | null,
    // 租户口径覆盖（041，W8）：空串/缺列都归 null（= 非覆盖），不让坏形状冒充覆盖标记。
    overrideOf: typeof row.override_of === 'string' && row.override_of !== '' ? row.override_of : null,
    // 元数据（030）：nullable 直读——NULL = 未标注（不编默认值）；坏形状列死了直读也一样安全（text）
    bizDescription: (row.biz_description ?? null) as string | null,
    unit: (row.unit ?? null) as string | null,
    caliberNote: (row.caliber_note ?? null) as string | null,
    // 下钻绑定（下钻 spec §2.3）：三列归一收口在 drillBindingOf——读侧不信任存储形状，
    // 任一列缺/坏 ⇒ undefined（= 未声明），绝不半绑。
    drill: drillBindingOf(row),
    // 测度档与归档（W2，034）：档恒有值（坏值/缺列 ⇒ 树形）；归档时刻归一成 ISO 字符串或 null
    // （坏值宁可当「未归档」也不让整个词表加载因一行脏时间戳抛错——读路径不抛是既有纪律）。
    basis: row.basis === 'column_agg' ? 'column_agg' : row.basis === 'declared' ? 'declared' : 'l1_tree',
    archivedAt: archivedAtOf(row.archived_at),
    // 归属列（047，P1 Task 3）：nullable 直读——NULL = 无归属（L1 行与未带归属的 L2 行的自然态）
    ownerDept: (row.owner_dept ?? null) as string | null,
    variantNote: (row.variant_note ?? null) as string | null,
    // 显式共享（047，P2 Task 4 读侧接线）：数组直读，坏形状/缺席 ⇒ null（= 未共享，不编空数组
    // ——「声明共享为空」与「没共享」在本判定里同待遇，见谓词的 `(visibleDepts ?? [])` 收口）
    visibleDepts: Array.isArray(row.visible_depts) ? row.visible_depts.map(String) : null,
  }
}

/** 归档时刻归一：Date / 可解析字符串 ⇒ ISO；NULL / 坏值 ⇒ null（= 未归档）。 */
function archivedAtOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** 行的下钻三列 → DrillBinding；任一列缺/坏形状 ⇒ undefined（= 未声明）。读侧不信任存储形状。 */
function drillBindingOf(row: Record<string, unknown>): DrillBinding | undefined {
  const expr = row.drill_expr
  const dims = row.drill_dims
  const detail = row.drill_detail
  if (typeof expr !== 'string' || expr === '') return undefined
  if (!Array.isArray(dims) || dims.length === 0 || dims.some((d) => typeof d !== 'string' || d === '')) return undefined
  if (typeof detail !== 'object' || detail === null) return undefined
  const d = detail as { relation?: unknown; filter?: unknown; columns?: unknown }
  if (typeof d.relation !== 'string' || d.relation === '' || typeof d.filter !== 'string' || d.filter === '') return undefined
  // 条件列（spec 2026-10-22 §2.3）：给了就必须是合法非空数组；坏形状 ⇒ **整个绑定作废**
  // （fail-closed：宁可不给下钻，也不按一份读不懂的权限声明投影列）。缺省 = 字段缺席。
  let columns: DrillColumn[] | undefined
  if (d.columns !== undefined) {
    if (!Array.isArray(d.columns) || d.columns.length === 0) return undefined
    const out: DrillColumn[] = []
    for (const item of d.columns) {
      if (item === null || typeof item !== 'object') return undefined
      const it = item as { col?: unknown; grantedBy?: unknown }
      if (typeof it.col !== 'string' || it.col === '' || typeof it.grantedBy !== 'string' || it.grantedBy === '') return undefined
      out.push({ col: it.col, grantedBy: it.grantedBy })
    }
    columns = out
  }
  return {
    expr, dims: dims as string[], relation: d.relation, filter: d.filter,
    ...(columns === undefined ? {} : { columns }),
  }
}

/** 投影列清单（三处查询共用一处写法——少写/写错一列是「字段静默变 undefined」的经典来源）。 */
const ROW_COLUMNS =
  'id, title, description, required_scope, subject_column, select_sql, group_by, params, source, source_system, updated_by, version, totalable, scope_note, sla_days, freshness_relations, mask_spec, drill_expr, drill_dims, drill_detail, certified, created_by, biz_description, unit, caliber_note, entity, synonyms, basis, archived_at, override_of, owner_dept, variant_note, visible_depts'

/**
 * 本 org 的 L2 行（**不含** L1 平台行）。`order by id`：顺序确定。
 *
 * ⚠️ **消费通道一律不得调用本函数**（T8 评审 C1，Critical）。它只回本 org 的行 ⇒
 *   平台 L1 指标在调用它的通道上**整条消失**（不是报错，是「这个词表里没这个 id」）；
 *   而 `GET /metrics` 用的是合并词表 ⇒ **同一 id 在两条通道上胜负相反**
 *   （console 显示平台口径、`/query` 却跑租户那条 `source='l2'` 的 SQL），
 *   且没有任何状态码/日志/审计差异——是静默错答类缺陷。
 *
 *   消费面（`POST /query`、MCP `tools/list`、chat、`GET /metrics`）**唯一**的词表加载器是
 *   `loadMergedCatalog`。名字里的 `Org` 就是为了让这个错法在调用点一眼可辨：
 *   `loadCatalog` 读起来像「那个词表加载器」，正是 C1 里三条通道集体用错它的原因。
 *   本函数在**生产路径上没有调用方**——它服务的是存储层的「单桶」断言
 *   （`metric-store.test.ts`：只回本 org、行 → `MetricRow` 映射保真）。
 *   机器判据：`catalog-consumers.test.ts` 的「来源守卫」组逐文件钉住四个消费模块引用的是哪一个。
 */
export async function loadOrgCatalog(pool: Pool, org: string): Promise<MetricRow[]> {
  const r = await pool.query(
    `select ${ROW_COLUMNS} from data.metrics where org = $1 and archived_at is null order by id`,
    [org],
  )
  return r.rows.map(toMetricRow)
}

/** L1 平台词表（唯一物化来源是 sync 脚本）。`order by id`：与合并口径一致。 */
export async function loadPlatformCatalog(pool: Pool): Promise<MetricRow[]> {
  const r = await pool.query(
    `select ${ROW_COLUMNS} from data.metrics where org = $1 and source = 'l1' and archived_at is null order by id`,
    [L1_ORG],
  )
  return r.rows.map(toMetricRow)
}

/**
 * 消费面词表 = **L1（平台）∪ L2（本 org）**（计划 Task 8「catalog 加载」）。
 *
 * ★ **这是消费通道唯一的词表加载器**（T8 评审 C1 的整改落点）：`POST /query`、
 *   MCP `tools/list`、chat（`domain/agent-loop.ts`）、`GET /metrics` 四条面全部经它，
 *   于是「同一 id 在任一通道上解析结果一致（撞 id 时 L1 赢）」是**加载器的性质**，
 *   而不是四条通道各自的性质——四条各自加载就会漂（C1 的实况：3/4 条用了 `loadOrgCatalog`）。
 *   机器判据：`catalog-consumers.test.ts`（四通道一致性断言 + 来源守卫）。
 *
 * ★ L2 **不可覆盖** L1 口径：见下方撞名分支——这是「L2 只 refine 不改口径」在加载侧的落点。
 *   写入侧已有闸门（routes/metrics.ts 的 `ID_RESERVED_BY_L1`），这里是**第二道**：
 *   闸门被绕过（历史数据 / 直接写库 / 「先建 L2、后物化 L1」的合法时序）时，
 *   加载侧仍不能让 L2 行顶掉 L1 行，否则「L1 口径唯一」就只靠写侧那道门——
 *   而单道门的失效是静默的。
 */
export async function loadMergedCatalog(pool: Pool, org: string): Promise<MetricRow[]> {
  const r = await pool.query(
    // L1 桶恒取 platform；L2 只取本 org（**不**跨租户读别人的 L2 行）
    `select ${ROW_COLUMNS} from data.metrics
      where ((org = $1 and source = 'l2') or (org = $2 and source = 'l1'))
        and archived_at is null
      order by id, source`,
    [org, L1_ORG],
  )
  const rows = r.rows.map(toMetricRow)
  const l1Ids = new Set<string>()
  for (const row of rows) if (row.source === 'l1') l1Ids.add(row.id)
  // 租户口径覆盖（041，W8 2026-11-09）：只有「本 org 的 L2 行 + override_of 指向一个真实存在的
  // L1 id + override_of === id」才构成覆盖。悬空/错形状的 override_of 不构成覆盖（按普通 L2 走，
  // 撞名仍丢——fail-closed，不让坏标记顶掉平台口径）。
  const overrideIds = new Set<string>()
  for (const row of rows) {
    if (row.source === 'l2' && row.overrideOf !== null && row.overrideOf === row.id
      && l1Ids.has(row.id) && row.certified === 'certified') {
      // D6：覆盖是「修改已生效口径」，**草稿不生效**（确认后才胜出）。未确认的覆盖行按普通 L2 走，
      // 撞名仍被 L1 丢弃 ⇒ 对读取完全不可见，直到 confirm 把它置为 certified。
      overrideIds.add(row.id)
    }
  }
  const merged: MetricRow[] = []
  for (const row of rows) {
    if (row.source === 'l1') {
      // 覆盖行存在 ⇒ 本 org 用覆盖行，L1 行不对本 org 输出（其他 org 仍看到 L1）。
      if (!overrideIds.has(row.id)) merged.push(row)
      continue
    }
    // 覆盖行胜出（本 org 用租户口径）；普通 L2 撞 L1 的 id 仍丢弃（L2 只能 refine、不能顶掉 L1）。
    // 丢弃而不是报错：加载是读路径，抛错会让整条问数链因为一行脏数据不可用。
    if (overrideIds.has(row.id)) { merged.push(row); continue }
    if (l1Ids.has(row.id)) continue
    merged.push(row)
  }
  return merged
}

// ── 两个写入函数，**不是一个带 source 参数的函数** ──────────────────────────────
// 来源是「这行谁写的、谁可以改」的分水岭（L1 只读 / L2 可改），故把它做成**两个各自命名的
// 入口**，而不是一个 `source` 形参：
//   · `upsertMetric`   —— 租户写路径（T2/T8 的管理 API、集成测试）。**写死的 l1 不可能出现**。
//   · `upsertL1Metric` —— 平台物化路径（**只许** scripts/sync-data-semantics.mjs 调）。
// 好处有两条，都是形参版做不到的：
//   ① `grep upsertL1Metric` 就能穷举「谁在写平台词表」，不需要逐个调用点看实参；
//   ② 形参版若给 source 一个默认值，漏传会**静默**写成 l2（一行平台声明变成租户可改的行）；
//      两个入口版没有「漏传」这个失败态。
// 代价是多一个函数——而它换掉的是一条静默的、安全相关的失败路径。

// 覆盖式写入：同 (org, id) 幂等（部署脚本会重跑迁移/重复投递词表）。
//
// ⚠️ 冲突分支必须是 **do update**，不是 do nothing：`do nothing` 会让「改过的词表再也投不进去」
//    （第二次投递静默无效——词表是运营面会改的东西，这正是它最需要的语义）。
// ⚠️ 冲突分支**不碰 created_at**：只刷 updated_at。created_at 是「这一行什么时候进来的」，
//    upsert 是改内容不是重建行，抹掉它就丢了唯一的时间锚。
// ⚠️ 冲突分支**不碰 source**：来源只由「首次插入」确定。让它被 excluded 覆盖，等于任何一次写
//    都能把这行从 L1 改标成 L2（或反之）——来源标注被写动作改掉，它就失去了意义。
// ⚠️ 冲突分支**同样不碰 source_system**（与 source 同一纪律，理由比它更实）：L2 行没有源
//    （插入值显式 `null`），而冲突分支若把它写成 excluded，则「租户写路径撞上同 (org,id) 的
//    L1 行」这一次写动作就会把**平台行的源维度抹成 null**——而 sync 的 `--check` 拿声明比对
//    库内 L1 行时会因此**长期报漂移**（一次租户写，永久红）。
// ⚠️ 可加标记（totalable，spec §8.4）不是 L2 写入面的概念：租户声明是结构化编译的产物，
//    没有「表达式形状」这个输入 ⇒ 插入值写死 `false`，冲突分支**也不碰**（首次插入已是终值；
//    若写 excluded，一次租户写会把同 id 平台行的可加标记抹掉，自动合计静默消失）。
// ⚠️ 新鲜度链路两列（sla_days / freshness_relations，spec §10.7）同理不是 L2 写入面的概念：
//    插入值写死 `null`，冲突分支**也不碰**——租户写撞上同 id 平台行时，不得把平台行的新鲜度
//    链路抹掉（抹了 = 水位/固定行静默消失，且 sync --check 会长期报漂移）。
// ⚠️ 值级掩码声明（mask_spec，spec 2026-10-17 §5.2）第三组同理：L2 是结构化编译的产物，
//    掩码不在其声明面 ⇒ 插入值缺席（列缺省 null），冲突分支也不碰（同上，抹掉平台行的
//    掩码 = 掩码静默失效——那是安全面，更不能被一次租户写洗掉）。
// ⚠️ 下钻三列（drill_expr/drill_dims/drill_detail，下钻 spec 2026-10-21 §2.3）同理不写：
//    L2 没有「compose/dimensions/detail」这个输入 ⇒ 三列恒 NULL——「L2 不支持下钻」（spec §5）
//    由存储形状自然涌现（读侧 drillBindingOf 恒判 undefined），无需运行期特判。
// ⚠️ 测度档（basis，034）只由**首次插入**确定，冲突分支不碰：与 source 同一条纪律——
//    一次普通 L2 写（缺省档 = l1_tree）不得把私有测度行（column_agg）静默降档。
//    归档态（archived_at）同理不碰：归档是生命周期动作（Task 3 的淘汰 job），
//    一次内容写不得让它静默复活。
export async function upsertMetric(
  db: Pool | PoolClient, org: string, def: MetricDef, updatedBy: string,
  /**
   * `keepDraft`：确认生效路径专用——草稿的清除由 confirm 的**内容条件清除**收尾（竞态守卫），这里别抢。
   * `basis`：测度档（W2，034）。缺省 `l1_tree`（树形）；私有测度创建时显式传 `column_agg`。
   * `ownership`：归属四字段（047，P1 Task 3，spec §5.1）——变更单采纳路径经 writeL2Declaration
   *   透传；**缺席键 = 保留行上既有值**（冲突分支 coalesce），显式清空不是 P1 的案例。
   */
  opts?: { keepDraft?: boolean; basis?: MetricBasis; ownership?: MetricOwnership },
): Promise<void> {
  // see SQL 里的 draft_spec 分支：keepDraft = 确认路径（草稿清不清由调用方的条件清除决定）
  const keepDraft = opts?.keepDraft === true
  const basis: MetricBasis = opts?.basis === 'column_agg' ? 'column_agg' : 'l1_tree'
  const own = opts?.ownership
  // ★ `updatedBy` 是**必填**（不给默认值）：给了默认值就等于留一条「不写人也能写库」的暗道，
  //   而 #489 的全部意义就是堵它。⚠️ 调用方若直接传 Pool（如夹具），参数照传即可——
  //   生产写路径（domain/metric-write）传的是事务里的 client，审计与变更同生共死。
  await db.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by, params, source, source_system, updated_by, version, totalable, sla_days, freshness_relations, created_by, certified, basis, entity, synonyms, owner_dept, variant_note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'l2', null, $10, 1, false, null, null, $10, 'draft', $11, $12, $13::jsonb, $14, $15)
     on conflict (org, id) do update set
       title          = excluded.title,
       description    = excluded.description,
       required_scope = excluded.required_scope,
       subject_column = excluded.subject_column,
       select_sql     = excluded.select_sql,
       group_by       = excluded.group_by,
       params         = excluded.params,
       updated_by     = excluded.updated_by,
       version        = data.metrics.version + 1,   -- ★ 单调计数（追溯用；本表无并发写案例，不做乐观并发）
       -- ★ live 变更作废草稿（spec §10.4 D6，评审 #1271 发现 #3）：spec 一动，此前存下的
       --   draft_spec 就成了对着旧 spec 的陈稿——确认它会把管理员刚改的口径静默改回去。
       --   与其留一份没有 staleness 信号的旧稿，不如直接作废（creator 对着新 spec 重新起草）。
       --   ⚠️ 例外：确认生效路径（keepDraft）不在这里清——草稿的清除由 confirm 的内容条件
       --      清除收尾，这里抢清会把「load→清」的竞态守卫架空（并发新稿被静默吞掉）。
       ${keepDraft ? '' : 'draft_spec     = null,'}
       -- ★ 归属四列（047，P1 Task 3）：**缺席 = 保留**（coalesce 落到行上现值）——upsert 是
       --   内容写，一次不带归属的普通写（PUT/draft 确认/私有测度复活）不得把已声明的归属
       --   静默洗掉（与 created_at 不碰同一条纪律）。synonyms 的「缺席」以 NULL 表达
       --   （参数侧缺席键写 NULL 而非 '[]'，见下方参数注释）——jsonb 列可空，读侧归一成 []。
       entity       = coalesce(excluded.entity, data.metrics.entity),
       synonyms     = coalesce(excluded.synonyms, data.metrics.synonyms),
       owner_dept   = coalesce(excluded.owner_dept, data.metrics.owner_dept),
       variant_note = coalesce(excluded.variant_note, data.metrics.variant_note),
       updated_at     = now()`,
    [
      org, def.id, def.title, def.description, def.requiredScope,
      def.subjectColumn, def.selectSql, def.groupBy, JSON.stringify(def.params), updatedBy, basis,
      // 归属四列：缺席键一律 NULL（= 冲突分支「保留」信号；新行则落 NULL = 无归属）。
      // synonyms 刻意**不在缺席时写 '[]'**——'[]' 非 NULL，coalesce 挡不住，会把既有同义词洗成空。
      own?.entity ?? null,
      own?.synonyms === undefined ? null : JSON.stringify(own.synonyms),
      own?.ownerDept ?? null,
      own?.variantNote ?? null,
    ],
  )
}

/**
 * `drill_detail` 的物化形状 `{relation, filter, columns?}`——与 sync 的 `drillDetailOf`、
 * 读侧 `drillBindingOf` 同一闭集。
 *
 * `columns` 缺省**不写键**（缺席 ≠ 空数组）：声明侧 `comparableOf` 的比对面同形，写漏这一跳会让
 * `--check` 恒报更新（库侧读回「无 columns」、声明侧有 ⇒ 每日 sync job 永不收敛）。
 */
function drillDetailJson(drill: DrillBinding): string {
  return JSON.stringify(drill.columns === undefined
    ? { relation: drill.relation, filter: drill.filter }
    : { relation: drill.relation, filter: drill.filter, columns: drill.columns })
}

/**
 * **平台词表物化专用**：写 `org = 'platform'` 的 `source='l1'` 行。
 *
 * ⚠️ 唯一的合法调用方是 `scripts/sync-data-semantics.mjs`（L1 的 select_sql 只能从仓内 dbt
 *    YAML 物化）。管理 API **不得**调它——那等于让租户经 HTTP 写平台词表（跨租户能力）。
 *    测试里直调它是为了造 L1 夹具（等价于 sync 的产物）。
 *
 * 源系统（`source_system`）与其它语义字段**同进退**：声明是 L1 行的真值，故冲突分支也刷它
 * （改了声明的 `source` ⇒ 重新物化就跟上）。若只写首次插入，声明的源改了而库里不动，
 * `sync --check` 会永远报同一条漂移——而漂移报告是那套对账机制的全部产出。
 *
 * 可加标记（`totalable`，spec §8.4）同理同进退：sync 从声明 expression 推导（`deriveTotalable`），
 * 缺省 false（合成契约/夹具不带就是不可加——保守缺省不会给不明口径的指标编一个合计）；
 * 冲突分支也刷它（声明改成不可加 ⇒ 重新物化必须跟上，否则该指标永远多带一个错误的合计）。
 *
 * 新鲜度链路两列（`sla_days` / `freshness_relations`，spec §10.7）第三组同进退：
 * sync 从声明 `freshness_sla_days` / `sources` 路径段物化（缺声明 sync 响亮失败，无静默默认）；
 * 冲突分支也刷（声明改了 ⇒ 重新物化必须跟上，否则水位/固定行永远按旧链路算）。
 *
 * 值级掩码声明（`mask_spec`，spec 2026-10-17 §5.2）第四组同进退：sync 从声明 `mask` 物化
 * （声明侧 masksOf 校验含「column 须逐字在 selectSql 里」）；冲突分支也刷——声明撤了掩码
 * 而库里还留着 = 掩码静默生效（安全面宁可不生效也不能背着旧声明生效）。
 *
 * 下钻三列（`drill_expr` / `drill_dims` / `drill_detail`，下钻 spec 2026-10-21 §2.3/§2.5）第五组
 * 同进退：sync 从声明 compose/dimensions/detail 物化（未声明 compose 传 null）；冲突分支也刷——
 * 声明撤了下钻而库里还留着，读侧 `drillBindingOf` 虽判 undefined 不生效，但那是脏数据不是「未声明」。
 */
export async function upsertL1Metric(pool: Pool, def: L1MetricDef): Promise<void> {
  await pool.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by, params, source, source_system, totalable, scope_note, sla_days, freshness_relations, mask_spec, drill_expr, drill_dims, drill_detail, unit, entity, synonyms, basis)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'l1', $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17::jsonb, $18::jsonb, $19, $20, $21::jsonb, 'l1_tree')
     on conflict (org, id) do update set
       title          = excluded.title,
       description    = excluded.description,
       required_scope = excluded.required_scope,
       subject_column = excluded.subject_column,
       select_sql     = excluded.select_sql,
       group_by       = excluded.group_by,
       params         = excluded.params,
       source_system  = excluded.source_system,
       totalable      = excluded.totalable,
       scope_note          = excluded.scope_note,
       sla_days            = excluded.sla_days,
       freshness_relations = excluded.freshness_relations,
       mask_spec           = excluded.mask_spec,
       drill_expr          = excluded.drill_expr,
       drill_dims          = excluded.drill_dims,
       drill_detail        = excluded.drill_detail,
       -- 单位（§10.4.3 声明侧，2026-11-02 起）：与 sla_days/masks **同进退**——声明改了
       --    重新物化必须跟上，否则词表 unit 按旧声明显示（--check 也认它）。
       unit                = excluded.unit,
       -- 实体与同义词（W0，031）：与 unit 同进退——声明改了重新物化必须跟上，
       --    否则词表按旧声明做同义词/实体匹配（--check 也认它）。
       entity              = excluded.entity,
       synonyms            = excluded.synonyms,
       -- 测度档与归档（W2，034）：L1 行**恒** l1_tree / 恒未归档（平台口径的生命周期由声明/PR 管）。
       -- 冲突分支也刷：这两列被人误写（直改库）后，下一次物化必须把它们拉回不变式，
       -- 否则「L1 行 basis 恒 l1_tree」只是一句注释。
       basis               = 'l1_tree',
       archived_at         = null,
       updated_at     = now()`,
    [
      L1_ORG, def.id, def.title, def.description, def.requiredScope,
      def.subjectColumn, def.selectSql, def.groupBy, JSON.stringify(def.params),
      def.sourceSystem, def.totalable === true, def.scopeNote ?? '',
      def.slaDays, JSON.stringify(def.freshnessRelations),
      def.masks === null ? null : JSON.stringify(def.masks),
      // 下钻三列（spec §2.3）：未声明（null / 夹具缺省 undefined）⇒ 三列全 NULL，不半写——
      // 半写的残行读侧虽 fail-closed 判 undefined，但那是把「未声明」伪装成「残缺」，形状失真。
      def.drill == null ? null : def.drill.expr,
      def.drill == null ? null : JSON.stringify(def.drill.dims),
      def.drill == null ? null : drillDetailJson(def.drill),
      def.unit ?? null,
      // 实体 / 同义词（W0，031）：未声明（夹具缺省 undefined）⇒ NULL / '[]'。
      // synonyms 写 '[]' 而不是 NULL——库里恒数组，读侧归一之外再少一条「NULL 猜空」的分支。
      def.entity ?? null,
      JSON.stringify(def.synonyms ?? []),
    ],
  )
}

/**
 * 删除：返回是否真命中一行（没命中不是错误）。
 *
 * ★ `and source = 'l2'` 是**纪律落进 SQL**（不是靠调用方记得）：L1 行的 select_sql 只能由
 *   sync 脚本从仓内 YAML 物化，管理 API 对它**只读**。「只读」若写在注释里，就得靠每个新调用点
 *   自觉；写在 WHERE 里，任何调用点都删不掉 L1 行。L1 行的删除唯一路径是 sync 的差集处置
 *   （仓内声明没了 ⇒ 物化时删），那是另一条显式路径。
 */
export async function deleteMetric(db: Pool | PoolClient, org: string, id: string): Promise<boolean> {
  const r = await db.query(
    "delete from data.metrics where org = $1 and id = $2 and source = 'l2'",
    [org, id],
  )
  return (r.rowCount ?? 0) > 0
}

/**
 * 点读一行的**语义快照**（#489）：审计的前后态用它，它同时是「这次是建还是改」的判据
 * （写之前有没有这行）。
 *
 * `and source = 'l2'` 与 `deleteMetric` 同一条纪律：平台桶的 L1 行不经本路径，
 * 也就永远不会有「以它为主题」的审计行。
 * 返回类型 `MetricRowSnapshot` 定义在 `metric-audit-store.ts`（审计的形状），
 * 依赖方向是 store → audit-store，单向、无环。
 */
export async function selectMetricSnapshot(
  db: Pool | PoolClient, org: string, id: string,
): Promise<MetricRowSnapshot | null> {
  const r = await db.query(
    `select title, description, subject_column, select_sql, group_by, params, certified
       from data.metrics where org = $1 and id = $2 and source = 'l2'`,
    [org, id],
  )
  if ((r.rowCount ?? 0) === 0) return null
  const row = r.rows[0] as Record<string, unknown>
  return {
    title: row.title as string,
    description: row.description as string,
    subjectColumn: row.subject_column as string,
    selectSql: row.select_sql as string,
    groupBy: row.group_by as string,
    params: row.params as Record<string, unknown>,
    // 可信度（027，spec §10.4 D7）：certify 动作的前后态要带它（唯一变化物）；NULL（存量）按 draft
    certified: row.certified === 'certified' ? 'certified' : 'draft',
  }
}

/**
 * sync 专用：删掉本仓声明集里**已不存在**的 L1 行（双向差集的删除侧）。
 *
 * 与 `deleteMetric` 分开、且**不**带 `source = 'l2'`——它的作用域由 `org = L1_ORG and source='l1'`
 * 单独界定，绝不能让它能被租户 org 调到（那会变成「删别人的平台词表」）。
 */
export async function deleteStaleL1Metrics(pool: Pool, keepIds: readonly string[]): Promise<string[]> {
  const r = await pool.query(
    `delete from data.metrics
      where org = $1 and source = 'l1' and not (id = any($2::text[]))
      returning id`,
    [L1_ORG, keepIds],
  )
  return r.rows.map((row) => row.id as string)
}

/**
 * 租户声明写入（W8，041；`basis='declared'`、`source='l2'`、`certified='draft'`）。
 *
 * 只做**新建**（`on conflict do nothing`）：已存在（含 L1 id、含既有 L2 行）⇒ 返回 false，
 * 调用方回 409。更新/覆盖走 `override_metric_caliber`（P2）——两条路径的语义不同，
 * 不合成一个「upsert 万能函数」（同本文件上方「两个写入函数不是一个」的理由）。
 *
 * `declaration` 存**声明原文**：投影列是有损的（没有 owner/tier/sources/additivity），
 * 编辑回显/审计/重建都靠这一列，不从投影反推。
 */
export async function insertTenantDeclaration(
  db: Pool | PoolClient,
  org: string,
  d: CompiledTenantDeclaration,
  declaration: unknown,
  updatedBy: string,
  opts?: { overrideOf?: string | null },
): Promise<boolean> {
  const r = await db.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by, params,
        source, source_system, updated_by, version, totalable, scope_note, sla_days,
        freshness_relations, mask_spec, unit, entity, synonyms, basis, certified, created_by, declaration, override_of)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             'l2', $10, $11, 1, $12, $13, $14,
             $15::jsonb, $16::jsonb, $17, $18, $19::jsonb, 'declared', 'draft', $11, $20::jsonb, $21)
     on conflict (org, id) do nothing
     returning id`,
    [
      org, d.id, d.title, d.description, d.requiredScope, d.subjectColumn, d.selectSql,
      d.groupBy, JSON.stringify(d.params), d.sourceSystem, updatedBy, d.totalable, d.scopeNote,
      d.slaDays, JSON.stringify(d.freshnessRelations),
      d.masks === null ? null : JSON.stringify(d.masks), d.unit, d.entity,
      JSON.stringify(d.synonyms), JSON.stringify(declaration), opts?.overrideOf ?? null,
    ],
  )
  return (r.rowCount ?? 0) > 0
}

/** 确认一条租户覆盖（D6：草稿→确认→生效）。没有 draft 覆盖行 ⇒ false（调用方回 404）。 */
export async function confirmOverrideDeclaration(
  db: Pool | PoolClient, org: string, id: string, updatedBy: string,
): Promise<boolean> {
  const r = await db.query(
    `update data.metrics
        set certified = 'certified', updated_by = $3, version = version + 1, updated_at = now()
      where org = $1 and id = $2 and source = 'l2' and override_of = $2 and certified = 'draft'
      returning id`,
    [org, id, updatedBy],
  )
  return (r.rowCount ?? 0) > 0
}

/** 删除一条租户覆盖（回落到平台 L1 口径）。返回是否真删了一行。 */
export async function deleteOverrideDeclaration(
  db: Pool | PoolClient, org: string, id: string,
): Promise<boolean> {
  const r = await db.query(
    `delete from data.metrics
      where org = $1 and id = $2 and source = 'l2' and override_of = $2
      returning id`,
    [org, id],
  )
  return (r.rowCount ?? 0) > 0
}


/** 本 org 的全部口径覆盖（含草稿；管理面用——草稿不在合并词表里，必须单独可见）。 */
export async function listOverrideDeclarations(
  pool: Pool, org: string,
): Promise<Array<{ id: string; title: string; certified: 'certified' | 'draft'; selectSql: string; updatedBy: string | null; version: number; updatedAt: string | null }>> {
  const r = await pool.query(
    `select id, title, certified, select_sql, updated_by, version, updated_at
       from data.metrics
      where org = $1 and source = 'l2' and override_of is not null
      order by id`,
    [org],
  )
  return r.rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    certified: row.certified === 'certified' ? 'certified' as const : 'draft' as const,
    selectSql: row.select_sql as string,
    updatedBy: (row.updated_by ?? null) as string | null,
    version: Number(row.version ?? 1),
    updatedAt: row.updated_at === null || row.updated_at === undefined ? null : String(row.updated_at),
  }))
}
