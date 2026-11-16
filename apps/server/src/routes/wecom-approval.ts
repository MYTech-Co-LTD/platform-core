// routes/wecom-approval.ts — 企微「标准审批」回调（OA P2 Task 4 / issue #2385）
//
// 谁在说话：企微自建应用（租户级「审批应用」，凭据在 platform.tenant 的 wecom_approval_* 五列）
// 把**审批状态变更**推到这里；平台只做只读镜像，**不创建** forms.submission、不进 case-engine。
//
// 两条路由同一 URL（企微后台的「回调 URL」GET 验证 + POST 事件）：
//   GET  ?msg_signature&timestamp&nonce&echostr —— 验签后回 echostr 明文；
//   POST ?msg_signature&timestamp&nonce         —— 外层信封给 AgentID/Encrypt，内层 XML 是事件。
//
// 租户解析：**不用 Host**（回调 URL 在企微后台是应用级配置，不保证与租户域名同源）。
//   · POST：外层 AgentID（明文）→ `platform.tenant.wecom_approval_agent_id`；
//   · GET：没有 AgentID —— 用「验签匹配」反推（各租户 token 各不相同；验签通过且能解密的那个
//     就是它）。两条路都**不猜**：查不到 ⇒ 404 + attention。
//
// 写入路径（B1）：本路由属于宿主，**不直写 forms schema**；绑定解析与幂等 upsert 都经
// `runtime.port('forms','upsertExternalApproval')`（模块供给，见 modules/forms/index.ts）。
//
// 失败姿态：
//   · 验签失败 ⇒ 403 fail-closed，**不写库**（签名不通过 = 请求来源不可信）；
//   · 未知 TemplateId / 未知 SpStatus / 缺 SpNo ⇒ **200 + attention**（企微会对非 200 重推，
//     我们不想把「我们没接住」变成重推风暴；但必须留下 attention，绝不静默丢弃）；
//   · 端口缺失 / 凭据缺失 ⇒ 503（我们的装配问题，让企微重推、也让告警看得见）。
//
// 状态码表（**保守映射**）：1 审批中→pending、2 已同意→approved、3 已驳回→rejected、
// 4 已撤销→canceled。T1 真实回调取证尚未完成（用户前置未提供真实审批样本）——故**不**把
// 未验证的码（5 通过后撤销 / 6 已删除 …）折进已知状态；遇到未登记的码一律 attention + 200，
// 等 T1 抓到真实样本后再按证据扩充本表。
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Pool } from 'pg'
import type { ExternalApprovalUpsertInput, ExternalApprovalUpsertResult } from '@platform/sdk'
import { decryptWecomEnvelope, verifyWecomSignature } from '../wecom/approval-crypto'
import { parseApprovalChange, parseApprovalEnvelope } from '../wecom/approval-parse'

/**
 * 企微 SpStatus → 镜像状态。**唯一映射点**（测试与文档都引用它，别在别处再写一份）。
 * 只收录 T1 之前可以保守认定的四档；未登记码 → attention，不猜。
 */
export const SP_STATUS_TO_MIRROR: Readonly<Record<number, string>> = {
  1: 'pending', // 审批中
  2: 'approved', // 已同意
  3: 'rejected', // 已驳回
  4: 'canceled', // 已撤销
}

/** forms 端口签名（`runtime.port('forms','upsertExternalApproval')` 的形状） */
export type UpsertExternalApproval = (
  input: ExternalApprovalUpsertInput,
) => Promise<ExternalApprovalUpsertResult>

export interface WecomApprovalRoutesDeps {
  pool: Pool
  /**
   * 取 forms 端口。**每次请求现取**（不是装载期固化成值）：端口是 runtime 的产物，
   * 测试可整块替换；未装配 ⇒ undefined ⇒ 503 fail-closed。
   */
  getUpsertPort: () => UpsertExternalApproval | undefined
}

/** 回调需要的那几列（不读整行 TenantRow：本路由不该碰 wecom_secret 等登录凭据）。 */
interface ApprovalTenant {
  org: string
  slug: string
  agentId: string | null
  token: string | null
  aesKey: string | null
}

