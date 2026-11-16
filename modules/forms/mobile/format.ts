// mobile/format.ts — 移动端 OA 页的展示小工具（纯函数，无业务判断）。
// 时间统一 `YYYY-MM-DD HH:mm`：手机上 `toLocaleString()` 会带完整秒与时区名，卡片里换行更难扫。

export function formatTime(raw: string): string {
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 审批动作 → 人话（引擎/计划里的动词是英文闭集；未知值原样显示，不猜）。 */
export function actionText(action: string | null | undefined): string {
  switch (action) {
    case 'approve': return '通过'
    case 'reject': return '驳回'
    case 'veto': return '否决'
    case 'reassign': return '改派'
    case 'approved': return '已通过'
    case 'rejected': return '已驳回'
    case 'withdrawn': return '已撤回'
    default: return action ?? '—'
  }
}
