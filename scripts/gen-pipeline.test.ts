// scripts/gen-pipeline.test.ts — 源清单生成器（P0/P1 扩展）的行为钉。
//
// 钉三件事：
//   ① 旧形态（pagination=none、单账套）生成物不变——扩展不能改变既有源的行为；
//   ② `static_pages` 真的生成 N 个静态页节点 + ctl.merge（正典 §1.7 #41 的形态），页码逐页改写；
//   ③ 口径类错误在 validate 阶段就拦（缺 chunk= / 缺页码占位 / account 与 accounts 同给 / foreach）。
import { describe, expect, it } from 'vitest'
import { buildPipeline, pipelineNames, validateManifest } from './gen-pipeline.mjs'

/** 一份最小可用 manifest（单账套、无分页）。 */
function baseManifest() {
  return {
    id: 'pilot.demo',
    domain: 'pilot',
    account: '3120',
    source: {
      connectionRef: 'lemeng',
      url: 'https://example.invalid/api/find',
      method: 'POST',
      body: '{"date_start": "${date-1d}", "page_number": 1, "page_size": 200}',
      responsePath: '/result',
      schema: [{ name: 'order_no', type: 'string' }],
      pagination: { type: 'none' },
    },
    transform: { sql: 'SELECT order_no FROM input' },
    sink: {
      connectionRef: 'zos',
      bucket: '${ENV:ZOS_BUCKET}',
      key: 'pilot/demo/system_book=${ENV:SYSTEM_BOOK}/bizday=${date-1d}/chunk=seg1.parquet',
    },
  }
}

/** 深拷贝后改一处。 */
function mutate(fn: (m: any) => void) {
  const m = JSON.parse(JSON.stringify(baseManifest()))
  fn(m)
  return m
}

describe('gen-pipeline：既有形态不变', () => {
  it('pagination=none 仍是 s → t → k 三个节点', () => {
    const m = baseManifest()
    const p: any = buildPipeline(m)
    expect(p.name).toBe('pilot.demo')
    expect(p.nodes.map((n: any) => n.id)).toEqual(['s', 't', 'k'])
    expect(p.nodes[0].data.properties.body).toBe(m.source.body)
    expect(p.nodes[0].data.properties.paginationType).toBe('none')
  })

  it('单账套不追加后缀', () => {
    expect(pipelineNames(baseManifest() as any)).toEqual(['pilot.demo'])
  })
})

describe('gen-pipeline：static_pages', () => {
  const pages = () =>
    mutate((m) => {
      m.source.pagination = { type: 'static_pages', pages: 3, pageParam: 'page_number' }
    })

  it('生成 N 个静态页节点 + merge，页码逐页改写', () => {
    const p: any = buildPipeline(pages())
    expect(p.nodes.map((n: any) => n.id)).toEqual(['p1', 'p2', 'p3', 'merge', 't', 'k'])
    const bodies = p.nodes.filter((n: any) => n.id.startsWith('p')).map((n: any) => n.data.properties.body)
    expect(bodies[0]).toContain('"page_number": 1')
    expect(bodies[1]).toContain('"page_number": 2')
    expect(bodies[2]).toContain('"page_number": 3')
    // 每页都保留模板里的其它占位（不能被 JSON 重排丢掉）
    expect(bodies[0]).toContain('${date-1d}')
    // merge 的入口句柄必须 main_1..main_N
    const handles = p.edges.filter((e: any) => e.target === 'merge').map((e: any) => e.targetHandle)
    expect(handles).toEqual(['main_1', 'main_2', 'main_3'])
    // 页节点仍然申报 schema（空页时引擎按它建表）
    expect(p.nodes[0].data.schema).toEqual([{ name: 'order_no', type: 'string' }])
  })

  it('缺 chunk= 的 sink.key 被拦', () => {
    const m = pages()
    m.sink.key = 'pilot/demo/bizday=${date-1d}/all.parquet'
    expect(validateManifest(m).join()).toContain('chunk=')
  })

  it('body 里没有页码占位被拦', () => {
    const m = pages()
    m.source.body = '{"date_start": "${date-1d}"}'
    expect(validateManifest(m).join()).toContain('page_number')
  })

  it('pages 越界被拦', () => {
    const m = pages()
    m.source.pagination.pages = 0
    expect(validateManifest(m).join()).toContain('pages')
  })

  it('truncationGuard：加 count→ctl.die 叶子哨兵（阈值 pages×pageSize）', () => {
    const m = mutate((x) => {
      x.source.pagination = { type: 'static_pages', pages: 3, pageSize: 2, truncationGuard: true }
    })
    expect(validateManifest(m)).toEqual([])
    const p: any = buildPipeline(m as any)
    expect(p.nodes.map((n: any) => n.id)).toEqual(['p1', 'p2', 'p3', 'merge', 'q', 'dg', 't', 'k'])
    expect(p.nodes.find((n: any) => n.id === 'q').data.properties.sql).toContain('= 6')
    const die = p.nodes.find((n: any) => n.id === 'dg')
    expect(die.data.componentId).toBe('ctl.die')
    expect(die.data.properties.condition).toBe('has-rows')
    // 哨兵是叶子：没有出边（真机实测叶子 die 会被执行）
    expect(p.edges.some((e: any) => e.source === 'dg')).toBe(false)
  })

  it('truncationGuard 缺 pageSize 被拦', () => {
    const m = mutate((x) => {
      x.source.pagination = { type: 'static_pages', pages: 3, truncationGuard: true }
    })
    expect(validateManifest(m).join()).toContain('pageSize')
  })

  it('truncationGuard 不能配 none', () => {
    const m = mutate((x) => {
      x.source.pagination = { type: 'none', truncationGuard: true }
    })
    expect(validateManifest(m).join()).toContain('static_pages')
  })
})

describe('gen-pipeline：多账套', () => {
  it('accounts 生成 `<id>.<account>` 名字', () => {
    const m = mutate((x) => {
      delete x.account
      x.accounts = ['3120', '64188']
    })
    expect(validateManifest(m)).toEqual([])
    expect(pipelineNames(m as any)).toEqual(['pilot.demo.3120', 'pilot.demo.64188'])
    expect((buildPipeline(m as any, 'pilot.demo.64188') as any).name).toBe('pilot.demo.64188')
  })

  it('account 与 accounts 同给被拦', () => {
    const m = mutate((x) => {
      x.accounts = ['3120']
    })
    expect(validateManifest(m).join()).toContain('二选一')
  })

  it('accounts 重复被拦', () => {
    const m = mutate((x) => {
      delete x.account
      x.accounts = ['3120', '3120']
    })
    expect(validateManifest(m).join()).toContain('重复')
  })
})

describe('gen-pipeline：分页类型', () => {
  it('foreach 明确不支持（指向正典 §1.7 #44）', () => {
    const m = mutate((x) => {
      x.source.pagination = { type: 'foreach' }
    })
    expect(validateManifest(m).join()).toContain('static_pages')
  })
})
