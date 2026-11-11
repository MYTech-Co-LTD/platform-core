// private-measures.ts — W2 私有测度（`basis='column_agg'`）与候选池的 HTTP 面。
//
//   POST /metrics/private                    新建（manifest: data:query；真判据在域层）
//   GET  /metrics/private/archived           归档行读面（manifest: data:manage）
//   POST /metrics/candidates/generate        批量 profile → 规则筛 → 候选池（manifest: data:manage）
//   POST /metrics/candidates/:id/adopt       候选 → 私有测度（manifest: data:manage；三闸在域层）
//   POST /metrics/candidates/:id/propose-l1  候选 → L1 声明草案（W3，#1401；零写盘，manifest: data:manage）
//
// 门禁由宿主按 manifest 的 `api.internal` 施加——本文件**不写** requireScope（与 metrics.ts 同纪律）。
//
// 为什么新建申报 data:query（与 D6 草稿端点同档）：一次新建的 creator 就是调用者自己，
// 「data:manage ∪ creator」的并集用单一宿主 scope 表达不了 ⇒ 取低档进门，真判据在域层
// `writePrivateMeasure`（同源闸见那里：修改走 D6；归档复活需 creator ∪ data:manage）。
// 持 data:manage 的 PAT 需同时持 data:query 才能走此端点——与 /metrics/:id/meta 的取舍一致。
// 候选池三条相反：**批量生成/采用/升级提案是管理动作**，没有「creator 是谁」的歧义 ⇒ 直接申报 data:manage。
//
// 形状校验（zod）只做「是不是一份完整的列级聚合声明」；白名单/实际列/维度三闸在
// `domain/private-measure.ts`（需要 DB，不能进路由）。候选里存的 expr 是**输入，不是可信 SQL**：
// adopt 把它整份交给 `writePrivateMeasure`，三闸 + 编译一处不少；propose-l1 把它组装成
// `MetricDeclarationInput` 交给 Task 1 的组装器（propose-metric），机检一处不少。
import { z } from 'zod'
import type { Context } from 'hono'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { parseIdParam, requesterOf, writeOutcome } from './context'
import { COLUMN_AGG_FUNCS, parseL1Select } from '../domain/semantic-compiler'
import type { ColumnAggFunc } from '../domain/semantic-compiler'
import { writePrivateMeasure } from '../domain/metric-write'
import type { PrivateMeasureWriteDeps } from '../domain/metric-write'
import { loadPlatformCatalog } from '../domain/metric-store'
import type { MetricRow } from '../domain/metric-store'
import { whitelistedRelations } from '../domain/private-measure'
import { claimCandidate, getCandidate, listCandidates, rejectCandidate, setCandidateStatus } from '../domain/metric-candidates'
import type { Candidate, CandidateOrigin, CandidateStatus } from '../domain/metric-candidates'
import { generateCandidates } from '../domain/candidate-generator'
import type { CandidateGeneratorDeps } from '../domain/candidate-generator'
import { listArchivedPrivateMeasures } from '../domain/private-measure-lifecycle'
import { rootsOf } from '../domain/pipelines/defs'
import { composeMetricDeclaration, readCurrentSemanticsYaml, SEMANTICS_YAML_REL } from '../domain/pipelines/propose-metric'
import { NOTE } from '../domain/pipelines/propose'

const orgOf = (c: Context<ModuleVars>): string => c.get('tenant').casdoor_org

/** 候选状态词表（读面过滤用）。域层 `CandidateStatus` 是唯一事实源——这里只判「是不是其中一员」。 */
const CANDIDATE_STATUSES: ReadonlySet<string> = new Set<CandidateStatus>([
  'pending', 'created', 'promoted', 'rejected', 'expired',
])
const CANDIDATE_ORIGINS: ReadonlySet<string> = new Set<CandidateOrigin>(['profile', 'demand'])
/** 读面上限（候选池可能很大；不传按 200 收口，传大了也按 500 收口——不让一次请求拖垮连接）。 */
const CANDIDATE_LIST_DEFAULT = 200
const CANDIDATE_LIST_MAX = 500

