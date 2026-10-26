// branches.test.ts — GET /branches 路由层测试（#1047 报表页筛选器数据源）。
// 模块壳（buildTestApp）不挂宿主门卫与三通道中间件；这里验：入参白名单拒、
// SQL 拼装（字面量 + distinct）、形状投影（camelCase）。执行器全程注入，不碰真仓库。
import { describe, expect, it, vi } from 'vitest'
import mod from '../index'
import { buildTestApp, makeIdentity } from '../test-util'
import type { SqlExecutor } from '../domain/query-service'

const identity = makeIdentity({ orgId: 'org-branches' })

function appWith(exec: SqlExecutor) {
  // execute 用**变量**携带（与 query.test.ts 同款）：绕开 ModuleContext 字面量的多余属性检查。
  const ctx = { pool: null as never, execute: exec }
  return buildTestApp(mod, identity, ctx)
}

const BRANCHES_RESULT = {
  columns: ['system_book', 'branch_num', 'name'],
  rows: [
    ['3120', '91', '熊喵曲靖沾益1店'],
    ['3120', '92', '熊喵曲靖沾益2店'],
  ],
}

describe('GET /branches（报表筛选器的门店维读面）', () => {
  it('白名单外 system_book ⇒ 400（quote/空格/空串都进不来，入口拒而非转义兜）', async () => {
    const exec = vi.fn()
    const app = appWith(exec)
    for (const bad of ["3120' OR 1=1", '3120;drop', '']) {
      const res = await app.request('/branches?system_book=' + encodeURIComponent(bad))
      expect(res.status, `system_book=${JSON.stringify(bad)}`).toBe(400)
    }
    expect(exec, '被拒请求不该碰仓库').not.toHaveBeenCalled()
  })

  it('200：distinct 去重 SQL + camelCase 投影', async () => {
    const exec = vi.fn().mockResolvedValue(BRANCHES_RESULT)
    const res = await appWith(exec).request('/branches?system_book=3120')
    expect(res.status).toBe(200)
    // SQL 拼装判据：字面量（白名单值直接进）+ distinct（快照表去重）都在
    const sql = exec.mock.calls[0][0] as string
    expect(sql).toContain("system_book = '3120'")
    expect(sql).toContain('distinct')
    const body = (await res.json()) as { branches: Array<{ branchNum: string; name: string }> }
    expect(body.branches).toEqual([
      { branchNum: '91', name: '熊喵曲靖沾益1店', systemBook: '3120' },
      { branchNum: '92', name: '熊喵曲靖沾益2店', systemBook: '3120' },
    ])
  })

  it('仓库报错 ⇒ 500 冒泡（不静默空集：下拉空了要让人看见，不是「没门店」）', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('warehouse down'))
    const res = await appWith(exec).request('/branches?system_book=3120')
    expect(res.status).toBe(500)
  })
})
