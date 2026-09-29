// reports.ts — Metabase 报表 facade 的路由层（T7）。
//
// **门禁由宿主施加**（manifest 的 api.internal），本文件不写 requireScope。分档：
//   制作/登记/对账 = `data:manage`；观看面（清单 + 拿嵌入 URL）= `data:query`。
//
// ⚠️ **权限双门必须分开表态**（spec §4，安全论断的落点）：
//   · 页门「谁**能看**」= 本模块的 platform scope（宿主按 manifest 施加）。
//   · 数据门「看**哪个租户的数据**」= 嵌入时**锁定的 tenant 参数**——它由平台**写死**成
//     调用者身份里的 org（`requester.orgId`），**绝不接受任何入参覆盖**。
//     为什么不能接受入参：观看者拿到的是我们签的 JWT，`locked` 值对观看者不可见不可改
//     （spec §6.3）——这正是「AI/客户端不能靠传参换租户」的结构性保证。
//   两门都必须在：只有页门 ⇒ 任何有 data:query 的人能看全租户；只有数据门 ⇒ 「谁看」无判定。
//
// ⚠️ 为什么报表**必须**经平台建（spec §11.3.1 / §4）：AI 侧的语义层自身不带权限，
//   「建报表 = 跨租户能力」；facade 是唯一的鉴权与定租户点。故本模块绝不把 Metabase 凭据
//   下发给任何调用方，凭据只在本模块服务端 env。
//
// ⚠️ **Metabase 侧的身份按 org 命名空间化**（I-1）：`<org>/<title>`（`dashboardName`）。
//   平台的 Metabase 是单实例多租户共用，dashboard 只有 `name` 这一个身份 ⇒ 名字不带 org 时，
//   两个租户的同名报表经 `GET /api/search` 命中同一张 ⇒ 跨租户**改写**（setEmbedding 覆盖
//   embedding_params）与跨租户**归档**（DELETE 删掉别人的报表）。四处口径必须一致：
//   查找 / 创建（都过 `dashboardName`）、发布与归档（按 upsert / 登记行给出的 id 走）。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { signEditHandoff } from '../domain/edit-handoff'
import { withObjectLock } from '../domain/object-lock'
import {
  MetabaseError,
  archiveDashboard,
  dashboardName,
  embedDashboardUrl,
  listEmbeddableDashboards,
  metabaseDeps,
  metabaseFromEnv,
  parseDashboardName,
  setEmbedding,
  signEmbedToken,
  upsertDashboard,
} from '../domain/metabase'
import {
  deleteReport,
  getReport,
  getReportVersion,
  listAllReports,
  listReports,
  updateRequiredScope,
  upsertReport,
} from '../domain/report-store'
import {
  TENANT_PARAM_ID, TENANT_SLUG, publishWithTenantBinding, readDashboardContent,
} from '../domain/report-content'

/** 嵌入 URL 的有效期（秒）。短期凭证：不落书签、不进日志、可被重放但窗口很小。 */
const EMBED_TTL_SECONDS = 600

const ReportBody = z.object({
  title: z.string().trim().min(1).max(200),
  /** 除 tenant 外要锁的参数 → 值。锁定即「观看者不可见不可改」，值由我们签进 JWT。 */
  lockedParams: z.record(z.string()).default({}),
  /** NULL = 所有拿到本模块的人可见（口径同 data.metrics.required_scope）。 */
  requiredScope: z.string().min(1).nullable().default(null),
  // 内容侧版本（写保护）：更新既有 dashboard 时**必填**；见 handler 里的 fail-closed 分支
  expectedFingerprint: z.string().min(1).nullable().default(null),
}).strict()

/**
 * 报表 id 的解析口径（text，uuid）。**只挡「空/缺失」**，一律 404——与 aftersales /
 * metrics 的「非法 id 一律 404」一致，不给存在性探针（不做 uuid 形状校验：形状不对
 * 也只是查不到，多一条正则就多一个「合法 id 被拒」的误伤面）。
 */
const reportIdOf = (raw: string | undefined): string | null =>
  raw === undefined || raw === '' ? null : raw

