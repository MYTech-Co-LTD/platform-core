// query-service.ts — 三通道**唯一**的执行入口。
//
// 通道差别到 Requester 为止：拿到 Requester 之后，会话/PAT/企微走的是同一条路径。
// 审计在**所有**结局都写（spec §5 约束 7）——包括被拒与出错，否则「为什么被拒」查不出来。
import type { Pool } from 'pg'
import { MAX_QUERY_ROWS, authorize, sqlQuote, visibleMetrics, type DenyReason, type Requester } from './authz'
import { loadMergedCatalog } from './metric-store'
import { writeAudit } from './audit-store'
import { DATA_WAREHOUSE_UNCONFIGURED, runWarehouseSql, warehousePool } from './warehouse'

/** 湖 ETag 竞态的**窄匹配**（#452 定案 spec §3.1：宁可漏判也不误判——只认这一形状，
 *  不扩大到一般 5xx/超时；那类由 statement_timeout / job retry 语义管）。 */
const LAKE_RACE_RE = /ETag on reading file/
/**
 * 新鲜度查询（spec §10.2）：load_log 最新一次**成功**物化的 materialized_at。
 * 同仓池上的一条主键级聚合——问数执行池就是仓（DATA_WAREHOUSE_URL），单跳；
 * 物化侧只写 status='ok' 行（materialize.sh，spec §10.1），这里也只认 ok。
 */
const DATA_AS_OF_SQL = "select max(materialized_at) as data_as_of from data.load_log where status='ok'"
/**
 * data_as_of 呈现（spec §10.6）：不回裸 Date（JSON 序列化成 UTC ISO 串，模型/人都要自己换算），
 * 服务端格式化成**北京时间**确定性字符串 `YYYY-MM-DD HH:mm:ss +08:00`。Intl（Node 22+ full-ICU）
 * 按 IANA Asia/Shanghai 取钟点；en-CA 恰好给 YYYY-MM-DD 日期序；时:分:秒 hour12:false（午夜=00）。
 * +08:00 后缀硬编码：Asia/Shanghai 恒定正八区（无夏令时），偏移不会漂。
 */
const DATA_AS_OF_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})
const DATA_AS_OF_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})
/** timestamptz（node-pg 回 Date）→ `YYYY-MM-DD HH:mm:ss +08:00`（spec §10.6 呈现定案）。 */
function formatDataAsOf(v: Date): string {
  return `${DATA_AS_OF_DATE_FMT.format(v)} ${DATA_AS_OF_TIME_FMT.format(v)} +08:00`
}

// ── 新鲜度链路面（spec §10.7.3/§10.7.4）：watermark → 状态转译 → 固定展示行 ──────────────

/** 新鲜度状态（spec §10.7.3）：水位距今天的业务转译；unknown = 没有 sla 可判（不捏造）。 */
export type FreshnessStatus = 'normal' | 'late' | 'alert' | 'unknown'

/** 水位查询（spec §10.7.3）：freshness_relations 各关系在 load_log 上 min(max_bizday)（木桶
 *  短板）+ 同一批 ok 行的最新物化时刻（固定行的 {t} 用）。status='ok' 且 relation 非空——
 *  旧「仓级」行（relation NULL）是历史，不进水位（spec §10.7.2）。关系字面量经 sqlQuote
 *  内联（值是服务端 sync 物化的关系名， quoting 与授权核心同一把尺）。 */
const WATERMARK_SQL_HEAD =
  "select min(max_bizday)::text as watermark, max(materialized_at) as materialized_at"
  + " from data.load_log where status = 'ok' and relation in ("

