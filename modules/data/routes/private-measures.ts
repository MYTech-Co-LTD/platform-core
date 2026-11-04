// private-measures.ts — W2 私有测度（`basis='column_agg'`）与候选池的 HTTP 面。
//
//   POST /metrics/private                    新建（manifest: data:query；真判据在域层）
//   GET  /metrics/private/archived           归档行读面（manifest: data:manage）
//   POST /metrics/candidates/generate        批量 profile → 规则筛 → 候选池（manifest: data:manage）
//   POST /metrics/candidates/:id/adopt       候选 → 私有测度（manifest: data:manage；三闸在域层）
//
// 门禁由宿主按 manifest 的 `api.internal` 施加——本文件**不写** requireScope（与 metrics.ts 同纪律）。
//
// 为什么新建申报 data:query（与 D6 草稿端点同档）：一次新建的 creator 就是调用者自己，
// 「data:manage ∪ creator」的并集用单一宿主 scope 表达不了 ⇒ 取低档进门，真判据在域层
// `writePrivateMeasure`（同源闸见那里：修改走 D6；归档复活需 creator ∪ data:manage）。
// 持 data:manage 的 PAT 需同时持 data:query 才能走此端点——与 /metrics/:id/meta 的取舍一致。
// 候选池两条相反：**批量生成/采用是管理动作**，没有「creator 是谁」的歧义 ⇒ 直接申报 data:manage。
//
// 形状校验（zod）只做「是不是一份完整的列级聚合声明」；白名单/实际列/维度三闸在
// `domain/private-measure.ts`（需要 DB，不能进路由）。候选里存的 expr 是**输入，不是可信 SQL**：
// adopt 把它整份交给 `writePrivateMeasure`，三闸 + 编译一处不少。
import { z } from 'zod'
import type { Context } from 'hono'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { parseIdParam, requesterOf, writeOutcome } from './context'
import { COLUMN_AGG_FUNCS } from '../domain/semantic-compiler'
import type { ColumnAggFunc } from '../domain/semantic-compiler'
import { writePrivateMeasure } from '../domain/metric-write'
import type { PrivateMeasureWriteDeps } from '../domain/metric-write'
import { claimCandidate, getCandidate, setCandidateStatus } from '../domain/metric-candidates'
import { generateCandidates } from '../domain/candidate-generator'
import type { CandidateGeneratorDeps } from '../domain/candidate-generator'
import { listArchivedPrivateMeasures } from '../domain/private-measure-lifecycle'

const orgOf = (c: Context<ModuleVars>): string => c.get('tenant').casdoor_org

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
    const outcome = await writePrivateMeasure(
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
    if (!outcome.ok) {
      // 采用失败：把占位**回滚**成 pending（否则候选永久卡在 created，且没有对应测度）。
      // 回滚本身失败不回滚错误语义：调用方拿到的是真正的失败原因（写测度没成功）。
      await setCandidateStatus(ctx.pool, org, candidateId, 'pending')
      return c.json({ error: outcome.error, ...(outcome.extra ?? {}) }, outcome.http)
    }
    return c.json({ ok: true, metricId: parsed.data.id, candidateStatus: 'created' }, 201)
  })
}