/**
 * POST body：行属性（id/title/description）+ 列级聚合声明（agg/column/dims/relation）。
 *
 * `.strict()` 与 L2 的写面同一纪律：`selectSql` / `groupBy` 等实现细节混进来 ⇒ **400**，
 * 不是静默忽略——否则调用方会以为自己写的 SQL 生效了。
 */
const PrivateMeasureBody = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  agg: z.enum(COLUMN_AGG_FUNCS),
  column: z.string().min(1).max(128),
  dims: z.array(z.string().min(1).max(128)).max(64).optional(),
  relation: z.string().min(1).max(256),
}).strict()

/**
 * 候选生成 body（全部可省 ⇒ 空 body = 全白名单关系、每关系 20 条）。
 * `.strict()`：`maxPerRelation` 之类拼错键时**400**，不是静默按默认值跑一遍（那会写出候选却
 * 让调用方以为限流生效了）。
 */
const GenerateCandidatesBody = z.object({
  relations: z.array(z.string().min(1).max(256)).max(64).optional(),
  maxPerRelation: z.number().int().min(1).max(20).optional(),
}).strict()

/**
 * 采用 body：`id` 是**新指标的句柄**（候选的 bigserial 不是指标 id）；title 可省（按算式派生）。
 * 刻意不收 agg/column/dims/relation——算式只来自候选行（候选是输入，但**不由客户端改写**）。
 */
const AdoptCandidateBody = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
}).strict()

/**
 * propose-l1 body（W3 #1401）：`name`/`label` 由调用方给；`definition`/`owner`/`auditSql` 可省
 * （缺省派生：definition = 算式的逐字陈述、owner = 调用者、auditSql 缺席由组装器记 validation）。
 * 刻意不收 agg/column/dims/relation——算式只来自候选行（与 adopt 同纪律：候选是输入，不由客户端改写）。
 * `name` 在 schema 里可省但**语义必填**：缺席 ⇒ 400 + 服务端派生的命名建议（NAME_REQUIRED），
 * 人确认后才落提案——标识符决定对账文件名（`:`→`__`），机器不代决。
 */
const ProposeL1Body = z.object({
  name: z.string().max(200).optional(),
  label: z.string().min(1).max(200),
  definition: z.string().min(1).max(2000).optional(),
  owner: z.string().min(1).max(100).optional(),
  auditSql: z.string().min(1).optional(),
}).strict()

// ── 候选 → MetricDeclarationInput 的组装映射（纯函数；机检全在组装器，这里只做形状翻译）──────

/**
 * 候选聚合 → 提案侧单列聚合表达式（组装器 AGG_SIMPLE_RE 的收严形态：`agg(关系.列)` 单点引用，
 * 与现行 l1_metrics.yml 的条目同形态；`count_distinct` 展开成 `count(distinct …)`）。
 */
const aggExpressionOf = (candidate: Candidate): string =>
  candidate.expr.agg === 'count_distinct'
    ? `count(distinct ${candidate.relation}.${candidate.expr.column})`
    : `${candidate.expr.agg}(${candidate.relation}.${candidate.expr.column})`

/**
 * definition 缺省：候选算式的逐字陈述。它是**草稿**不是终稿（tier=experimental 已标明成熟度），
 * PR 评审时由人改写成正式口径定义；机器不编「看起来像定义」的业务话术。
 */
const defaultDefinitionOf = (candidate: Candidate): string =>
  candidate.expr.dims.length > 0
    ? `${aggExpressionOf(candidate)} 按 ${candidate.expr.dims.join('、')} 分组`
    : aggExpressionOf(candidate)

/** evidence 摘要只挑认识的键（键序固定）——profiler 的证据形状漂移时文案降级，不炸路由。 */
const EVIDENCE_KEYS = ['source', 'profileRelation', 'dataType', 'columnType', 'count',
  'nullPercentage', 'approxUnique', 'profiledAt'] as const

const evidenceSummaryOf = (evidence: Record<string, unknown>): string =>
  EVIDENCE_KEYS
    .filter((k) => evidence[k] !== undefined && evidence[k] !== null && evidence[k] !== '')
    .map((k) => `${k}=${String(evidence[k])}`)
    .join('；')