/** 水位的日历形状（watermark 列经 ::text 出来必须是 `YYYY-MM-DD`；坏形状宁可缺席不外递）。 */
const WATERMARK_RE = /^\d{4}-\d{2}-\d{2}$/

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` → 该日历日（UTC 零点）的 ms——水位差是**日历量**，不吃时区钟点。 */
const dayMsOf = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1)
}

/**
 * 水位 → 状态（spec §10.7.3：水位 ≥ 今天-sla ⇒ normal；< 且 ≥ 今天-sla-2 ⇒ late；更早 ⇒ alert）。
 * 纯函数：today 由调用方注入（Asia/Shanghai 的今天，`YYYY-MM-DD`）——测试不必改时钟。
 * 水位在未来/当天（差值 ≤ 0）按 normal：源端「今天已有部分天」是合法形态，不是迟到。
 */
export function freshnessStatusOf(watermark: string, slaDays: number, today: string): FreshnessStatus {
  const lateBy = (dayMsOf(today) - dayMsOf(watermark)) / DAY_MS - slaDays
  if (lateBy <= 0) return 'normal'
  if (lateBy <= 2) return 'late'
  return 'alert'
}

/**
 * 人话日期（spec §10.7.4 固定行的 {d}）：`YYYY-MM-DD` → `M月D日`。不给 ISO——固定行的
 * 硬约束是行内零工程术语、零换算负担，日期按人读的说法给。
 */
export function formatHumanDay(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}月${Number(d)}日`
}

/** 更新钟点（固定行的 {t}）：timestamptz → `MM-DD HH:mm`（北京时间，复用 §10.6 的格式化器）。 */
function formatMatClock(v: Date): string {
  return `${DATA_AS_OF_DATE_FMT.format(v).slice(5)} ${DATA_AS_OF_TIME_FMT.format(v).slice(0, 5)}`
}

/**
 * 固定展示行（spec §10.7.4，ec16eeb 订正版）：服务端按状态拼**业务大白话**，模型原样附在答案
 * 末尾。硬约束：行内不出现任何工程术语（承诺/水位/物化/业务日/T+N 一律不许出现）——
 * sla_days 只驱动 normal/late 的判定，不出现在任何用户可见文案里。
 *
 * `today`（Asia/Shanghai 的今天，`YYYY-MM-DD`，与 freshnessStatusOf 同一注入法）只服务
 * normal 分支的**当日部分天**变体（fix round 2）：水位恰为今天 ⇒ 该日还没过完（零售 tick
 * 的当日分区是部分天），「该日数据完整」是错误陈述 ⇒ 改口「今日数据仍在累计中」。
 * 状态判定不受影响（d=0 ≤ sla 恒 normal）；过去日期维持「该日数据完整」逐字不变。
 * late/alert 不会撞上水位=今天（d=0 对任何 sla ≥ 0 都判 normal），无需变体。
 */
export function freshnessLineOf(
  status: FreshnessStatus, watermark: string, materializedAt: Date | null, today: string,
): string {
  switch (status) {
    case 'normal': {
      const dayNote = watermark === today ? '今日数据仍在累计中' : '该日数据完整'
      return `📅 数据已更新至 ${formatHumanDay(watermark)}（${dayNote}）｜更新于 ${materializedAt === null ? '' : formatMatClock(materializedAt)}`
    }
    case 'late':
      return `📅 数据已更新至 ${formatHumanDay(watermark)}，比平时慢了，还在处理中`
    case 'alert':
      return `📅 数据更新停在 ${formatHumanDay(watermark)}，可能有问题，我们正在检查`
    case 'unknown':
      return '📅 数据更新情况未知'
  }
}

/**
 * 词表行的新鲜度关系集（**防坏形状归一**：只认非空字符串、保序去重；jsonb 落库值理论上恒是
 * sync 物化的字符串数组，但读侧不信任存储形状——坏值宁可判成「无链路」（字段缺席），
 * 不让垃圾进 SQL。空集 = 无自动水位，三字段全缺席。
 */
export function freshnessRelationsOf(row: { freshnessRelations?: string[] | null }): string[] {
  const out: string[] = []
  for (const r of Array.isArray(row.freshnessRelations) ? row.freshnessRelations : []) {
    if (typeof r === 'string' && r !== '' && !out.includes(r)) out.push(r)
  }
  return out
}
/** 退避：写入是原子 PUT，撞上时新文件多半已就绪，~1s 后重试恰一次足够（spec §3.1）。 */
const LAKE_RACE_RETRY_DELAY_MS = 1_000

