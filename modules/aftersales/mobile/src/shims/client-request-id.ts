// src/shims/client-request-id.ts —— 幂等键（= 附件 object key 里的 {ticket_ref}，spec §3.2）。
//
// 三条语义各自对着一个**具体的线上症状**，别把它们当成风格问题：
//   ① 重试同键 —— 否则幂等失效，一次重试建两张工单；
//   ② 跨刷新同键 —— 否则刷新后换了新键，**之前传的附件认领不回来**（§5 #12 的孤儿附件）；
//   ③ 成功后轮换 —— 否则同一会话提交第二笔时被幂等判重、**服务端静默返回第一笔**，
//      而前端显示「提交成功」：用户以为提交了新工单，落库的却是旧的那笔。
//
// 上传与提交**共用**这个键（附件就是挂在它下面的），所以它只有一处读写面。
const KEY = 'aftersales.clientRequestId'

/** 取当前会话的键；没有就现造一个（语义①②：只有这里造键，所有调用方读同一个）。 */
export function currentClientRequestId(): string {
  const existing = sessionStorage.getItem(KEY)
  if (existing !== null && existing !== '') return existing
  const fresh = crypto.randomUUID()
  sessionStorage.setItem(KEY, fresh)
  return fresh
}

/**
 * 语义③。**调用点只有一个**：提交**成功**（含服务端回 `duplicated: true` 的那种——
 * 那也是这一笔已经落库了，用户的下一次提交理应是一张新工单）。
 */
export function rotateClientRequestId(): void {
  sessionStorage.removeItem(KEY)
}
