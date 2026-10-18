// seed.ts — 把 WORKFLOW_COPIES 播进 Novu（**create-if-absent**：只建缺失的，不覆盖 dashboard 改动）。
//
// ⚠️ **已知边界（issue #44 同类风险）**：create-if-absent 意味着**改文案不会收敛存量**——dashboard 或
//    早期手工建的条目会与 repo 漂移，播种只保证「新名字能建出来」。改文案要收敛必须另走
//    「比 content → 漂移即 PUT」的 deliver 路径（本仓暂未实现；交付时须在交付记录里标注该风险）。
//
// 形状照既有实现（`data-platform-scaffold/modules/ticket-dispatch/src/integrations/novu-seed.mjs`）
// ——**抄形状不抄代码**（跨仓/跨模块不 import）。机制重复是 2026-10-18 归属决策「B」明确接受的代价。
import { WORKFLOW_COPIES, type WorkflowCopy } from './workflows'

export interface SeedResult {
  created: string[]
  skipped: string[]
}

type FetchImpl = typeof fetch

/** workflow 必须挂在 notification group 下（该版 Novu 创建接口 422 强制要求）；每个环境各自成组：
 *  取第一个，没有则建 "General"。 */
async function resolveGroupId(base: string, headers: Record<string, string>, fetchImpl: FetchImpl): Promise<string> {
  const r = await fetchImpl(`${base}/v1/notification-groups`, { headers })
  if (!r.ok) throw new Error(`获取 notification group 失败 HTTP ${r.status}`)
  const list = ((await r.json()) as { data?: { _id: string }[] }).data ?? []
  if (list.length) return list[0]!._id
  const c = await fetchImpl(`${base}/v1/notification-groups`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'General' }),
  })
  if (!c.ok) throw new Error(`创建 notification group 失败 HTTP ${c.status}`)
  return ((await c.json()) as { data?: { _id: string } }).data?._id ?? ''
}

export async function seedWorkflows(deps: {
  base: string
  key: string
  fetchImpl?: FetchImpl
  copies?: WorkflowCopy[]
}): Promise<SeedResult> {
  const { base, key, fetchImpl = globalThis.fetch, copies = WORKFLOW_COPIES } = deps
  const headers = { 'content-type': 'application/json', authorization: `ApiKey ${key}` }

  const probe = await fetchImpl(`${base}/v1/workflows?limit=100`, { headers })
  if (!probe.ok) {
    throw new Error(`Novu 探活失败 HTTP ${probe.status}（403=边缘未放行或实例未部署，先解决基建再 seed）`)
  }
  const existing = new Set(
    (((await probe.json()) as { data?: { name: string }[] }).data ?? []).map((w) => w.name),
  )
  const groupId = await resolveGroupId(base, headers, fetchImpl)

  const created: string[] = []
  const skipped: string[] = []
  for (const wf of copies) {
    if (existing.has(wf.name)) {
      skipped.push(wf.name)
      continue
    }
    const body = JSON.stringify({
      name: wf.name,
      active: true,
      notificationGroupId: groupId,
      // chat 模板 content 必须是字符串（Handlebars 编译路径）；块数组是 in-app 富文本形状，
      // 3.19 能存进去但执行期抛 "Message content could not be generated"。
      steps: [{ template: { type: 'chat', content: wf.text } }],
    })
    let r = await fetchImpl(`${base}/v1/workflows`, { method: 'POST', headers, body })
    if (r.status === 400) {
      // 旧版 Novu 无 /v1/workflows 写端点 → 回退 deprecated 别名
      r = await fetchImpl(`${base}/v1/notification-templates`, { method: 'POST', headers, body })
    }
    if (!r.ok) throw new Error(`创建 ${wf.name} 失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    created.push(wf.name)
  }
  return { created, skipped }
}
