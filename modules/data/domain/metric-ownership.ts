// metric-ownership.ts —— 指标概念与部门归属的写侧判据（spec §5.1/§5.3，Wave 5 P1 Task 2）。
//
// 职责只有两件，都是**提交/写路径上的前置校验**（fail-closed 的可读错误面）：
//   ① 概念归属：`entity` 必须已声明——平台概念（`dbt/semantics/l1_metrics.yml` 顶层 `entities`）
//      ∪ 租户概念（`data.metric_concept`）。L2「解不出基底 ⇒ entity 留空」是合法形态，null 放行。
//   ② 部门内同名互斥：与 047 的唯一索引 `metrics_title_per_dept_uq (org, coalesce(owner_dept,''),
//      lower(title))` **同一判据**——索引兜并发（双写必有一个被 DB 拒），本判据把同一件事在
//      提交期变成可读的 `TITLE_EXISTS_IN_DEPT`（带回撞到的 existingId），而不是裸的 23505。
//
// 概念集**不缓存**：每次调用现读。理由有二——① 调用量在「提交变更单」这一频次（人操作级），
// 一次同步 fs 读 + 一条 SQL 不构成热点；② 缓存会让「平台 YAML 刚更新/租户刚新增概念」滞后一个
// 进程生命周期，而语义治理 P1 的卖点恰是「即时生效」。测试注入走 `baseDir`（与
// readCurrentSemanticsYaml 同一条缝），不走全局 mutable 状态。
import { readCurrentSemanticsYaml, SEMANTICS_YAML_REL } from './pipelines/propose-metric'
import { REPO_ROOT } from './pipelines/defs'
import { isMap, parseDocument } from 'yaml'
import type { Pool, PoolClient } from 'pg'

/** 写侧归属判据的领域错误：`code` 是稳定契约面（Task 3 的 SubmitOutcome/http 映射按名消费）。 */
export class OwnershipError extends Error {
  readonly code: string
  readonly extra?: Record<string, unknown>

  constructor(code: string, extra?: Record<string, unknown>) {
    super(OwnershipError.messageOf(code, extra))
    this.name = 'OwnershipError'
    this.code = code
    this.extra = extra
  }

  /** 文案集中一处；`code` 才是对外契约，文案只对人。 */
  private static messageOf(code: string, extra?: Record<string, unknown>): string {
    if (code === 'UNKNOWN_CONCEPT') {
      return `未知概念「${String(extra?.entity ?? '')}」——entity 必须在平台 entities 或租户 metric_concept 里声明过`
    }
    if (code === 'TITLE_EXISTS_IN_DEPT') {
      return `同部门桶内已有同名指标（existingId=${String(extra?.existingId ?? '')}）——部门内同名互斥`
    }
    return code
  }
}

/**
 * 平台概念集：解析 `${baseDir}/dbt/semantics/l1_metrics.yml` 顶层 `entities` 的键。
 * 只取键名（label/synonyms 是问数侧的消费面，归属判据只认「声明过没有」）。
 *
 * 文件不可读 ⇒ **空集 + console.warn，不抛**（生产镜像内有该文件；读不到是部署形状异常，
 * 告警归告警，别让一个只读文件的缺席把整条写路径炸成 500）。
 * `baseDir` 是测试注入缝（与 readCurrentSemanticsYaml 同形；缺省仓根，镜像内即 /app）。
 */
export const platformConcepts = (baseDir: string = REPO_ROOT): ReadonlySet<string> => {
  const text = readCurrentSemanticsYaml(baseDir)
  if (text === null) {
    console.warn(`[metric-ownership] ${SEMANTICS_YAML_REL} 不可读（baseDir=${baseDir}）——平台概念集按空集处理`)
    return new Set()
  }
  try {
    const entities = parseDocument(text).get('entities', true)
    const out = new Set<string>()
    if (isMap(entities)) {
      for (const pair of entities.items) {
        // YAML 键经 AST 是 Scalar；与 propose-metric 的 keyNameOf 同一取法（非 string 键跳过）。
        const k = (pair.key as { value?: unknown } | null)?.value
        if (typeof k === 'string' && k !== '') out.add(k)
      }
    }
    return out
  } catch (e) {
    // YAML 在场但解析炸了（半截文件/手改坏）——同「不可读」档：空集 + warn，不炸写路径。
    console.warn(`[metric-ownership] ${SEMANTICS_YAML_REL} 解析失败——平台概念集按空集处理`, e)
    return new Set()
  }
}

/** 租户概念集：`data.metric_concept` 里本 org 的概念名（047 建表；租户语义自治的写面）。 */
export const tenantConcepts = async (pool: Pool | PoolClient, org: string): Promise<ReadonlySet<string>> => {
  const r = await pool.query('select name from data.metric_concept where org = $1', [org])
  return new Set(r.rows.map((row: { name: string }) => row.name))
}

/**
 * 概念归属判据：`entity` 非空时必须落在 平台 ∪ 租户 的并集里，否则 `UNKNOWN_CONCEPT`。
 * `null` / `''` = 未声明（L2 解不出基底），不校验直接放行——「归属」是选填不是必填。
 */
export const assertConcept = async (
  pool: Pool | PoolClient, org: string, entity: string | null,
): Promise<void> => {
  if (entity === null || entity === '') return
  const union = new Set([...platformConcepts(), ...(await tenantConcepts(pool, org))])
  if (!union.has(entity)) throw new OwnershipError('UNKNOWN_CONCEPT', { entity })
}

/**
 * 部门内同名判据：`(org, coalesce(owner_dept,''), lower(title))` 命中且 id ≠ exclude ⇒
 * `TITLE_EXISTS_IN_DEPT`（extra 带 `existingId`）。谓词与 047 唯一索引逐字同构——
 * 两把尺必须同构，否则会出现「判据放行、索引拒绝」（提交成功、采纳炸 23505）的裂缝。
 * `excludeMetricId` 是改名场景（update 档）：命中行就是自己 ⇒ 放行；缺省按 `''` 收口（恒不排除）。
 */
export const assertTitleFree = async (
  pool: Pool | PoolClient, org: string, ownerDept: string | null, title: string,
  excludeMetricId?: string,
): Promise<void> => {
  const r = await pool.query(
    `select id from data.metrics
      where org = $1
        and coalesce(owner_dept, '') = coalesce($2, '')
        and lower(title) = lower($3)
        and id <> coalesce($4, '')
      limit 1`,
    [org, ownerDept, title, excludeMetricId ?? ''],
  )
  const hit = r.rows[0] as { id: string } | undefined
  if (hit !== undefined) throw new OwnershipError('TITLE_EXISTS_IN_DEPT', { existingId: hit.id })
}
