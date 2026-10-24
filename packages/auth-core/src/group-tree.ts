// group-tree.ts — Casdoor group 平表 → 树（账户和权限体系 Task 3；spec §3.4：孤儿挂根标记，
// 不丢人；环引用同待遇）。
// 形状依据（真机 spike 2026-10-24，Console 计划附录 B）：显示名是 `displayName`（真机无
// `title` 字段）；parentId=父组名；顶层组 parentId 可为空串也可为 org 名（两种真机形态并存）。
export interface CasdoorGroupLike {
  name: string
  displayName: string
  parentId: string
}

export interface GroupTreeNode {
  name: string
  displayName: string
  parentId: string
  /** parentId 非空、非 org 名、父又不存在（或成环）→ 挂根并标记 */
  orphan: boolean
  memberCount: number
  children: GroupTreeNode[]
}

export function buildGroupTree(
  org: string,
  groups: CasdoorGroupLike[],
  memberCounts?: Map<string, number>,
): GroupTreeNode[] {
  const counts = memberCounts ?? new Map<string, number>()
  const nodes = new Map<string, GroupTreeNode>(
    groups.map((g) => [
      g.name,
      { ...g, orphan: false, memberCount: counts.get(g.name) ?? 0, children: [] },
    ]),
  )
  const roots: GroupTreeNode[] = []
  const pending: Array<{ node: GroupTreeNode; parentName: string }> = []
  for (const g of groups) {
    const node = nodes.get(g.name)
    if (!node) continue
    if (g.parentId === '' || g.parentId === org) roots.push(node)
    else pending.push({ node, parentName: g.parentId })
  }
  // 挂链 + 环防护：父已定根或已挂链才挂；一轮无进展即剩余全部成环（或父缺失前置已判）→ 孤儿挂根
  const settled = new Set(roots.map((r) => r.name))
  let progress = true
  while (progress && pending.length > 0) {
    progress = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const { node, parentName } = pending[i]
      if (!settled.has(parentName)) continue
      nodes.get(parentName)?.children.push(node)
      settled.add(node.name)
      pending.splice(i, 1)
      progress = true
    }
  }
  for (const { node } of pending) {
    node.orphan = true
    roots.push(node)
  }
  const sortRec = (n: GroupTreeNode) => {
    n.children.sort((x, y) => x.displayName.localeCompare(y.displayName, 'zh'))
    n.children.forEach(sortRec)
  }
  roots.sort((x, y) => x.displayName.localeCompare(y.displayName, 'zh'))
  roots.forEach(sortRec)
  return roots
}
