// org-sync-credential.ts — 组织同步用的企微凭据选择（**单一实现**，HTTP 路由与 CLI job 共用）。
//
// 为什么分开：企微里「读通讯录」与「发消息」是两套权限，且都受**应用可见范围**约束——
// 2026-10-31 山海实测：可见范围只有 2 人的应用，`department/list` 回空、`user/list` 回 60011，
// 而同一条 secret 却能正常发消息。登录应用（带 agentid）不宜随便扩范围，故同步允许用另一个应用：
// `WECOM_SYNC_SECRET__<ORG>`（env，isSecret）= 该应用的 corpsecret（同一 corpId）。
//
// 缺省回落到 `platform.tenant.wecom_secret`（现状），并打 warn——**不静默**。
//
// 抽成独立文件的原因：定时 job（scripts/org-sync-all.mjs）和 `POST /org-sync` 必须用同一套
// 选择规则；两处各写一份会出现「手动同步能跑、定时任务用了另一个应用」的漂移。

/** 选择凭据所需的最小租户形状（路由的 TenantRow 与脚本的查询行都满足）。 */
export interface SyncCredentialTenant {
  casdoor_org: string
  wecom_corp_id: string | null
  wecom_secret: string | null
}

export function syncCredential(
  t: SyncCredentialTenant,
  env: NodeJS.ProcessEnv,
): { corpId: string; secret: string } {
  const key = `WECOM_SYNC_SECRET__${t.casdoor_org.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
  const override = env[key]
  if (override) return { corpId: t.wecom_corp_id ?? '', secret: override }
  console.warn(
    JSON.stringify({
      event: 'wecom_sync_uses_login_app',
      org: t.casdoor_org,
      hint: `可配 ${key} 用独立的通讯录应用`,
    }),
  )
  return { corpId: t.wecom_corp_id ?? '', secret: t.wecom_secret ?? '' }
}
