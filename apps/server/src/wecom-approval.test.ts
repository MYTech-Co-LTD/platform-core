// wecom-approval.test.ts — 企微标准审批回调 host 路由 + forms 端口（OA P2 Task 4 / issue #2385）
//
// 端到端（真 PG）：路由 → forms 端口（createPorts）→ storage upsert → DB。只把 loader 的
// 装载期接线换成本地直取端口，其余链路一字不改——「路由直接 import 模块内部函数」的替身
// 会让端口契约（绑定解析 / unknown_template 结论）结构性不可见。
//
// 覆盖：GET 验签回 echostr、POST 合法事件落镜像、重放幂等、状态推进、验签失败 403 不写库、
// 未知 TemplateId 落 attention、未知 AgentID 404、未知 SpStatus 不猜（attention + 200）。
import { createCipheriv, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import formsModule from '../../../modules/forms/index'
import * as formsStore from '../../../modules/forms/storage'
import { applyMigrations as applyFormsMigrations } from '../../../modules/forms/test-util'
import { runMigrations } from './migrate'
import { ATTENTION_ID, SP_STATUS_TO_MIRROR, wecomApprovalRoutes } from './routes/wecom-approval'
import { wecomSignature } from './wecom/approval-crypto'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

/** 固定测试凭据（不是任何真实环境的值；EncodingAESKey 是合法 43 字符 base64） */
const AES_KEY = 'Xk3p9QzR7mT2vW8bY5nJ6cL1hF4dS0gA2eU7iK9oP3t'
const TOKEN = 'callback-test-token'
const TEMPLATE = 'expense-2026'
const TIMESTAMP = '1700000000'
const NONCE = 'nonce-t4'

/** 本地加密替身（与 approval-crypto.test.ts 同形：企微只加密到平台这一侧）。 */
function encryptForTest(msg: string, aesKey = AES_KEY): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const msgBuf = Buffer.from(msg, 'utf8')
  const msgLen = Buffer.alloc(4)
  msgLen.writeUInt32BE(msgBuf.length)
  const plain = Buffer.concat([randomBytes(16), msgLen, msgBuf, Buffer.from('wx-test-corp', 'utf8')])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}

function innerXml(opts: {
  spNo: string
  spStatus: number
  templateId?: string
  agentId?: string
  applyTime?: number
}): string {
  const applyTime = opts.applyTime ?? 1_700_000_000
  return `<xml>
  <ToUserName><![CDATA[wx-test-corp]]></ToUserName>
  <FromUserName><![CDATA[sys]]></FromUserName>
  <CreateTime>1700000001</CreateTime>
  <MsgType><![CDATA[event]]></MsgType>
  <Event><![CDATA[sys_approval_change]]></Event>
  <AgentID><![CDATA[${opts.agentId ?? ''}]]></AgentID>
  <ApprovalInfo>
    <SpNo><![CDATA[${opts.spNo}]]></SpNo>
    <SpStatus>${opts.spStatus}</SpStatus>
    <TemplateId><![CDATA[${opts.templateId ?? TEMPLATE}]]></TemplateId>
    <ApplyTime>${applyTime}</ApplyTime>
    <Applyer><UserId><![CDATA[zhangsan]]></UserId></Applyer>
  </ApprovalInfo>
</xml>`
}

function outerXml(agentId: string, encrypt: string): string {
  return `<xml>
  <ToUserName><![CDATA[wx-test-corp]]></ToUserName>
  <AgentID><![CDATA[${agentId}]]></AgentID>
  <Encrypt><![CDATA[${encrypt}]]></Encrypt>
</xml>`
}

