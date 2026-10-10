// identity-links.ts — platform.identity_link 的宿主侧唯一读写层 + IdentityLinks 服务（账户统一设计 §1.2/§2）。
// B1：本文件属宿主，只碰 platform schema；aftersales 数据由调用方作为入参传入。
// 分两层：
//   · store（七导出）：单行可变的行状态原语——一个 (provider, org, external_id) 永远一行，
//     换绑/解绑原地改 status；store 自己不写 audit。
//   · 服务（createIdentityLinks，Task 6）：设计稿 §2 的流程编排（自动匹配/人工修正），
//     历史留痕（platform.audit action='identity.link.*'）在这里与状态变更**同一事务**落行。
import type { Pool, PoolClient } from 'pg'
import type { CasdoorClient } from '@platform/auth-core'
import { LinkError } from '@platform/sdk'
import type { IdentityLinkView, IdentityLinks } from '@platform/sdk'

// LinkError 的**唯一事实源已上移 SDK**（账户统一 Task 8：模块管理面 handler 要按码映射 HTTP，
// 错误类型必须两边同见）。此处原样再出口，保持本模块既有导入面不变。
export { LinkError }

/** 能执行查询的最小面（`Pool` 与事务用的 `PoolClient` 都满足；同 tenant-source.ts 的 SqlExecutor 习语）。 */
export type SqlExecutor = Pick<Pool | PoolClient, 'query'>

export type LinkProvider = 'wechat-oa' | 'wecom'
export type LinkStatus = 'pending' | 'active' | 'revoked' | 'disputed'

export interface IdentityLinkRow {
  id: number
  org: string
  provider: LinkProvider
  externalId: string
  casdoorName: string
  status: LinkStatus
  phone: string | null
  boundVia: 'auto' | 'manual' | null
  sourceApprovalId: number | null
}

/** 手机号归一：取数字；「86 + 11 位」共 13 位时去国家码；恰好 11 位才返回（座机/乱码不匹配）。 */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2)
  return d.length === 11 ? d : null
}