/** 行级数据门：词表外的报表可见性也按「org + 行上 required_scope」裁（口径同 visibleMetrics）。 */
const visibleTo = (
  row: { requiredScope: string | null },
  requester: { hasScope(code: string): boolean },
): boolean => row.requiredScope === null || requester.hasScope(row.requiredScope)

export function registerReports(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/reports', async (c) => {
    // 入口先判身份：不给匿名者「本站有没有接报表服务」的探测信号（fail-closed）
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    // 没配 Metabase ⇒ 可解释的 503（配置状态，不是故障；口径同 LLM_UNCONFIGURED）
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const parsed = ReportBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 保留名一律拒（在碰 Metabase 之前）。TENANT_SLUG 是平台**保留**的锁定参数名：值恒 = 调用者
    // org、只在签 token 时现写；给了它 ⇒ 400（不是「静默忽略」：静默会让调用方以为锁定了别的
    // 租户而实际没锁）。⚠️ 同名必须出现在 Metabase 的 embedding_params 且为 locked，机械防线在
    // POST /reports/reconcile。**单一来源**（终审修复 1）：从 domain/report-content import——本文件
    // 曾自持 'tenant' 字面量，两处漂移 ⇒ setEmbedding 整表替换时丢 tenant:'locked' ⇒ 静默解锁租户。
    if (Object.hasOwn(parsed.data.lockedParams, TENANT_SLUG)) {
      return c.json({ error: 'TENANT_PARAM_RESERVED' }, 400)
    }

    const org = c.get('tenant').casdoor_org
    const deps = metabaseDeps(cfg)
    try {
      // ── 每对象一把锁（spec §3③）：整段写序列（upsert → 守卫 → publish → setEmbedding →
      //    登记 → 回读）串行化，收窄「先读后写」的并发窗口（version/fingerprint 比对本身只能
      //    事后发现，锁让同对象的两个写不再交错）。
      // ⚠️ 键用**规范名**（`dashboardName` 含 org，见 I-1）：创建前还没有 id，唯一稳定的对象身份
      //    就是名字；顺带把「并发建同名」也串起来——否则两个请求都 search 到空集 ⇒ 各建一张
      //    ⇒ 一张成为孤儿（既有 routes/reports.test.ts 的确定性竞态用例正是这条）。
      return await withObjectLock(`${org}/dash:${dashboardName(org, parsed.data.title)}`, async () => {
        // 幂等（API 无按名 upsert，spec §6.5）：命中同名 ⇒ PUT、否则 POST。
        // ⚠️ 查找/创建都用**含 org 的规范名**（I-1）：Metabase 是单实例多租户共用，裸 title 会让
        //    两个租户的同名报表命中同一张 dashboard ⇒ 跨租户改写 embedding_params / 跨租户归档。
        const up = await upsertDashboard(deps, dashboardName(org, parsed.data.title))
        // ── 内容侧写保护（spec §3③；人裁 2026-09-29 fail-closed）────────────────────────
        // 命中同名 ⇒ 这是**更新既有对象**：必须回带它当前的指纹，否则一律拒（不带就让人先读再写，
        // 不接受「省略 = 强制覆盖」——那正是实测里"人的两张图被静默抹掉"的那条路）。
        // ⚠️ 位置是契约的一半：必须在**任何发布写入之前**判——挪到 `publishWithTenantBinding` 之后，
        //    被拒的请求已经先写过 Metabase 了（「拒」就只是回了个码），且有卡的表上判到的还是
        //    发布后的内容。这条由 routes/reports.test.ts 的「守卫必须在写之前」用例钉住。
        //    而它放在 `upsertDashboard` **之后**是**刻意**的：那条同名路径只做**内容保持**的合并 PUT
        //    （`putDashboardMerged`：name 同值、dashcards/parameters/embedding_params 全部原值回写），
        //    对内容而言是 no-op ⇒ 不构成「先写」。守卫要拦的是**会改内容/锁参**的那两步
        //    （publish 与 setEmbedding），所以别再往「更靠前」挪（判指纹要先读内容，前置到
        //    upsert 之前只会多一次读，拦不到任何东西）。
        if (!up.created) {
          const cur = await readDashboardContent(deps, up.id)
          if (parsed.data.expectedFingerprint === null) {
            return c.json({ error: 'VERSION_REQUIRED', currentFingerprint: cur.fingerprint }, 409)
          }
          if (parsed.data.expectedFingerprint !== cur.fingerprint) {
            return c.json({ error: 'STALE_WRITE', currentFingerprint: cur.fingerprint }, 409)
          }
        }
        // 一次做全三件（声明参数 / 只映射带标签的卡 / 锁参）；额外的 lockedParams 由 setEmbedding 合并
        const pub = await publishWithTenantBinding(deps, up.id)
        if (Object.keys(parsed.data.lockedParams).length > 0) {
          await setEmbedding(deps, up.id, [
            { name: TENANT_SLUG, mode: 'locked' },
            ...Object.keys(parsed.data.lockedParams).map((name) => ({ name, mode: 'locked' as const })),
          ])
        }
        const id = await upsertReport(ctx.pool, org, {
          title: parsed.data.title,
          metabaseId: up.id,
          embedParams: parsed.data.lockedParams,
          requiredScope: parsed.data.requiredScope,
        })
        // `version` 是**登记侧**版本（与内容侧指纹分属两条通路，别混名）：**写后**回读，不复用写前的值。
        // `fingerprint` 直接复用发布那次的现算结果——零额外请求（publishWithTenantBinding 已算过）。
        const row = await getReport(ctx.pool, org, id)
        if (row === null) throw new Error('upsertReport 后登记行应可读（同一请求内的一致性假设被打破）')
        return c.json({
          id, metabaseId: up.id, created: up.created,
          fingerprint: pub.fingerprint, version: row.version,
        }, 201)
      })
    } catch (err) {
      // 上游失败与「没配」分开表达（502 vs 503）。`created` 的幂等证据也随之不可得——
      // 不在这里造一个假值。Metabase 侧可能已建出 dashboard 而登记行没写成（setEmbedding
      // 失败时）⇒ 那条孤儿会**显式**出现在对账的 unregistered 差集里，正是它该出现的地方。
      if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
      throw err
    }
  })

  r.get('/reports', async (c) => {
    const requester = requesterOf(c)
    // M3 守卫拒掉的请求者：对其「看不见」（约束 3）——空清单，不是报错（口径同 GET /metrics）
    if (requester === null) return c.json({ reports: [] })
    const rows = await listReports(ctx.pool, c.get('tenant').casdoor_org)
    // 只投影消费面要的字段：metabase_id / embed_params 是实现细节，不外泄
    return c.json({
      reports: rows.filter((row) => visibleTo(row, requester))
        .map((row) => ({
          id: row.id, title: row.title, requiredScope: row.requiredScope, renderer: row.renderer,
        })),
    })
  })

  // ── 管理清单（spec §3⑤：租户管理员看**全量**本 org 行，含页门未放行的）─────────────
  // 与观看清单 GET /reports 的分野：观看面按行 required_scope 裁剪（visibleTo），管理面**不裁**
  // ——页门未放行的行对管理员必须可见、可改，否则没人能把未发布的报表发出来。
  // 授权由宿主门卫按 manifest（data:manage）施加，handler 不再判权限。
  r.get('/reports/manage', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const rows = await listReports(ctx.pool, c.get('tenant').casdoor_org)
    return c.json({
      // `version` 是**登记侧**版本（写保护的读侧）：console 从本清单拿它、写时回带。
      // 观看面 GET /reports 刻意不带它（那里没有写动作，外泄版本号无消费方）。
      reports: rows.map((row) => ({
        id: row.id, title: row.title, requiredScope: row.requiredScope,
        renderer: row.renderer, version: row.version,
      })),
    })
  })

  const GateBody = z.object({
    requiredScope: z.string().min(1).nullable(),
    // 登记侧版本（写保护；人裁 fail-closed）：必填，缺则 400。
    // ⚠️ **必须带上界** `.max(2147483647)`（int4 上限）：这个值会被绑进 SQL 与 `version`（int4 列）
    //    比较，无上界时 `3000000000` 这类**客户端可控**的取值会让 Postgres 报 22003、被兜成 500
    //    ——契约是「非法入参 ⇒ 400」，且 5xx 会污染监控。**闭区间**：int4 上限本身合法（仍走比对）。
    //    （DELETE 的同名字段**不需要**上界：它只在 JS 里与 `row.version` 比较，从不进 SQL。）
    expectedVersion: z.number().int().positive().max(2147483647),
  }).strict()

  // ── 页门改动（管理面动作：页门/发布/回收之「页门」「发布」）─────────────────────────
  // 发布 = requiredScope 置 null；改页门 = 换成新 scope。**没有独立的 published 列**
  // （见函数头顶注与计划 Global Constraints 1）。
  // ⚠️ 写保护（spec §3③）：**版本从请求体取**（`expectedVersion`，必填——fail-closed 人裁
  //    2026-09-29），条件更新（`version = expectedVersion` 才落）。Task 1 的过渡形态是
  //    「handler 先读版本再传进去」——那等于守卫自己给自己盖章（并发写都命中），本任务已换掉。
  r.put('/reports/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = GateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    // ── 每对象一把锁（spec §3③）：条件 UPDATE + 「陈旧时分清 404/409」的二次读**同锁**，
    //    否则两次读之间夹一次并发写会拿到互相矛盾的版本。键用行 id（写对象已在，id 才是身份）。
    return await withObjectLock(`${org}/row:${id}`, async () => {
      const row = await updateRequiredScope(ctx.pool, org, id, parsed.data.requiredScope, parsed.data.expectedVersion)
      if (row === null) {
        // 存储层把「不存在 / 跨租户 / 版本陈旧」合流成 null（不给存在性探针）⇒ 这里再查一次分清楚。
        // 带 org 查（跨租户在这里同样得 null ⇒ 404，不泄漏别的租户有没有这一行）。
        const cur = await getReportVersion(ctx.pool, org, id)
        if (cur === null) return c.json({ error: 'NOT_FOUND' }, 404)
        return c.json({ error: 'STALE_WRITE', currentVersion: cur }, 409)
      }
      // 成功响应回带**推进后**的版本（调用方据此续写下一次，无需再读一次）
      return c.json({
        id: row.id, title: row.title, requiredScope: row.requiredScope,
        renderer: row.renderer, version: row.version,
      })
    })
  })

  // ── 编辑页入口（spec §3⑦：把 Metabase 编辑页经反代搬进后台）─────────────────────────
  // 判定只能在这里做（登记表只有模块能读）；签一枚 120s 一次性票据，身份由**专用入口**的反代替换
  // 成它自己的 host-only Cookie（平台会话 Cookie 不设 Domain、不扩散）。
  r.get('/reports/:id/edit-url', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    // ⚠️ fail-closed（评审 I-3）：缺配/形状不对一律 503——**不许** `?? ''` 用空密钥签票据，
    //    也不许把非 https 或带尾斜杠的 origin 直接拼进 URL。
    const proxyOrigin = process.env.MB_PROXY_PUBLIC_ORIGIN?.trim().replace(/\/+$/, '')
    const sessionSecret = process.env.PLATFORM_SESSION_SECRET ?? ''
    if (!proxyOrigin || !proxyOrigin.startsWith('https://') || sessionSecret.length < 32) {
      return c.json({ error: 'EDIT_PROXY_UNCONFIGURED' }, 503)
    }
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, c.get('tenant').casdoor_org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // platform 自绘行没有 Metabase dashboard（metabaseId=0 是哨兵）⇒ 没有可编辑的页
    if (row.renderer === 'platform') return c.json({ error: 'RENDERER_NOT_EDITABLE' }, 409)
    // 票据只绑 org + 单张 dashboard（不绑用户）：代理侧只按这两个维度授权，用户维度由本端点的
    // `data:manage` 页门把关。残余风险（同租户成员截获票据后 120s 内使用）由「短 TTL + 一次性
    // nonce + 入口即清 t + no-referrer」共同压缩——见 Task 3 与 spec §3⑦。
    const t = signEditHandoff(
      { org: requester.orgId, did: row.metabaseId, nonce: randomUUID() },
      sessionSecret,
    )
    return c.json({ url: `${proxyOrigin}/handoff?t=${t}` })
  })

  r.get('/reports/:id/embed-url', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, c.get('tenant').casdoor_org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 数据门之二（行级）：行上 required_scope 比页门更细
    if (!visibleTo(row, requester)) {
      return c.json({ error: 'FORBIDDEN', need: row.requiredScope }, 403)
    }

    // 渲染器通道守卫：platform 行没有 Metabase dashboard（metabaseId=0 是哨兵），给它签 token
    // = 签一张**指向不存在 dashboard 的死链**。显式 409，等平台自绘渲染通路（计划 4）接上后
    // 由前端按 renderer 走另一条观看通道。
    if (row.renderer === 'platform') {
      return c.json({ error: 'RENDERER_NOT_EMBEDDABLE' }, 409)
    }

    // ★★ 安全论断的落点：locked.tenant 恒 = 调用者身份里的 org。
    //    · 查询串/请求体里的 tenant **从不读取**（本 handler 里没有任何 c.req.query('tenant')）；
    //    · 展开顺序也钉死：平台值放**最后**，即便库里被手工塞了一条带 tenant 的 embed_params
    //      也覆盖不了平台值（纵深防御，不只靠写入侧的那道 400）。
    //    为什么取 requester.orgId 而不是 c.get('tenant').casdoor_org：锁进 token 的是
    //    「以哪个租户的视角看数据」，必须以**调用者身份**的 org 为准，绝不展示身份之外 org 的数据。
    const locked = { ...row.embedParams, [TENANT_SLUG]: requester.orgId }
    const token = signEmbedToken(
      cfg.secretKey, { type: 'dashboard', id: row.metabaseId }, locked, EMBED_TTL_SECONDS,
    )
    return c.json({
      url: embedDashboardUrl(cfg.baseUrl, token),
      expiresAt: new Date(Date.now() + EMBED_TTL_SECONDS * 1000).toISOString(),
    })
  })

  r.delete('/reports/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 登记侧版本（写保护，spec §3③）：DELETE 走**查询串**（无 body）——`?expectedVersion=N`。
    // 缺/非正整数 ⇒ 400（fail-closed：不接受「省略 = 强制删」）。**先验参再落库**：非法的版本
    // 是调用方缺陷，不该先花一次查询；与 PUT 的「body 先 parse 再查库」同序。
    const expectedVersion = Number(c.req.query('expectedVersion'))
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const org = c.get('tenant').casdoor_org
    // ── 每对象一把锁（spec §3③）：DELETE 是「JS 比较版本 + 无条件删行」（Task 3 的已知窗口）——
    //    「读版本 → 比较 → 删行」三步同锁后，与 PUT 的「条件 UPDATE」互斥。键与 PUT 同源
    //    （`${org}/row:${id}`）：同一行的删与改必须串行。
    return await withObjectLock(`${org}/row:${id}`, async () => {
      const row = await getReport(ctx.pool, org, id)
      if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
      // ⚠️ **版本判定必须发生在 `archiveDashboard` 之前**（Task 3 硬约束）：本端点是「先归档、再删行」
      //    的两步序列（顺序见下），版本守卫若挪到归档后，被拒的请求**已经改过 Metabase** ——
      //    「拒」就只剩一个响应码。由 routes/reports.test.ts 的「陈旧 ⇒ 409 且 mb.state.calls 为空」钉住。
      //    版本取**这一行**（`row.version`，本次请求唯一一次读）而不是再发一次 getReportVersion：
      //    两次读之间夹一次并发写就会拿到两个版本号，单一读是更强的判据。
      if (row.version !== expectedVersion) {
        return c.json({ error: 'STALE_WRITE', currentVersion: row.version }, 409)
      }

      const deps = metabaseDeps(cfg)
      // renderer=platform（终审修复 3）：没有 Metabase dashboard 可归档（metabaseId=0 是哨兵，
      // 拿它发 PUT 只会 404 ⇒ 删除恒 502）——跳过归档，登记行删除照旧。
      if (row.renderer !== 'platform') {
        try {
          // 先归档、再删行。顺序不能倒：只删登记行而把 dashboard 留在可嵌入集里 ⇒ 它恒出现在
          // 对账的 unregistered 差集里（一条永远消不掉的噪声）。反过来先归档、删行失败 ⇒
          // 登记行还在，对账会把它报成 missingInMetabase（可恢复的、显式可见的状态）。
          // M-1：本顺序由 routes/reports.test.ts 的「先归档后删行」用例 + 变异回归钉住。
          // ⚠️ 归档只按 id（不按名）：id 就是创建时那次 `dashboardName(org, title)` upsert 的返回值，
          //    命名空间一致性由 POST 那一处保证（少一处口径就留一条串味路径）。
          await archiveDashboard(deps, row.metabaseId)
        } catch (err) {
          if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
          throw err
        }
      }
      await deleteReport(ctx.pool, org, row.id)
      return c.body(null, 204)
    })
  })

  r.post('/reports/reconcile', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const org = c.get('tenant').casdoor_org
    const rows = await listReports(ctx.pool, org)
    // 登记侧取**全部租户**的并集（I-2）：只算本 org 会把别人的 dashboard 恒报成本租户未登记。
    const allRows = await listAllReports(ctx.pool)
    const deps = metabaseDeps(cfg)
    let embeddable: { id: number; name: string }[]
    try {
      // 正规可观测面（spec §6.5）：**别看 iframe**——报表被 unpublish 后嵌入方显示什么
      // 官方没有任何说明，属不可观测面。
      embeddable = await listEmbeddableDashboards(deps)
    } catch (err) {
      if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
      throw err
    }

    // ── 差集①：本 org 的登记行指向的 dashboard 在可嵌入集里找不到（按 id 求差，判据本来是对的）。
    // renderer=platform 的行**不进差集**（终审修复 3，与下方回读循环同款守卫）：它的 metabaseId=0
    // 是哨兵不是真 id，比对只会产出一条永远消不掉的 missingInMetabase 噪声。
    const embeddableIds = new Set(embeddable.map((d) => d.id))
    const missingInMetabase = rows
      .filter((r) => r.renderer !== 'platform' && !embeddableIds.has(r.metabaseId))
      .map((r) => ({ id: r.id, title: r.title, metabaseId: r.metabaseId }))

    // ── 差集②：可嵌入集里**不属于任何 org 的任何一行 metabase_id** 的（I-2 的新判据）。
    // 旧判据按 `title` 集合求差，两个结构性缺陷：同名孤儿看不见（名字命中了本 org 的 title）、
    // 多租户下把别人的 dashboard 恒报成本租户未登记（ok:false 与 ok:true 两种假绿各占一半）。
    // 新判据与 title 无关、与「谁在跑对账」无关 ⇒ **正交、无假绿**。
    const registeredIds = new Set(allRows.map((r) => r.metabaseId))
    const unregisteredAll = embeddable
      .filter((d) => !registeredIds.has(d.id))
      .map((d) => ({ metabaseId: d.id, name: d.name }))
    // 两分：名字能解出 `(org, title)` ⇒ 归属确定、消除动作确定（重跑 POST 按全等命中接管；
    // 若是已登记行的重复副本则归档该 id）＝**能自愈**；解不出（人在 Metabase 侧直接建的、或
    // 本改动前的无前缀遗留）⇒ 平台无从判定归属 ＝**需人看**。
    const unregistered = {
      recoverable: unregisteredAll.filter((d) => parseDashboardName(d.name) !== null),
      needsHuman: unregisteredAll.filter((d) => parseDashboardName(d.name) === null),
    }

    // ── 差集③（RR9② + spec §7 待办 2 的加厚）：「锁参三件套」这族约定只能靠机械防线，
    // 失效模式全是静默的（页面照常显示**未过滤**的数据）。同一循环判两件事：
    //   ③a 锁没锁：回读 `embedding_params.tenant === 'locked'`，不满足落 `tenantUnlocked`；
    //   ③b 锁了但**绑不到**：① dashboard 没声明 slug=tenant 的参数（没声明 ⇒ 锁值无处挂），
    //      或 ② **任一**带 {{tenant}} 模板标签的卡没有映射挂到 tenant 参数上（单卡粒度，
    //      人裁 2026-09-29：半绑定也报）⇒ 落 `tenantUnbound`。
    // 两判用**同一次** readDashboardContent 回读（别多发请求）。
    // 只读**本 org** 的行：它是「我们登记的报表锁没锁住」的自检；跨 org 读会把别人的行内状态
    // 暴露给本租户（而 unregistered 的跨 org 读是**必需**的——不取全局并集就有假阳性）。
    const tenantUnlocked: { id: string; title: string; metabaseId: number }[] = []
    const tenantUnbound: { id: string; title: string; metabaseId: number }[] = []
    // 按行降级（计划 2）：一行回读失败（上游对**这一个** dashboard 说不行）只落 contentUnreadable，
    // 不再让整单 502——对账的存在意义就是把「哪里坏了」**显式报出来**，一行坏拖死全租户的报告
    // 恰是相反。只有非 MetabaseError（代码缺陷等）才继续往上抛。
    const contentUnreadable: { id: string; title: string; metabaseId: number }[] = []
    for (const r of rows) {
      // renderer=platform（终审修复 3）：平台自绘，没有 Metabase dashboard（metabaseId=0 是哨兵，
      // 凡读它之前先判 renderer——Task 2 的承诺）。整体跳过：拿哨兵比对可嵌入集会把它报成
      // missingInMetabase 的永久噪声，回读也会 404。
      if (r.renderer === 'platform') continue
      // 已经报成 missingInMetabase 的行不重复报（回读也只会 404）
      if (!embeddableIds.has(r.metabaseId)) continue
      let content: Awaited<ReturnType<typeof readDashboardContent>>
      try {
        content = await readDashboardContent(deps, r.metabaseId)
      } catch (err) {
        if (err instanceof MetabaseError) {
          contentUnreadable.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
          continue
        }
        throw err
      }
      const params = content.embeddingParams
      if (params[TENANT_SLUG] !== 'locked') {
        tenantUnlocked.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
        continue
      }
      // ① 参数没声明 或 ② 任一卡带 tenant 标签但**没映射** ⇒ 锁了但绑不到。
      //    ② 是**单卡粒度**（人裁 2026-09-29）：半绑定——两张 tenant 卡只映射一张——也要报；
      //    dashboard 粒度的 anyMapped（"有一张映射了就不报"）会漏检它，未映射那张卡在嵌入语境
      //    拿不到 tenant 值、静默显示未过滤数据——正是本任务要抓的失效家族。
      const declared = content.parameters.some((p) => p['slug'] === TENANT_SLUG)
      // 「映射到 tenant」**在这里判**（不在 metabase.ts）：比 parameter_id，而不是"有没有映射"
      // ——挂了别个参数（如 region）的卡用「有映射」判会得 true ⇒ 假绿（Task 3 已清除该启发式，
      // 不许回来）。metabase.ts 是纯 HTTP 客户端，不该知道平台的参数命名约定。
      const isTenantMapped = (d: { parameterMappings?: unknown[] }) =>
        (d.parameterMappings ?? []).some(
          (m) => (m as { parameter_id?: unknown }).parameter_id === TENANT_PARAM_ID,
        )
      const unboundCards = content.dashcards.filter(
        (d) => d.cardId !== null && (content.cardTags[d.cardId] ?? []).includes(TENANT_SLUG) && !isTenantMapped(d),
      )
      if (!declared || unboundCards.length > 0) {
        tenantUnbound.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
      }
    }

    const ok = missingInMetabase.length === 0
      && unregistered.recoverable.length === 0
      && unregistered.needsHuman.length === 0
      && tenantUnlocked.length === 0
      && tenantUnbound.length === 0
      && contentUnreadable.length === 0

    // 差集非空 ⇒ 打一条可检索的告警行：对账结果只在响应体里返回的话，只有**主动去调**的人
    // 才看得见（这正是 #M3c 那条「配了但不对，在请求路径上不可观测」的病）。
    if (!ok) {
      console.warn(
        `[data.reports] 对账差集 org=${org} `
        + `missingInMetabase=${missingInMetabase.length} `
        + `unregistered=${unregistered.recoverable.length}自愈+${unregistered.needsHuman.length}需人看 `
        + `tenantUnlocked=${tenantUnlocked.length} `
        + `tenantUnbound=${tenantUnbound.length} `
        + `contentUnreadable=${contentUnreadable.length}`,
      )
    }
    return c.json({
      ok,
      registered: rows.length,
      embeddable: embeddable.length,
      missingInMetabase,
      tenantUnlocked,
      tenantUnbound,
      contentUnreadable,
      unregistered,
    })
  })
}