describePg('企微标准审批回调（OA P2 T4）', () => {
  let pool: Pool
  let app: Hono
  const suffix = Math.random().toString(36).slice(2, 10)
  const ORG = `oa-callback-test-${suffix}`
  const SLUG = `oa-callback-${suffix}`
  const AGENT_ID = String(1_000_000 + Math.floor(Math.random() * 800_000))

  const attentionOf = async (org: string) => {
    const { rows } = await pool.query(
      'select last_error from platform.integration where id = $1 and org = $2',
      [ATTENTION_ID, org],
    )
    return (rows[0]?.last_error as string | undefined) ?? null
  }
  const mirrorRows = async (providerRef: string) => {
    const { rows } = await pool.query(
      `select status, process_code, provider_ref, requester, started_at
         from forms.external_approval where org = $1 and provider_ref = $2`,
      [ORG, providerRef],
    )
    return rows
  }

  const post = async (opts: {
    spNo: string
    spStatus: number
    templateId?: string
    /** 参与签名的 token（验签失败用） */
    signToken?: string
    /** 外层 AgentID（未知租户用） */
    agentId?: string
    innerAgentId?: string
    aesKey?: string
  }): Promise<Response> => {
    const encrypt = encryptForTest(
      innerXml({
        spNo: opts.spNo,
        spStatus: opts.spStatus,
        templateId: opts.templateId,
        // 内层 AgentID 缺省与外层一致（真实回调不一定带；带了就必须一致）
        agentId: opts.innerAgentId ?? (opts.agentId ?? AGENT_ID),
      }),
      opts.aesKey ?? AES_KEY,
    )
    const signature = wecomSignature({
      token: opts.signToken ?? TOKEN,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      encrypt,
    })
    const qs = `msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`
    return app.request(`/api/platform/wecom/approval-callback?${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: outerXml(opts.agentId ?? AGENT_ID, encrypt),
    })
  }

  const get = async (echostr: string, opts: { token?: string } = {}): Promise<Response> => {
    const encrypt = encryptForTest(echostr)
    const signature = wecomSignature({
      token: opts.token ?? TOKEN,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      encrypt,
    })
    return app.request(
      `/api/platform/wecom/approval-callback?msg_signature=${signature}&timestamp=${TIMESTAMP}`
      + `&nonce=${NONCE}&echostr=${encodeURIComponent(encrypt)}`,
    )
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)), {
      onMissingDir: 'error',
    })
    await applyFormsMigrations(pool)

    await pool.query(
      `insert into platform.tenant
         (slug, casdoor_org, wecom_approval_corp_id, wecom_approval_agent_id,
          wecom_approval_secret, wecom_approval_token, wecom_approval_aes_key)
       values ($1, $2, 'wx-test-corp', $3, 'test-secret', $4, $5)`,
      [SLUG, ORG, AGENT_ID, TOKEN, AES_KEY],
    )

    // 已发布的 wecom_native 绑定（模板闸门：回调只认它）
    const body = {
      provider: 'wecom_native',
      processCode: TEMPLATE,
      deepLink: 'https://example.com/wecom/approval',
      name: '标准报销',
      verifiedChain: ['T4 单测：模板闸门夹具'],
      verifiedAt: '2026-11-16T10:00:00Z',
    }
    const version = await formsStore.newDraft(pool, ORG, 'expense-native', body, 'tester', 'approval_def')
    await formsStore.publish(pool, ORG, 'expense-native', version, 'tester', 'approval_def')

    // 与 loader 同源的端口取法：createPorts → runtime.port('forms','upsertExternalApproval')
    const ports = formsModule.createPorts!({ pool })
    const upsert = ports.upsertExternalApproval!
    app = new Hono()
    app.route('/api/platform/wecom', wecomApprovalRoutes({ pool, getUpsertPort: () => upsert }))
  })

  afterAll(async () => {
    await pool.query('delete from forms.external_approval where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from forms.asset_head where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from forms.asset_version where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from platform.integration where id = $1 and org = any($2)', [ATTENTION_ID, [ORG, '']])
      .catch(() => {})
    await pool.query('delete from platform.tenant where casdoor_org = $1', [ORG]).catch(() => {})
    await pool.end()
  })

  it('GET：验签通过回 echostr 明文；签名错 403', async () => {
    const ok = await get('4821937465')
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('4821937465')

    const bad = await get('4821937465', { token: 'wrong-token' })
    expect(bad.status).toBe(403)
  })

  it('POST 合法事件：经 forms 端口 upsert 镜像行（org/模板/单号/申请人/开始时间）', async () => {
    const res = await post({ spNo: 'SP-APPROVED-1', spStatus: 1 })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')

    const rows = await mirrorRows('SP-APPROVED-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'pending',
      process_code: TEMPLATE,
      provider_ref: 'SP-APPROVED-1',
      requester: 'zhangsan',
    })
    expect(rows[0].started_at).toBeInstanceOf(Date)
  })

  it('重放同一事件：幂等（仍是 1 行，不新增）', async () => {
    const before = await mirrorRows('SP-APPROVED-1')
    const res = await post({ spNo: 'SP-APPROVED-1', spStatus: 1 })
    expect(res.status).toBe(200)
    const after = await mirrorRows('SP-APPROVED-1')
    expect(after).toHaveLength(before.length)
    expect(after).toHaveLength(1)
  })

  it('状态推进：同一 SpNo 再推 approved ⇒ 更新原行（不新增、发起人保留）', async () => {
    const res = await post({ spNo: 'SP-APPROVED-1', spStatus: 2 })
    expect(res.status).toBe(200)
    const rows = await mirrorRows('SP-APPROVED-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('approved')
    expect(rows[0].requester).toBe('zhangsan')
  })

  it('验签失败 403，且不写库', async () => {
    const res = await post({ spNo: 'SP-BADSIG-1', spStatus: 1, signToken: 'wrong-token' })
    expect(res.status).toBe(403)
    expect(await mirrorRows('SP-BADSIG-1')).toHaveLength(0)
  })

  it('未知 TemplateId：200 + attention，不写镜像（不静默丢弃）', async () => {
    const res = await post({ spNo: 'SP-NOTEMPLATE-1', spStatus: 1, templateId: 'template-not-bound' })
    expect(res.status).toBe(200)
    expect(await mirrorRows('SP-NOTEMPLATE-1')).toHaveLength(0)
    expect(await attentionOf(ORG)).toContain('unknown_template')
    expect(await attentionOf(ORG)).toContain('template-not-bound')
    // 装填既有告警通路（notify-worker drainStaleAlerts）：attention 不能只写字段不通知
    const { rows } = await pool.query(
      'select stale_notified from platform.integration where id = $1 and org = $2',
      [ATTENTION_ID, ORG],
    )
    expect(rows[0].stale_notified).toBe(false)
  })

  it('未知 AgentID：404 + attention（不猜租户、不写库）', async () => {
    const res = await post({ spNo: 'SP-NOAGENT-1', spStatus: 1, agentId: '9999999' })
    expect(res.status).toBe(404)
    expect(await mirrorRows('SP-NOAGENT-1')).toHaveLength(0)
    expect(await attentionOf('')).toContain('unknown_agent')
  })

  it('未登记的 SpStatus 不猜：200 + attention，不写库（码表保守，等 T1 证据）', async () => {
    const res = await post({ spNo: 'SP-UNKNOWNSTATUS-1', spStatus: 5 })
    expect(res.status).toBe(200)
    expect(await mirrorRows('SP-UNKNOWNSTATUS-1')).toHaveLength(0)
    expect(await attentionOf(ORG)).toContain('unknown_sp_status')
    // 映射表本身也必须只含保守四档（防止后来者“顺手”塞未验证码）
    expect(Object.keys(SP_STATUS_TO_MIRROR).sort()).toEqual(['1', '2', '3', '4'])
  })
})