const TENANT_FIELDS = `slug,
  casdoor_org            as org,
  wecom_approval_agent_id as agent_id,
  wecom_approval_token    as token,
  wecom_approval_aes_key  as aes_key`

/** attention 的落点 id：一个租户一行（org 区分），与集成健康页同表同读面。 */
export const ATTENTION_ID = 'wecom-approval-callback'
const ATTENTION_SLA_SECONDS = 86_400
const ATTENTION_MESSAGE_MAX = 500

function toTenant(r: Record<string, unknown>): ApprovalTenant {
  return {
    org: r['org'] as string,
    slug: r['slug'] as string,
    agentId: (r['agent_id'] as string | null) ?? null,
    token: (r['token'] as string | null) ?? null,
    aesKey: (r['aes_key'] as string | null) ?? null,
  }
}

function hasCryptoCreds(t: ApprovalTenant): boolean {
  return (t.token ?? '') !== '' && (t.aesKey ?? '') !== ''
}

async function tenantsByAgentId(pool: Pool, agentId: string): Promise<ApprovalTenant[]> {
  const { rows } = await pool.query(
    `select ${TENANT_FIELDS} from platform.tenant
      where wecom_approval_agent_id = $1
      order by id`,
    [agentId],
  )
  return rows.map(toTenant)
}

async function tenantsWithCryptoCreds(pool: Pool): Promise<ApprovalTenant[]> {
  const { rows } = await pool.query(
    `select ${TENANT_FIELDS} from platform.tenant
      where coalesce(wecom_approval_token, '') <> ''
        and coalesce(wecom_approval_aes_key, '') <> ''
      order by id`,
  )
  return rows.map(toTenant)
}

interface SignatureQuery {
  timestamp: string
  nonce: string
  signature: string
  echostr?: string
}

function signatureQuery(c: Context): SignatureQuery | null {
  const q = (name: string) => c.req.query(name)
  const timestamp = q('timestamp')
  const nonce = q('nonce')
  // 企微现行字段是 msg_signature；老/第三方实现常写 signature——两个都认，缺一即 fail-closed。
  const signature = q('msg_signature') ?? q('signature')
  if (!timestamp || !nonce || !signature) return null
  return { timestamp, nonce, signature, echostr: q('echostr') }
}

/**
 * 落一条 attention（`platform.integration`，集成健康页的读面）+ 结构化日志 + **装填告警**。
 *
 * `stale_notified = false` 是既有告警通路（`scripts/notify-worker.mjs` 的 drainStaleAlerts）
 * 的装填位：worker 扫到就按 `notify.integration.stale` 入队——这里不自己发通知，与探针
 * 走同一条通路（event_id 含 last_error，同一错误重复回调不会重复轰炸）。
 *
 * **best-effort**：attention 写失败绝不能盖过回调本身的应答（那会让企微重推同一坏事件）。
 * 不回传任何凭据；detail 只放模板 id / 状态码 / AgentID 这类非敏感上下文。
 */
