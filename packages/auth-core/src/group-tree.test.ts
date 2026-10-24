// group-tree.test.ts — 树组装语义（账户和权限体系 Task 3；形状按真机 spike 附录 B：
// 顶层组 parentId 可为空串也可为 org 名；孤儿/成环挂根标记，不丢人）
import { describe, expect, test } from 'vitest'
import { buildGroupTree } from './group-tree'

describe('buildGroupTree', () => {
  test('parentId 组装成树；memberCount 按名归节点', () => {
    const tree = buildGroupTree(
      'org',
      [
        { name: 'hq', displayName: '总部', parentId: 'org' }, // 真机形态：顶层 parentId=org 名
        { name: 'shop-a', displayName: 'A 店', parentId: 'hq' },
      ],
      new Map([['shop-a', 12]]),
    )
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('hq')
    expect(tree[0].children[0]).toMatchObject({ name: 'shop-a', memberCount: 12, orphan: false })
  })

  test('parentId 为空串的顶层组也是根（真机两种顶层形态并存）', () => {
    const tree = buildGroupTree('org', [{ name: 'top', displayName: '顶级', parentId: '' }])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ name: 'top', orphan: false })
  })

  test('孤儿节点挂根并标记 orphan（不丢人）', () => {
    const tree = buildGroupTree('org', [{ name: 'lost', displayName: '失联部门', parentId: 'ghost' }])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ name: 'lost', orphan: true, children: [] })
  })

  test('环引用不挂死：成环对按孤儿挂根', () => {
    const tree = buildGroupTree('org', [
      { name: 'a', displayName: 'A', parentId: 'b' },
      { name: 'b', displayName: 'B', parentId: 'a' },
    ])
    expect(tree).toHaveLength(2)
    expect(tree.every((n) => n.orphan)).toBe(true)
  })

  test('深层链路完整挂接；同名 displayName 按 zh 排序', () => {
    const tree = buildGroupTree('org', [
      { name: 'l3', displayName: '三级', parentId: 'l2' },
      { name: 'l2', displayName: '二级', parentId: 'l1' },
      { name: 'l1', displayName: '一级', parentId: 'org' },
    ])
    expect(tree[0].name).toBe('l1')
    expect(tree[0].children[0].name).toBe('l2')
    expect(tree[0].children[0].children[0].name).toBe('l3')
  })
})
