// branches.ts — GET /branches：门店维读面（#1047 报表页筛选器的下拉数据源）。
//
// 只读 + 部署级：走 analystPool（强制 read-only 会话，与分析师面同一份连接纪律）；
// 测试经 RouteCtx.execute 注入假执行器（mcp-rpc.ts 的 wh 同款）。
// stg_lemeng_branch 是**快照型** staging（batch_id 维度，同店多批）⇒ distinct 去重出
// (branch_num, name)；名称跨批次稳定，无「取最新批」的必要（2026-10-26 湖侧实测 7680 行/3120）。
import type { ModuleHono, RouteCtx } from './context'
import { analystPool, runWarehouseSql } from '../domain/warehouse'

// 字符白名单（不是转义）：system_book 只会拼进 SQL 字面量，白名单外的值在入口就 400。
const SYSTEM_BOOK_RE = /^[0-9A-Za-z_]+$/

export function registerBranches(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/branches', async (c) => {
    const systemBook = c.req.query('system_book') ?? ''
    if (!SYSTEM_BOOK_RE.test(systemBook)) {
      return c.json({ error: 'INVALID_SYSTEM_BOOK' }, 400)
    }
    const exec = ctx.execute ?? ((sql: string) => runWarehouseSql(analystPool(), sql))
    const { columns, rows } = await exec(
      `select distinct system_book, branch_num, name from stg_lemeng_branch` +
        ` where system_book = '${systemBook}' order by branch_num`,
    )
    const i = (k: string) => columns.indexOf(k)
    const branches = rows.map((row) => ({
      systemBook: String(row[i('system_book')]),
      branchNum: String(row[i('branch_num')]),
      name: String(row[i('name')]),
    }))
    return c.json({ branches })
  })
}