async function recordAttention(
  pool: Pool,
  org: string,
  reason: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const context = detail === undefined ? '' : ` ${JSON.stringify(detail)}`
  const message = `${reason}${context}`.slice(0, ATTENTION_MESSAGE_MAX)
  console.warn(`[wecom-approval] attention evt=${reason} org=${JSON.stringify(org)}${context}`)
  try {
    await pool.query(
      `insert into platform.integration
         (id, org, kind, source, sla_seconds, last_error, last_verdict, stale_notified, updated_at)
       values ($1, $2, 'callback', 'callback:wecom-approval', $3, $4, 'STALE', false, now())
       on conflict (id, org) do update
         set last_error = excluded.last_error,
             last_verdict = 'STALE',
             stale_notified = false,
             updated_at = now()`,
      [ATTENTION_ID, org, ATTENTION_SLA_SECONDS, message],
    )
  } catch (e) {
    console.warn(`[wecom-approval] attention 写入失败（已忽略）：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 成功处理一次回调 ⇒ 清掉该租户的 attention（条件恢复；不碰探针写的 last_ok_at）。
 * `stale_notified = true` 同时解除还没被 worker 取走的告警装填——已恢复的错误不该再通知。
 */
async function clearAttention(pool: Pool, org: string): Promise<void> {
  try {
    await pool.query(
      `update platform.integration
          set last_error = null, last_verdict = null, stale_notified = true, updated_at = now()
        where id = $1 and org = $2 and last_error is not null`,
      [ATTENTION_ID, org],
    )
  } catch {
    // 同上：清理是附赠，失败不影响已完成的镜像写入。
  }
}

function unixSecondsToDate(value: number | undefined): Date | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null
  const ms = value * 1000
  if (Number.isNaN(ms) || ms > Date.now() + 86_400_000) return null // 未来一天以上：脏数据，不落
  return new Date(ms)
}

export function wecomApprovalRoutes(deps: WecomApprovalRoutesDeps) {
  const { pool } = deps

  return new Hono()
    // ── GET：回调 URL 验证（验签后回 echostr 明文） ──
    .get('/approval-callback', async (c) => {
      const q = signatureQuery(c)
      if (q === null || !q.echostr) return c.json({ error: 'BAD_REQUEST' }, 400)

      for (const tenant of await tenantsWithCryptoCreds(pool)) {
        const ok = verifyWecomSignature({
          token: tenant.token!,
          timestamp: q.timestamp,
          nonce: q.nonce,
          encrypt: q.echostr,
          msgSignature: q.signature,
        })
        if (!ok) continue
        try {
          return c.text(decryptWecomEnvelope(q.echostr, tenant.aesKey!), 200)
        } catch (e) {
          // 验签过了却解不开 = 该租户凭据自相矛盾（token 与 aesKey 不同源），记下但继续试别的租户。
          console.warn(
            `[wecom-approval] echostr 解密失败 tenant=${tenant.slug}：`
            + `${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      return c.json({ error: 'BAD_SIGNATURE' }, 403)
    })

    // ── POST：审批状态变更事件 ──
    .post('/approval-callback', async (c) => {
      const q = signatureQuery(c)
      const raw = await c.req.text()
      const envelope = parseApprovalEnvelope(raw)
      if (q === null || !envelope.encrypt) return c.json({ error: 'BAD_REQUEST' }, 400)

      // ① 租户：外层 AgentID 反查（不猜）
      const agentId = envelope.agentId === undefined ? null : String(envelope.agentId)
      if (agentId === null) {
        await recordAttention(pool, '', 'missing_agent_id')
        return c.json({ error: 'UNKNOWN_TENANT' }, 404)
      }
      const candidates = await tenantsByAgentId(pool, agentId)
      if (candidates.length === 0) {
        await recordAttention(pool, '', 'unknown_agent', { agentId })
        return c.json({ error: 'UNKNOWN_TENANT' }, 404)
      }
      if (candidates.length > 1) {
        // 同一 AgentID 配在多个租户上：数据模型上允许（不同 corp 可能有相同 agentId），
        // 但凭 AgentID 无法区分 ⇒ 不猜、不写，交给运维修配置。
        await recordAttention(pool, candidates[0].org, 'ambiguous_agent', { agentId, tenants: candidates.length })
        return c.json({ error: 'AMBIGUOUS_TENANT' }, 409)
      }
      const tenant = candidates[0]
      if (!hasCryptoCreds(tenant)) {
        await recordAttention(pool, tenant.org, 'config_missing', { agentId })
        return c.json({ error: 'APPROVAL_CONFIG_MISSING' }, 503)
      }

      // ② 验签（用**该租户** token）——失败 fail-closed，不写库
      const signatureOk = verifyWecomSignature({
        token: tenant.token!,
        timestamp: q.timestamp,
        nonce: q.nonce,
        encrypt: envelope.encrypt,
        msgSignature: q.signature,
      })
      if (!signatureOk) {
        console.warn(`[wecom-approval] 验签失败 tenant=${tenant.slug}`)
        return c.json({ error: 'BAD_SIGNATURE' }, 403)
      }

      // ③ 解密 + 解析
      let inner: string
      try {
        inner = decryptWecomEnvelope(envelope.encrypt, tenant.aesKey!, { expectXml: true })
      } catch (e) {
        await recordAttention(pool, tenant.org, 'decrypt_failed', { agentId })
        console.warn(
          `[wecom-approval] 解密失败 tenant=${tenant.slug}：${e instanceof Error ? e.message : String(e)}`,
        )
        return c.json({ error: 'BAD_ENCRYPT' }, 403)
      }

      const change = parseApprovalChange(inner)
      if (change === null) {
        await recordAttention(pool, tenant.org, 'unknown_event', { agentId })
        return c.text('', 200)
      }
      // 内层若带 AgentID，必须与外层一致（防「用 A 租户凭据推 B 租户事件」）
      if (change.agentId !== undefined && String(change.agentId) !== agentId) {
        await recordAttention(pool, tenant.org, 'agent_mismatch', { outer: agentId, inner: change.agentId })
        return c.json({ error: 'AGENT_MISMATCH' }, 403)
      }

      // ④ 事件字段闸门：缺什么就落什么 attention，然后 200（不制造重推风暴）
      if (change.spNo === undefined || change.spNo === '') {
        await recordAttention(pool, tenant.org, 'missing_sp_no', { templateId: change.templateId })
        return c.text('', 200)
      }
      if (change.spStatus === undefined) {
        await recordAttention(pool, tenant.org, 'missing_sp_status', { spNo: change.spNo })
        return c.text('', 200)
      }
      const status = SP_STATUS_TO_MIRROR[change.spStatus]
      if (status === undefined) {
        await recordAttention(pool, tenant.org, 'unknown_sp_status', {
          spNo: change.spNo, spStatus: change.spStatus,
        })
        return c.text('', 200)
      }

      // ⑤ 经 forms 端口写镜像（绑定解析在模块侧）
      const upsert = deps.getUpsertPort()
      if (upsert === undefined) {
        await recordAttention(pool, tenant.org, 'port_unavailable', { spNo: change.spNo })
        return c.json({ error: 'APPROVAL_PORT_UNAVAILABLE' }, 503)
      }

      let result: ExternalApprovalUpsertResult
      try {
        result = await upsert({
          org: tenant.org,
          // 企微 TemplateId 与绑定 body.processCode 同值（T1 取证口径）；缺它 ⇒ 空串 ⇒ 必然 unknown_template
          processCode: change.templateId ?? '',
          providerRef: change.spNo,
          // 回调不携带标题/申请人姓名：只带发起人 userId；`sys` 是企微系统发件人，不是人。
          requester: change.requester === 'sys' ? null : (change.requester ?? null),
          status,
          startedAt: unixSecondsToDate(change.applyTime),
          // 状态变更回调没有「完成时间」字段（只有发起时间）；不拿收到时间冒充，留给对账补。
          finishedAt: null,
          detail: null,
        })
      } catch (e) {
        // 写库失败不是「事件不合法」——让企微重推（5xx），并留下可见原因。
        await recordAttention(pool, tenant.org, 'upsert_failed', { spNo: change.spNo })
        console.error(
          `[wecom-approval] 镜像写入失败 tenant=${tenant.slug} spNo=${change.spNo}：`
          + `${e instanceof Error ? e.message : String(e)}`,
        )
        return c.json({ error: 'UPSERT_FAILED' }, 500)
      }

      if (!result.ok) {
        // unknown_template = 本租户没绑定该模板；status_invalid = 我们的映射/数据有 bug。
        // 两种都是「我们没接住」，但企微没有义务重推，故 200 + attention（不静默）。
        await recordAttention(pool, tenant.org, result.reason, {
          templateId: change.templateId, spNo: change.spNo,
        })
        return c.text('', 200)
      }

      await clearAttention(pool, tenant.org)
      // 企微要求回调应答正文为空（被动回复语义）；回 "success" 之类会被当成回复内容。
      return c.text('', 200)
    })
}
