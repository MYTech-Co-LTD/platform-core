// audit.ts — 售后写操作审计（迁移 007；评审 P0-2）。
//
// 与业务写**同事务**：调用方在事务里传 client；没有事务的单条写（规则 CRUD 的 insert/update/delete）
// 用 pool——审计失败即抛（await），不做「审计失败但业务成功」的静默降级（与宿主 writeAudit 同纪律）。
//
// detail 纪律：只记业务事实（状态/金额/比例/计数/被删内容摘要），**不记手机号明文、不记密钥**。
// 唯一可能需要脱敏的是 employee 相关——本文件只提供写入器，脱敏由调用方在组装 detail 时保证。

/** pg 的最小查询面（Pool 与 PoolClient 都满足） */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

export interface AuditEntry {
  org: string
  /** 操作人（session userId / 员工登记时的访客 openid 视场景传，调用方决定语义） */
  actor: string
  /** `<entity>.<verb>`，如 `ticket.process` / `rule.delete` / `attachment.gc` */
  action: string
  /** 目标标识（单号 / 规则 id / 员工 id / 审批 id）；GC 这类批量动作用空串 */
  target?: string
  detail?: Record<string, unknown>
}

export async function writeAudit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    'insert into aftersales.audit(org, actor, action, target, detail) values ($1, $2, $3, $4, $5::jsonb)',
    [e.org, e.actor, e.action, e.target ?? '', JSON.stringify(e.detail ?? {})],
  )
}