/** rationale：候选血统（id/origin/confidence）+ evidence 摘要 + 候选原文（进回包，供 apply 的 --rationale 复用）。 */
const promotionRationaleOf = (candidate: Candidate): string => {
  const head = `候选 #${candidate.id}（origin=${candidate.origin}，confidence=${candidate.confidence}）升级为 L1 声明草案`
  const summary = evidenceSummaryOf(candidate.evidence)
  const rationale = candidate.rationale === '' ? '' : `；候选 rationale：${candidate.rationale}`
  return summary === '' ? `${head}${rationale}` : `${head}；证据：${summary}${rationale}`
}

/** 同关系既有 L1 声明的第一行（name/SLA 缺省派生用；坏 select_sql 跳过不抛——方向是少派生）。 */
function l1RowOnRelation(candidate: Candidate, catalog: readonly MetricRow[]): MetricRow | null {
  for (const row of catalog) {
    if (row.source !== 'l1' || row.basis !== 'l1_tree') continue
    try {
      if (parseL1Select(row.selectSql).relation === candidate.relation) return row
    } catch {
      continue
    }
  }
  return null
}

/**
 * name 缺席时的派生建议：`<源>:<域>:<列>_<聚合>`。前两段取**同关系既有 L1 声明**（它必然已过
 * 命名空间三段式；W2 白名单本身就是 L1 已用集 ⇒ 走到这里的候选关系上必有声明）。
 * 无可派生的三段式声明 ⇒ null（理论不可达；如实回 null 不编造）。
 */
function suggestedNameOf(candidate: Candidate, catalog: readonly MetricRow[]): string | null {
  const base = l1RowOnRelation(candidate, catalog)
  const parts = (base?.id ?? '').split(':')
  if (parts.length !== 3) return null
  return `${parts[0]}:${parts[1]}:${candidate.expr.column}_${candidate.expr.agg}`
}

/** freshness_sla_days 缺省：同关系既有声明的承诺（同关系同数据延迟）；没有 ⇒ 1（现行文件的主流档）。 */
const defaultSlaOf = (candidate: Candidate, catalog: readonly MetricRow[]): number =>
  l1RowOnRelation(candidate, catalog)?.slaDays ?? 1

