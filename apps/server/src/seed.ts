// seed.ts — demo 种子：acme/beta 两租户 + demo 模块启用（幂等收敛，重跑 N 次状态一致）
//
// 消费方：宿主入口 SEED_DEMO=1 时调（Task 16）与测试。收敛语义：以 slug 为键 upsert 全部
// 品牌字段、域名收敛到目标集（清历史脏域）、tenant_module on conflict do nothing。
import type { Pool } from 'pg'

interface SeedTenant {
  slug: string
  casdoorOrg: string
  productName: string
  domains: string[]
  loginMethods: string[]
  wecomCorpId?: string
  wecomAgentId?: string
  wecomSecret?: string
}

const DEMO_TENANTS: SeedTenant[] = [
  {
    slug: 'acme',
    casdoorOrg: 'acme',
    productName: 'Acme 工单',
    domains: ['acme.test'],
    loginMethods: ['password', 'wecom-qr'],
    wecomCorpId: 'ww_demo_corp',
    wecomAgentId: '1000002',
    wecomSecret: 'demo-secret',
  },
  {
    slug: 'beta',
    casdoorOrg: 'beta',
    productName: 'Beta 平台',
    domains: ['beta.test'],
    loginMethods: ['password'],
  },
]

const DEMO_MODULE_ID = 'demo'

/** 幂等 upsert demo 租户与模块启用（单事务：要么全收敛要么不动） */
export async function seedDemo(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const t of DEMO_TENANTS) {
      // 品牌字段全量 upsert（含默认值三件）——跨会话收敛，不留旧值。
      // wecom_auto_signup 一并收敛 false（issue #32）：安全旗标要确定性关——不像
      // wecom_provider 留 NULL 给人工，JIT 开关若不收敛，测试/演示环境手工翻过一次
      // 就永久漂着，"旗标关 = fail-closed"的回归钉也失去意义
      const { rows } = await client.query<{ id: number }>(
        `insert into platform.tenant(
            slug, casdoor_org, product_name, logo, primary_color, background,
            login_methods, wecom_corp_id, wecom_agent_id, wecom_secret, wecom_auto_signup)
          values ($1, $2, $3, null, '#1890ff', 'default', $4, $5, $6, $7, false)
          on conflict (slug) do update set
            casdoor_org   = excluded.casdoor_org,
            product_name  = excluded.product_name,
            logo          = excluded.logo,
            primary_color = excluded.primary_color,
            background    = excluded.background,
            login_methods = excluded.login_methods,
            wecom_corp_id = excluded.wecom_corp_id,
            wecom_agent_id= excluded.wecom_agent_id,
            wecom_secret  = excluded.wecom_secret,
            wecom_auto_signup = excluded.wecom_auto_signup
          returning id`,
        [
          t.slug,
          t.casdoorOrg,
          t.productName,
          t.loginMethods,
          t.wecomCorpId ?? null,
          t.wecomAgentId ?? null,
          t.wecomSecret ?? null,
        ],
      )
      const tenantId = rows[0].id
      // 域名收敛到目标集：先删该租户名下多余域，再补缺（on conflict 兜底防域被别租户占）
      await client.query(
        'delete from platform.tenant_domain where tenant_id = $1 and domain <> all($2)',
        [tenantId, t.domains],
      )
      for (const domain of t.domains) {
        await client.query(
          'insert into platform.tenant_domain(tenant_id, domain) values ($1, $2) on conflict (domain) do nothing',
          [tenantId, domain],
        )
      }
      await client.query(
        'insert into platform.tenant_module(tenant_id, module_id, enabled) values ($1, $2, true)'
          + ' on conflict (tenant_id, module_id) do nothing',
        [tenantId, DEMO_MODULE_ID],
      )
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {}) // 连接级故障时 rollback 可能再抛，吞掉保留原错误
    throw err
  } finally {
    client.release()
  }
}