/** 视图掩码：前 3 后 2、中间 `****`（全局约束的掩码规则）。短于 6 位时「前3后2」会把整串
 *  露出来 ⇒ 全遮；null 透传（未采集手机号）。完整手机号绝不进视图（敏感值规矩）。 */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null
  if (phone.length < 6) return '****'
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`
}

// pg 驱动对 int8/bigserial 一律回**字符串**（防精度丢失），而本契约把 id/sourceApprovalId
// 钉成 number ⇒ 读路径显式 ::int 收窄，运行时形状与声明一致（#11：形状必须与真机一致）。
// identity_link 行数是人的量级、source_approval_id 是审批单号，int4 射程足够。
const ROW
  = 'id::int AS id, org, provider, external_id AS "externalId", casdoor_name AS "casdoorName",'
  + ' status, phone, bound_via AS "boundVia", source_approval_id::int AS "sourceApprovalId"'

/** 按外部身份取整行（不限 status）；未绑定返回 null。 */
export async function findLinkByExternal(
  pool: Pool,
  org: string,
  provider: LinkProvider,
  externalId: string,
): Promise<IdentityLinkRow | null> {
  const { rows } = await pool.query<IdentityLinkRow>(
    `select ${ROW} from platform.identity_link`
    + ' where org = $1 and provider = $2 and external_id = $3',
    [org, provider, externalId],
  )
  return rows[0] ?? null
}

/** 任一渠道 active 即正式态：provider 不限，只认 status='active'；没有则 null。 */
export async function findActiveLink(
  pool: Pool,
  org: string,
  externalId: string,
): Promise<{ casdoorName: string } | null> {
  const { rows } = await pool.query<{ casdoorName: string }>(
    'select casdoor_name AS "casdoorName" from platform.identity_link'
    + " where org = $1 and external_id = $2 and status = 'active' limit 1",
    [org, externalId],
  )
  return rows[0] ?? null
}

/** 某账户在某 org 下全部 active 的外部 id（pending/revoked 不列）。 */
export async function listActiveExternalIds(
  pool: Pool,
  org: string,
  casdoorName: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ external_id: string }>(
    "select external_id from platform.identity_link"
    + " where org = $1 and casdoor_name = $2 and status = 'active'",
    [org, casdoorName],
  )
  return rows.map((r) => r.external_id)
}

/** 手机号反查候选账户：distinct casdoor_name、只数 active、跨 provider（调用方先 normalizePhone）。 */
export async function listCandidatesByPhone(
  pool: Pool,
  org: string,
  phone: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ casdoor_name: string }>(
    'select distinct casdoor_name from platform.identity_link'
    + " where org = $1 and phone = $2 and status = 'active'",
    [org, phone],
  )
  return rows.map((r) => r.casdoor_name)
}

/** 绑定写入：同键 (provider, org, external_id) 已存在则**原地更新**（单行可变），返回更新后的行。
 *  bound_at = 最近一次「active 生效」的时点：首插分支与冲突分支都要盖（只在冲突分支写，
 *  全新空库上的首次 active 绑定会漏成 NULL——真机首跑即踩）；非 active 保留原值。 */
export async function upsertLink(
  pool: Pool,
  p: {
    org: string
    provider: LinkProvider
    externalId: string
    casdoorName: string
    phone: string | null
    boundVia: 'auto' | 'manual' | null
    status: LinkStatus
    sourceApprovalId: number | null
  },
): Promise<IdentityLinkRow> {
  const { rows } = await pool.query<IdentityLinkRow>(
    `insert into platform.identity_link
       (org, provider, external_id, casdoor_name, status, phone, bound_via, source_approval_id, bound_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $5 = 'active' then now() else null end)
     on conflict (provider, org, external_id) do update set
       casdoor_name = excluded.casdoor_name,
       phone = excluded.phone,
       bound_via = excluded.bound_via,
       status = excluded.status,
       source_approval_id = excluded.source_approval_id,
       bound_at = case when excluded.status = 'active' then now() else identity_link.bound_at end
     returning ${ROW}`,
    [p.org, p.provider, p.externalId, p.casdoorName, p.status, p.phone, p.boundVia, p.sourceApprovalId],
  )
  return rows[0]!
}

/** 行级变更（换绑/解绑/争议），org 圈死作用域：他 org 的 id 取不到（null）。
 *  revoked_at/revoked_by 只在 status 落 'revoked' 的那次变更盖上；单独传 revokedBy 而不落
 *  revoked 视为误用，不生效（行上留的是「最近一次吊销」的执行人与时点）。
 *  disputed_at 对称：只在 status 落 'disputed' 的那次变更盖 now()（列此前无写通路——评审
 *  裁决补上；同样只进不出，行上留「最近一次争议」的时点）。
 *  patch 只收白名单列、全参数化——调用方传不进任意 SET 片段（注入面 = 这四个键）。 */
export async function mutateLink(
  exec: SqlExecutor,
  org: string,
  id: number,
  patch: { status?: LinkStatus; casdoorName?: string; boundVia?: 'auto' | 'manual' | null; revokedBy?: string },
): Promise<IdentityLinkRow | null> {
  const params: unknown[] = [org, id] // $1 = org（作用域）、$2 = id
  const sets: string[] = []
  if (patch.status !== undefined) {
    params.push(patch.status)
    sets.push(`status = $${params.length}`)
  }
  if (patch.casdoorName !== undefined) {
    params.push(patch.casdoorName)
    sets.push(`casdoor_name = $${params.length}`)
  }
  if (patch.boundVia !== undefined) {
    params.push(patch.boundVia)
    sets.push(`bound_via = $${params.length}`)
  }
  if (patch.status === 'revoked') {
    sets.push('revoked_at = now()')
    if (patch.revokedBy !== undefined) {
      params.push(patch.revokedBy)
      sets.push(`revoked_by = $${params.length}`)
    }
  }
  if (patch.status === 'disputed') {
    sets.push('disputed_at = now()')
  }
  if (sets.length === 0) {
    // 空 patch 不构成 update：退化为按 org+id 读取（org 不对照样 null，与 update 路径同语义）
    const { rows } = await exec.query<IdentityLinkRow>(
      `select ${ROW} from platform.identity_link where org = $1 and id = $2`,
      params,
    )
    return rows[0] ?? null
  }
  const { rows } = await exec.query<IdentityLinkRow>(
    `update platform.identity_link set ${sets.join(', ')}
     where org = $1 and id = $2 returning ${ROW}`,
    params,
  )
  return rows[0] ?? null
}

// ===== IdentityLinks 服务（Task 6）：SDK `IdentityLinks` 的宿主实现（loader 于 Task 7 注入 ctx.identityLinks）=====
// store 层只管行状态；历史留痕在本层与状态变更**同一事务**落行（withTx——本仓事务壳的既有
// 形状，照 admin.ts / migrate.ts，不新立仓级助手）。未经 withTx 的写不存在。
//
// 注入面：casdoorFor 只取 CasdoorClient 的 getUser/ensureUser 两个方法（真 client 或测试替身
// 都满足）；SQL 一律白名单列 + 参数化，与 store 同规。

/** 服务需要的 Casdoor 最小面（app.ts 传整只 CasdoorClient，结构上满足本 Pick）。 */
type CasdoorLinkAdmin = Pick<CasdoorClient, 'getUser' | 'ensureUser'>

/** 服务侧视图查询：与 store 的 ROW 是两个投影——视图带 created_at、不外泄完整 phone
 *  （出函数前过 maskPhone），故不复用 ROW（改它会动 store 七导出的返回形状）。 */
type LinkViewRow = {
  id: number
  provider: LinkProvider
  externalId: string
  casdoorName: string
  status: LinkStatus
  phone: string | null
  boundVia: 'auto' | 'manual' | null
  createdAt: Date
}

const VIEW_SELECT
  = 'id::int AS id, org, provider, external_id AS "externalId", casdoor_name AS "casdoorName",'
  + ' status, phone, bound_via AS "boundVia", created_at AS "createdAt"'

function toView(r: LinkViewRow): IdentityLinkView {
  return {
    id: r.id,
    provider: r.provider,
    externalId: r.externalId,
    casdoorName: r.casdoorName,
    status: r.status,
    phoneMasked: maskPhone(r.phone),
    boundVia: r.boundVia,
    createdAt: r.createdAt.toISOString(),
  }
}

/** 本人的绑定行：跨 provider 取「active 优先、否则最新」的一条（describeOwn 与 dispute 同一挑选）。 */
async function pickOwnRow(
  exec: SqlExecutor,
  org: string,
  externalId: string,
): Promise<LinkViewRow | null> {
  const { rows } = await exec.query<LinkViewRow>(
    `select ${VIEW_SELECT} from platform.identity_link`
    + " where org = $1 and external_id = $2 order by (status = 'active') desc, id desc limit 1",
    [org, externalId],
  )
  return rows[0] ?? null
}

async function readLinkById(exec: SqlExecutor, org: string, id: number): Promise<LinkViewRow | null> {
  const { rows } = await exec.query<LinkViewRow>(
    `select ${VIEW_SELECT} from platform.identity_link where org = $1 and id = $2`,
    [org, id],
  )
  return rows[0] ?? null
}

/** confirm/rebind 的验户门：目标账户必须真在 org 里（getUser null ⇒ LINK_TARGET_MISSING，
 *  handler 映 400）。服务不信任行上的 casdoor_name——人工输入的目标先验再写。 */
async function assertUserExists(
  casdoorFor: (org: string) => CasdoorLinkAdmin,
  org: string,
  name: string,
): Promise<void> {
  const user = await casdoorFor(org).getUser(name)
  if (user === null) throw new LinkError('LINK_TARGET_MISSING')
}

/** audit 一行（与 auth 路由 writeAudit 同款 SQL）；tenant_id 按 casdoor_org 反查（identity_link.org
 *  是纯 text 无 FK，查无 tenant 行则留 null，org 无论如何都在 detail 里）。失败随事务回滚——
 *  「改了状态没留痕」比「改失败」更不可接受。detail 不带手机号。 */
async function writeAudit(
  exec: SqlExecutor,
  org: string,
  actor: string | null,
  action: 'identity.link.confirm' | 'identity.link.rebind' | 'identity.link.revoke' | 'identity.link.dispute',
  detail: Record<string, unknown>,
): Promise<void> {
  const { rows } = await exec.query<{ id: number }>(
    'select id::int as id from platform.tenant where casdoor_org = $1',
    [org],
  )
  await exec.query(
    'insert into platform.audit(tenant_id, actor, action, detail) values ($1, $2, $3, $4)',
    [rows[0]?.id ?? null, actor, action, detail],
  )
}

/** 事务壳：照 admin.ts / migrate.ts 的既有形状（本仓无仓级 withTx，本文件四处 mutate+audit 同事务）。 */
async function withTx<T>(pool: Pool, fn: (exec: SqlExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (err) {
    await client.query('rollback').catch(() => {}) // 连接级故障时 rollback 可能再抛，吞掉保留原错误
    throw err
  } finally {
    client.release()
  }
}

/** 宿主实现工厂：loader（Task 7）在装载期构造一次，注入各模块 ctx.identityLinks。 */
export function createIdentityLinks(
  pool: Pool,
  casdoorFor: (org: string) => CasdoorLinkAdmin,
): IdentityLinks {
  return {
    matchOnApplication: async (input) => {
      // 终态幂等（设计稿 §2）：已 active 的外部身份重复提交申请，返回即止、不改行——
      // 后续申请的新 phone/approvalId 不能改写已生效的绑定
      const existing = await findLinkByExternal(pool, input.org, input.provider, input.externalId)
      if (existing?.status === 'active') return { state: 'active' }
      const phone = normalizePhone(input.phone)
      // 置信池 = identity_link.phone 的 active 行（本地，含回填存量）；Casdoor 侧按手机号查户归 Phase 2
      const candidates = phone === null ? [] : await listCandidatesByPhone(pool, input.org, phone)
      if (candidates.length === 1) {
        // 唯一命中 ⇒ 自动绑定即时生效（bound_via=auto）
        await upsertLink(pool, {
          org: input.org,
          provider: input.provider,
          externalId: input.externalId,
          casdoorName: candidates[0]!,
          phone,
          boundVia: 'auto',
          status: 'active',
          sourceApprovalId: input.approvalId,
        })
        return { state: 'active' }
      }
      if (candidates.length === 0) {
        // 未命中（含手机号无效）⇒ 建草稿 Casdoor user（名 = externalId；add 竞态由 ensureUser
        // 的 getUser 回读兜底——真机语义）+ pending，转人工
        await casdoorFor(input.org).ensureUser(input.externalId)
      }
      // 多命中 ⇒ 不绑，pending + 候选清单转人工；行上 casdoor_name 落首个候选作机器建议
      //（完整候选清单经返回值进审批面，行上只留建议位——casdoor_name 列 NOT NULL 必须有值）
      await upsertLink(pool, {
        org: input.org,
        provider: input.provider,
        externalId: input.externalId,
        casdoorName: candidates[0] ?? input.externalId,
        phone,
        boundVia: null,
        status: 'pending',
        sourceApprovalId: input.approvalId,
      })
      return candidates.length > 1 ? { state: 'multi', candidates } : { state: 'draft' }
    },

    describeOwn: async (org, externalId) => {
      const row = await pickOwnRow(pool, org, externalId)
      return row === null ? null : toView(row)
    },

    listForOrg: async (org, status) => {
      const { rows } = status === undefined
        ? await pool.query<LinkViewRow>(
            `select ${VIEW_SELECT} from platform.identity_link where org = $1 order by id`,
            [org],
          )
        : await pool.query<LinkViewRow>(
            `select ${VIEW_SELECT} from platform.identity_link where org = $1 and status = $2 order by id`,
            [org, status],
          )
      return rows.map(toView)
    },

    // confirm/rebind 的 opts.actor（Task 8）：管理面传会话执行人（identity.userId），落
    // audit 的 actor 列与 detail.actor；缺省（无执行人）保持 Task 6 既有形状——落 null。
    // audit 行仍只在服务层与状态变更同事务落，调用方不得另写。
    confirm: async (org, id, casdoorName, opts) => {
      const actor = opts?.actor ?? null
      await withTx(pool, async (exec) => {
        const row = await readLinkById(exec, org, id)
        if (row === null) throw new LinkError('LINK_NOT_FOUND')
        const target = casdoorName ?? row.casdoorName
        await assertUserExists(casdoorFor, org, target)
        // 人工确认 ⇒ active + bound_via=manual（bound_via 记「这份 active 绑定怎么来的」）
        await mutateLink(exec, org, id, { status: 'active', casdoorName: target, boundVia: 'manual' })
        await writeAudit(exec, org, actor, 'identity.link.confirm', {
          org, id, from: row.status, to: 'active', target, actor,
        })
      })
    },

    rebind: async (org, id, casdoorName, opts) => {
      const actor = opts?.actor ?? null
      await withTx(pool, async (exec) => {
        const row = await readLinkById(exec, org, id)
        if (row === null) throw new LinkError('LINK_NOT_FOUND')
        await assertUserExists(casdoorFor, org, casdoorName)
        // 改绑即生效：换目标账户 + active（人工动作）
        await mutateLink(exec, org, id, { status: 'active', casdoorName, boundVia: 'manual' })
        await writeAudit(exec, org, actor, 'identity.link.rebind', {
          org, id, from: row.casdoorName, to: casdoorName, actor,
        })
      })
    },

    revoke: async (org, id, by) => {
      await withTx(pool, async (exec) => {
        const row = await readLinkById(exec, org, id)
        if (row === null) throw new LinkError('LINK_NOT_FOUND')
        await mutateLink(exec, org, id, { status: 'revoked', revokedBy: by })
        await writeAudit(exec, org, by, 'identity.link.revoke', {
          org, id, from: row.status, to: 'revoked', actor: by,
        })
      })
    },

    dispute: async (org, externalId) => {
      return withTx(pool, async (exec) => {
        const row = await pickOwnRow(exec, org, externalId)
        if (row === null) return false
        await mutateLink(exec, org, row.id, { status: 'disputed' })
        // 异议是本人提起：actor = 外部身份本人（接口无独立 actor 位，签名 SDK 逐字）
        await writeAudit(exec, org, externalId, 'identity.link.dispute', {
          org, id: row.id, from: row.status, to: 'disputed', actor: externalId,
        })
        return true
      })
    },
  }
}