function isLakeRaceError(err: unknown): boolean {
  return LAKE_RACE_RE.test(err instanceof Error ? err.message : String(err))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 见 Interfaces 块：命名出来，供 T6 的 RouteCtx 与 T8/T9 的 deps 共同引用。 */
export type SqlExecutor = (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>

export interface QueryDeps {
  pool: Pool
  /** 缺省 = 真仓库（惰性连接）。测试注入假执行器。 */
  execute?: SqlExecutor
  /** 湖 ETag 竞态重试的退避毫秒数（缺省 1000）。测试注入 0 免等待。 */
  raceRetryDelayMs?: number
  /**
   * 本租户**已接入的源**（宿主投影 `TENANT_SOURCES`；计划 5）。
   *
   * **必填**（不是可选 + 默认空集）：本函数是 `query_metric` 的解析路径，不裁源就等于放行
   * 「agent 记住 id ⇒ 硬编码绕过」那条路（spec §3⑧：只装裁剪这一道本来就不够，但少了它更糟）。
   * 两个来源：路由（`routes/query.ts` / `routes/mcp.ts`）直接读投影；agent loop 把自己的
   * `deps.adoptedSources` 透传下来（同一份事实，不再读一次投影）。
   */
  adoptedSources: ReadonlySet<string>
}

export interface QueryOk {
  status: 'ok'; subject: string; metricId: string
  columns: string[]; rows: unknown[][]; truncated: boolean
  /**
   * 合计值（spec §8.4 修订二：`total` 字段 = 合计值，#699 的布尔标记已废——同日契约变更）。
   * 两种在场方式：**自动伴随**（totalable 指标的任何查询，plan.totalSql 执行结果）与
   * **显式合计**（`args.total === true`，恒单行 `columns:['total']`，`truncated` 恒 false）。
   * 数值经 node-pg 常以 numeric 字符串回（与 rows 同源）；空集合计为 null。缺省 = 不可加
   * 指标（比率/去重计数）不出该字段——「没有合计」必须可辨，模型不得跨行求和。
   */
  total?: string | number | null
  /**
   * 新鲜度面（spec §10.2）：仓库 load_log 最新一次成功物化的 materialized_at。
   * 呈现为**北京时间确定性字符串** `YYYY-MM-DD HH:mm:ss +08:00`（spec §10.6：服务端
   * Intl 格式化，不教模型换算）。load_log 缺席/空 ⇒ **字段缺席**——「新鲜度
   * 未知 ≠ 捏造」，消费方（汇报纪律，spec §10.4）必须把缺席如实转述为「数据截止未知」。
   */
  data_as_of?: unknown
  /**
   * 新鲜度水位（spec §10.7.3）：freshness_relations 各关系在 load_log 上 min(max_bizday)
   * （木桶短板），`YYYY-MM-DD`。链路未声明（L2 行 / L1 未声明 sources）或水位缺失 ⇒
   * **三字段全缺席**——「未知 ≠ 捏造」，不凭空造一个日期。
   */
  watermark?: string
  /** 水位的业务转译（spec §10.7.3）：≤sla normal / ≤sla+2 late / 更早 alert / 无 sla 可判 unknown。 */
  freshness_status?: FreshnessStatus
  /**
   * 服务端预拼的**固定展示行**（spec §10.7.4 业务大白话模板）：模型**原样**附在答案末尾、
   * 单独一行、不混入正文、不改写。预拼 = 消灭 flash 级模型的格式遵从风险。
   */
  freshness_line?: string
  /**
   * 值级脱敏面（spec §5.3，P2 T2）：本响应中生效的「列 → 记号」（`round:1000` / `nullify`；
   * 整值掩码键为 `<value>`）。**仅当有掩码实际生效才在场**（空则不出现该键，与
   * `total?` / `freshness_*?` 同风格——缺席 = 原值）。消费方据此如实说明「这个数是脱敏后的」，
   * 不得当精确值转述；记号与 SQL 里实际展开的掩码一一对应（授权层同一份 applied 透传）。
   */
  masking?: Record<string, string>
}
export interface QueryDenied {
  status: 'denied'; metricId: string
  reason: DenyReason | 'unauthenticated'; detail?: string
}
export interface QueryError {
  status: 'error'; metricId: string
  // warehouse_transient（#452 定案 §3.2）：湖 ETag 竞态重试仍撞——「活跃写入窗内的暂时性
  // 读冲突，等几秒重试大概率成功」，不是仓库坏了；detail 保留 DuckDB 原文供排障。
  reason: 'warehouse_unconfigured' | 'warehouse_transient' | 'warehouse_error'; detail: string
}
export type QueryOutcome = QueryOk | QueryDenied | QueryError

export async function runQuery(
  deps: QueryDeps,
  org: string,
  requester: Requester | null,
  metricId: string,
  args: Record<string, unknown>,
): Promise<QueryOutcome> {
  const audit = (
    verdict: 'ok' | 'denied' | 'error', reason: string | null, rowCount: number | null,
    // 值级脱敏审计（spec §4.4）：只有真的展开过掩码才带记录；未展开传 **null**（不是 {}）。
    // 被拒/出错/未认证一律 null——查询没在掩码下执行过，「看过原值还是掩码值」无从谈起。
    masking: Record<string, string> | null,
  ) => writeAudit(deps.pool, {
    // 隔离键 `org` 就是审计里的主体值——**同一列**（见 T1 的 001_init.sql 注记）。
    // 值取 `org` 形参（= 路由传进来的 `identity.orgId`，宿主注入的权威值），
    // **不是** `requester.orgId`——那是通道解析出来的；生产上两者同值，但隔离键必须认宿主那一份。
    org,
    userId: requester?.userId ?? '(anonymous)',
    channel: requester?.channel ?? 'session',
    keyId: requester?.keyId ?? null,
    metricId,
    params: args,
    rowCount,
    verdict,
    reason,
    masking,
  })

  if (!requester) {
    await audit('denied', 'unauthenticated', null, null)
    return { status: 'denied', metricId, reason: 'unauthenticated' }
  }

  // 词表 = L1（平台）∪ L2（本 org）——**合并加载器**，与 `GET /metrics`/MCP/chat 同一落点
  // （T8 评审 C1：这里曾用只回本 org 的加载器 ⇒ 平台指标在 /query 上 403「未声明」，
  //  而 console 把它列了出来——同一 id 在两条通道上胜负相反且无任何可观测信号）。
  //
  // ★ 裁剪（scope **与** 源维度）**必须在 authorize 之前**（计划 5 §3⑧ 把裁剪收口在
  //   `visibleMetrics` 一处，本文件不自建第二份判定）：
  //   · 未接入源的指标被裁掉 ⇒ `authorize` 看到的是「这个词表里没有这个 id」⇒
  //     `metric_not_declared`（看不见，不是报错，与约束 3 一致）。硬编码 id 也绕不过。
  //   · **顺带**把 scope 不够的指标的 reason 也从 `metric_not_authorized` 变成
  //     `metric_not_declared`：另外三条消费面（GET /metrics、MCP tools/list、chat 的
  //     list_metrics）**本来就**看不见它，只有 /query 会回「存在但你没权限」——那是个存在性
  //     探针，与三条面自相矛盾。`authorize` 自身的 `metric_not_authorized` 分支未变
  //     （authz.test.ts C2 仍钉着它：它是本核心的契约，只是消费面在它之前已把词表收窄）。
  const catalog = visibleMetrics(
    await loadMergedCatalog(deps.pool, org), requester, deps.adoptedSources)
  const authz = authorize(catalog, requester, metricId, args)
  if (!authz.ok) {
    await audit('denied', authz.reason, null, null)
    return { status: 'denied', metricId, reason: authz.reason, detail: authz.detail }
  }

  // 湖 ETag 竞态（#452 定案 A）：tick 在上海 08:00–24:00 每 5 分钟重写当天 cur/prev 两个分区，
  // 任意时刻的读可能撞上重写窗 ⇒ 咽喉处退避 ~1s 重试**恰一次**（本通路全为只读 SELECT，天然幂等）。
  // 重试成功也把 `lake_race_retry` 写进审计 reason——那是 spec §3.5「重试是否长期够用」的数据源。
  // 自动伴随（spec §8.4）的 totalSql 是同一条通道上的第二只读查询 ⇒ 共用同一套竞态处置。
  let result: { columns: string[]; rows: unknown[][] }
  let raceRetried = false
  const execWithRaceRetry = async (sql: string) => {
    const exec = () =>
      deps.execute ? deps.execute(sql) : runWarehouseSql(warehousePool(), sql)
    try {
      return await exec()
    } catch (err) {
      if (!isLakeRaceError(err)) throw err
      raceRetried = true
      await sleep(deps.raceRetryDelayMs ?? LAKE_RACE_RETRY_DELAY_MS)
      return await exec()
    }
  }
  const toError = async (err: unknown): Promise<QueryError> => {
    const detail = err instanceof Error ? err.message : String(err)
    const reason =
      detail === DATA_WAREHOUSE_UNCONFIGURED ? 'warehouse_unconfigured'
      : isLakeRaceError(err) ? 'warehouse_transient'
      : 'warehouse_error'
    await audit('error', reason, null, null)
    return { status: 'error', metricId, reason, detail }
  }

  try {
    result = await execWithRaceRetry(authz.plan.sql)
  } catch (err) {
    return await toError(err)
  }

  // 自动伴随（spec §8.4）：plan.totalSql 在场 ⇒ 再执行合计计划，把值附到响应 total 字段。
  // sum() 对空集也回一行（NULL）⇒ rows[0][0] 即值；合计失败与主查询同一错误面（warehouse_*）。
  let totalValue: string | number | null | undefined
  if (authz.plan.totalSql !== undefined) {
    try {
      const t = await execWithRaceRetry(authz.plan.totalSql)
      totalValue = (t.rows[0]?.[0] as string | number | null | undefined) ?? null
    } catch (err) {
      return await toError(err)
    }
  }

  // 新鲜度面（spec §10.2）：主计划（与自动合计）执行成功后，同仓池补一条主键级查询。
  // 表缺席/空表/仓库未配/任何失败 ⇒ **字段缺席**——「新鲜度未知 ≠ 捏造」，且缺账绝不
  // 反噬主查询（try/catch 包死，不是 error 出口）。直接走真仓库池：deps.execute 是主计划
  // SQL 的测试缝，假执行器认不得这条 SQL；生产路径（不注入 execute）本来就是这条池。
  let dataAsOf: unknown
  try {
    const fresh = await runWarehouseSql(warehousePool(), DATA_AS_OF_SQL)
    const v = fresh.rows[0]?.[0]
    // timestamptz 经 node-pg 回 Date——在此处换成北京时间字符串（spec §10.6）；
    // 非预期形状（不该发生）宁可缺席也不把坏值递出去。
    if (v instanceof Date) dataAsOf = formatDataAsOf(v)
  } catch {
    // load_log 缺席 / 仓库未配 ⇒ data_as_of 缺席（新鲜度未知，主查询结果照常交付）
  }

  // 新鲜度链路面（spec §10.7.3/§10.7.4）：指标声明了 freshness_relations 才查——关系集上的
  // min(max_bizday)（木桶短板）+ 服务端按 sla_days 状态转译 + 预拼固定展示行。缺链路
  // （L2 行 / 未声明 sources）、水位缺失（无对应 relation 行）、load_log 还是旧形状
  // （materialize 未升级，列不在 ⇒ 查询报错）⇒ 三字段**全缺席**——未知 ≠ 捏造，且缺账
  // 绝不反噬主查询（try/catch 包死，同 data_as_of）。metric 从已加载的合并词表取（同一行
  // 已过授权与裁剪，这里只是把它的链路声明读出来）。
  let freshnessFace:
    | { watermark: string; freshness_status: FreshnessStatus; freshness_line: string }
    | undefined
  const metricRow = catalog.find((m) => m.id === metricId)
  const relations = metricRow === undefined ? [] : freshnessRelationsOf(metricRow)
  if (relations.length > 0) {
    try {
      const wm = await runWarehouseSql(
        warehousePool(), `${WATERMARK_SQL_HEAD}${relations.map((r) => sqlQuote(r)).join(', ')})`)
      const w = wm.rows[0]?.[0]
      const matAt = wm.rows[0]?.[1]
      if (typeof w === 'string' && WATERMARK_RE.test(w) && matAt instanceof Date) {
        // 无 sla 可判（sla_days 为 null 的理论态：库内旧行 sync 未刷）⇒ unknown，不捏造状态；
        // 「今天」与 data_as_of 同一格式化通道（Asia/Shanghai 的日历日，spec §10.6），
        // 状态判定与固定行的当日变体（fix round 2）共用同一份，不各算各的钟。
        const today = DATA_AS_OF_DATE_FMT.format(new Date())
        const status = typeof metricRow?.slaDays === 'number'
          ? freshnessStatusOf(w, metricRow.slaDays, today)
          : 'unknown'
        freshnessFace = { watermark: w, freshness_status: status, freshness_line: freshnessLineOf(status, w, matAt, today) }
      }
    } catch {
      // load_log 缺表/缺列 / 仓库未配 ⇒ 链路三字段缺席（新鲜度未知，主查询结果照常交付）
    }
  }

  // 审计掩码（spec §4.4）：与回包 `masking` 同一份 applied（授权层展开记录）——空则 **null**，
  // 不写 {}（null = 本次无掩码生效，'{}' 是审计里不该出现的第三种态）。
  const appliedMasking = Object.keys(authz.plan.applied).length > 0 ? authz.plan.applied : null
  await audit('ok', raceRetried ? 'lake_race_retry' : null, result.rows.length, appliedMasking)
  // 显式合计模式（spec §8）：plan.sql 已是 `SELECT sum(value) …`（无外层 LIMIT）⇒ 恒单行，
  // total 字段 = 该行的合计值；`truncated` 恒 false（合计无截断面）。
  // 自动伴随：明细 rows/truncated 语义不变，只多附一个 total 值。
  // 非合计且不可加的路径逐字段不变（无 total 字段）。data_as_of（spec §10.2）任何 ok 形态
  // 都附（合计/明细与新鲜度正交），唯独 load_log 缺账时缺席。
  return {
    status: 'ok',
    subject: authz.plan.subject,
    metricId,
    columns: result.columns,
    rows: result.rows,
    truncated: authz.plan.total ? false : result.rows.length >= MAX_QUERY_ROWS,
    ...(authz.plan.total
      ? { total: (result.rows[0]?.[0] as string | number | null | undefined) ?? null }
      : totalValue !== undefined ? { total: totalValue } : {}),
    ...(dataAsOf !== undefined ? { data_as_of: dataAsOf } : {}),
    ...(freshnessFace !== undefined
      ? {
          watermark: freshnessFace.watermark,
          freshness_status: freshnessFace.freshness_status,
          freshness_line: freshnessFace.freshness_line,
        }
      : {}),
    // 值级脱敏面（spec §5.3）：授权层展开记录非空才回包——空对象不出现该键（缺席 = 原值）。
    // total（显式/自动合计）读的是同一个被掩的内层 select，天然与明细行同一套掩码值。
    ...(Object.keys(authz.plan.applied).length > 0 ? { masking: authz.plan.applied } : {}),
  }
}