export function registerPrivateMeasures(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/metrics/private', async (c) => {
    const requester = requesterOf(c)
    // 写入必须能归属到人（审计要记 created_by）；无身份 ⇒ 拒，不写「无主」审计。
    if (requester === null || requester.userId.trim() === '') {
      return c.json({ error: 'UNAUTHENTICATED' }, 403)
    }
    const parsed = PrivateMeasureBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { id, title, description, ...decl } = parsed.data
    const deps: PrivateMeasureWriteDeps = {
      pool: ctx.pool,
      requester,
      // 生产不传 ⇒ 域层走 warehousePool()；测试注入同一个库的替身
      ...(ctx.warehouse === undefined ? {} : { warehouse: ctx.warehouse }),
    }
    return writeOutcome(c, await writePrivateMeasure(deps, orgOf(c), {
      id, title, ...(description === undefined ? {} : { description }), ...decl,
    }), 201)
  })

  r.get('/metrics/private/archived', async (c) => {
    const requester = requesterOf(c)
    // 与 GET /metrics 同口径：无身份不是报错，也不是全租户数据
    if (requester === null) return c.json({ metrics: [] })
    return c.json({ metrics: await listArchivedPrivateMeasures(ctx.pool, orgOf(c)) })
  })

  // ── 候选池（W2 Task 5：批量 profile 产出 = 只进候选池，一键采用才上台）──────────
  r.post('/metrics/candidates/generate', async (c) => {
    const requester = requesterOf(c)
    // 候选表没有 created_by，但生成是**写动作**：仍要求身份（不写匿名动作；门禁另有 data:manage）
    if (requester === null || requester.userId.trim() === '') {
      return c.json({ error: 'UNAUTHENTICATED' }, 403)
    }
    // 空 body 视为 `{}`（全白名单关系、每关系 20 条）；**畸形 JSON 必须 400**——它是写动作，
    // 把解析失败当空 body 跑全量生成会让调用方在「手滑」时意外写一池候选。
    const text = await c.req.text().catch(() => '')
    let rawBody: unknown = {}
    if (text.trim() !== '') {
      try {
        rawBody = JSON.parse(text)
      } catch {
        return c.json({ error: 'INVALID_BODY' }, 400)
      }
    }
    const parsed = GenerateCandidatesBody.safeParse(rawBody)
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const deps: CandidateGeneratorDeps = {
      pool: ctx.pool,
      // 生产不传 ⇒ 域层走 warehousePool()；测试注入同一个库的替身
      ...(ctx.warehouse === undefined ? {} : { warehouse: ctx.warehouse }),
    }
    const result = await generateCandidates(deps, orgOf(c), parsed.data)
    if (!result.ok) {
      // 全是环境/平台问题（仓库没配 / 画像表缺失 / 平台库不可用）⇒ 500：监控必须看得见，
      // 不能折成「0 条候选」的 200（那会让「profiler 没投递」沉默数周）。
      return c.json(
        { error: result.code, ...(result.detail === undefined ? {} : { detail: result.detail }) },
        500,
      )
    }
    return c.json(result.report)
  })

  // ── 候选池读面（Wave 1.4）：人得先「看得见」才谈得上决策 ──────────────────────────
  // 默认全状态、按置信降序；`status` / `origin` 过滤走域层（枚举校验在这里，域层只收窄）。
  // 与 GET /metrics/verified 同口径：**无身份不列任何行**（不是报错，也不是全租户数据）。
  r.get('/metrics/candidates', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ candidates: [] })

    const statusRaw = c.req.query('status')
    if (statusRaw !== undefined && !CANDIDATE_STATUSES.has(statusRaw)) {
      return c.json({ error: 'INVALID_STATUS', allowed: [...CANDIDATE_STATUSES] }, 400)
    }
    const originRaw = c.req.query('origin')
    if (originRaw !== undefined && !CANDIDATE_ORIGINS.has(originRaw)) {
      return c.json({ error: 'INVALID_ORIGIN', allowed: [...CANDIDATE_ORIGINS] }, 400)
    }
    const relation = c.req.query('relation')
    // limit：非数字/非正 ⇒ 400（静默回默认会让调用方以为「给了就被尊重」）；超上限按上限收口。
    const limitRaw = c.req.query('limit')
    let limit = CANDIDATE_LIST_DEFAULT
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isInteger(n) || n < 1) return c.json({ error: 'INVALID_LIMIT' }, 400)
      limit = Math.min(n, CANDIDATE_LIST_MAX)
    }
    return c.json({
      candidates: await listCandidates(ctx.pool, orgOf(c), {
        ...(statusRaw === undefined ? {} : { status: statusRaw as CandidateStatus }),
        ...(originRaw === undefined ? {} : { origin: originRaw as CandidateOrigin }),
        ...(relation === undefined || relation === '' ? {} : { relation }),
        limit,
      }),
      limit,
    })
  })

  // 候选 → rejected（人工决策面）。与 adopt 同款 CAS 纪律：
  //   ① 只认 pending（其余状态都是已经发生的决策，静默覆盖会抹掉「谁先决定的」）；
  //   ② 抢不到时**重读**一次判 404 / 409——不把并发失败当成「不存在」。
  r.post('/metrics/candidates/:id/reject', async (c) => {
    const requester = requesterOf(c)
    // 拒绝要能归属到人：审批链、复盘都靠这一条（与 adopt 同口径）。
    if (requester === null || requester.userId.trim() === '') {
      return c.json({ error: 'UNAUTHENTICATED' }, 403)
    }
    const candidateId = parseIdParam(c.req.param('id'))
    if (candidateId === null) return c.json({ error: 'NOT_FOUND' }, 404)

    const org = orgOf(c)
    const candidate = await getCandidate(ctx.pool, org, candidateId)
    if (candidate === null) return c.json({ error: 'NOT_FOUND' }, 404)
    if (candidate.status !== 'pending') {
      return c.json({ error: 'CANDIDATE_NOT_REJECTABLE', status: candidate.status }, 409)
    }
    const rejected = await rejectCandidate(ctx.pool, org, candidateId)
    if (!rejected) {
      // 并发输了：别人先用了/拒了/退役了。重读拿真实状态（读不到 = 刚被别人删掉 ⇒ 404）。
      const current = await getCandidate(ctx.pool, org, candidateId)
      if (current === null) return c.json({ error: 'NOT_FOUND' }, 404)
      return c.json({ error: 'CANDIDATE_NOT_REJECTABLE', status: current.status }, 409)
    }
    return c.json({ ok: true, candidateStatus: 'rejected' }, 200)
  })

  r.post('/metrics/candidates/:id/adopt', async (c) => {
    const requester = requesterOf(c)
    if (requester === null || requester.userId.trim() === '') {
      return c.json({ error: 'UNAUTHENTICATED' }, 403)
    }
    const candidateId = parseIdParam(c.req.param('id'))
    if (candidateId === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = AdoptCandidateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const org = orgOf(c)
    const candidate = await getCandidate(ctx.pool, org, candidateId)
    if (candidate === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 只采用 pending。其余状态都是**决策**（created 已用过 / rejected·expired 终态 /
    // promoted 已进 L1 提案）——静默「再用一次」会把人工决策抹掉（与 upsert 不复活 rejected 同纪律）。
    if (candidate.status !== 'pending') {
      return c.json({ error: 'CANDIDATE_NOT_ADOPTABLE', status: candidate.status }, 409)
    }
    // ★ CAS 占位（评审 Minor 5）：先原子地把 pending→created，抢不到说明并发请求已采用/已改状态。
    //   状态是**互斥锁**不是事后标记 ⇒ 同一候选不会被两个请求各建一条私有测度。
    const claimed = await claimCandidate(ctx.pool, org, candidateId)
    if (!claimed) {
      const current = await getCandidate(ctx.pool, org, candidateId)
      return c.json({ error: 'CANDIDATE_NOT_ADOPTABLE', status: current?.status ?? 'unknown' }, 409)
    }

    const title = parsed.data.title
      ?? `${candidate.relation} ${candidate.expr.agg}(${candidate.expr.column})`
    let outcome: Awaited<ReturnType<typeof writePrivateMeasure>>
    try {
      outcome = await writePrivateMeasure(
        {
          pool: ctx.pool,
          requester,
          ...(ctx.warehouse === undefined ? {} : { warehouse: ctx.warehouse }),
        },
        org,
        {
          id: parsed.data.id,
          title: title.slice(0, 200),
          // description 缺省 = 候选的 rationale（血统落进指标描述：管理面看得出「这条是画像推出来的」）。
          // 显式传了 description 就用传的（人改过的文案优先）。
          description: parsed.data.description ?? candidate.rationale,
          // ★ 候选存的 expr 是**输入不是可信 SQL**：agg/列名/维度全部重走写路径的三闸 + 编译。
          agg: candidate.expr.agg as ColumnAggFunc,
          column: candidate.expr.column,
          dims: candidate.expr.dims,
          relation: candidate.relation,
          // 血统跟着候选走（评审 Minor 4）：generate 产的是 profile；对话/挖掘来的候选标 demand。
          origin: candidate.origin,
        },
      )
    } catch (e) {
      // 写测度**抛错**（如 warehousePool() 未配置）时 CAS 占位不会走下面的 !ok 回滚 ⇒
      // 候选会永久卡在 created。这里同样回滚成 pending 再上抛原错误（回滚失败不回滚错误语义）。
      await setCandidateStatus(ctx.pool, org, candidateId, 'pending').catch(() => undefined)
      throw e
    }
    if (!outcome.ok) {
      // 采用失败：把占位**回滚**成 pending（否则候选永久卡在 created，且没有对应测度）。
      // 回滚本身失败不回滚错误语义：调用方拿到的是真正的失败原因（写测度没成功）。
      await setCandidateStatus(ctx.pool, org, candidateId, 'pending')
      return c.json({ error: outcome.error, ...(outcome.extra ?? {}) }, outcome.http)
    }
    return c.json({ ok: true, metricId: parsed.data.id, candidateStatus: 'created' }, 201)
  })

  // ── 候选 → L1 声明草案（W3 Task 3，#1401：升级链的**只读**半程）──────────────────────────
  // 零写盘：草案（pieces）只进回包；落盘/开 PR 由人拿去走 MCP 工具面 apply_pipeline_proposal。
  // 算式只来自候选行；name/label 由调用方给（标识符是人决——对账文件名由 name 派生）。
  r.post('/metrics/candidates/:id/propose-l1', async (c) => {
    const requester = requesterOf(c)
    if (requester === null || requester.userId.trim() === '') {
      return c.json({ error: 'UNAUTHENTICATED' }, 403)
    }
    const candidateId = parseIdParam(c.req.param('id'))
    if (candidateId === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = ProposeL1Body.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const org = orgOf(c)
    const candidate = await getCandidate(ctx.pool, org, candidateId)
    if (candidate === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // pending = 新候选；promoted = 已出过草案（重出 = 幂等）。其余状态都是**决策**
    // （created 已落测度 / rejected·expired 终态）——静默「再提一次」会把人工决策抹掉。
    if (candidate.status !== 'pending' && candidate.status !== 'promoted') {
      return c.json({ error: 'CANDIDATE_NOT_PROMOTABLE', status: candidate.status }, 409)
    }

    // L1 词表：B11 路由侧复核 + name/SLA 缺省派生的事实源。库不可用 ⇒ 500（环境错不是输入错，
    // 折成 400 会让调用方去改一份本来没错的输入）。
    let catalog: MetricRow[]
    try {
      catalog = await loadPlatformCatalog(ctx.pool)
    } catch (e) {
      return c.json({ error: 'CATALOG_UNAVAILABLE', detail: e instanceof Error ? e.message : String(e) }, 500)
    }
    // B11（路由侧先拒，组装器还有一道兜底）：候选关系必须已在 L1 用集合里。候选在生成时
    // 已被归一到白名单形态（candidate-generator 的 canonicalRelation），此处只复核。
    if (!whitelistedRelations(catalog).has(candidate.relation)) {
      return c.json({ error: 'RELATION_NOT_PROMOTABLE', relation: candidate.relation }, 400)
    }

    // name 必须由调用方给：缺席 ⇒ 400 + 派生建议（人确认后重提）。建议不自动采用——
    // 标识符决定对账文件名，机器代决一次，「候选 #12」就永远说不清自己叫什么。
    const name = parsed.data.name?.trim() ?? ''
    if (name === '') {
      return c.json({ error: 'NAME_REQUIRED', suggestedName: suggestedNameOf(candidate, catalog) }, 400)
    }

    // 现行语义声明（**只读**；repoRoot 是测试缝，缺省 = 模块位置解析的仓根，镜像内 /app）。
    const current = readCurrentSemanticsYaml(ctx.repoRoot)
    if (current === null) {
      return c.json({
        error: 'SEMANTICS_UNREADABLE',
        detail: `现行 ${SEMANTICS_YAML_REL} 不可读——无法组装全量草案（未知 ≠ 基线为空，不许静默当空文件）`,
      }, 500)
    }

    const rationale = promotionRationaleOf(candidate)
    const draft = composeMetricDeclaration(rootsOf(process.env, ctx.repoRoot), {
      name,
      label: parsed.data.label,
      definition: parsed.data.definition ?? defaultDefinitionOf(candidate),
      expression: aggExpressionOf(candidate),
      grain: candidate.expr.dims,
      owner: parsed.data.owner ?? requester.userId,
      // 机器产的草案恒 experimental（tier 是成熟度标记；转 certified 是人在 PR 里的决策）
      tier: 'experimental',
      // 源 = name 命名空间首段（与「带源段才能让第二个源同名不撞键」的命名约定同源）
      source: name.split(':')[0] ?? '',
      freshnessSlaDays: defaultSlaOf(candidate, catalog),
      auditSql: parsed.data.auditSql,
      rationale,
    }, current)
    if (!draft.ok) {
      // 组装器机检（含 B11 兜底）逐字段 issues 原样透出——调用方按 path 逐项可修。
      return c.json({ error: 'INVALID_DECLARATION', issues: draft.issues }, 400)
    }

    // ★ 组装成功后才置 promoted（非 CAS：本路由只读候选 + 产草案，没有并发争用面；
    //   组装失败状态不动——上面每条 400/409 都发生在置状态之前）。
    await setCandidateStatus(ctx.pool, org, candidateId, 'promoted')
    return c.json({
      ok: true,
      candidateId,
      mode: draft.mode,
      title: draft.title,
      branch: draft.branch,
      pieces: draft.pieces,
      downstream: draft.downstream,
      validation: draft.validation,
      rationale,
      note: NOTE,
    }, 200)
  })
}
