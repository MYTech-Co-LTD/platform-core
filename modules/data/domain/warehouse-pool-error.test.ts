import { afterEach, describe, expect, it, vi } from 'vitest'
import { analystPool, resetAnalystPool, resetWarehousePool, warehousePool } from './warehouse'

// #2484：pg 的 Pool 没有 'error' 监听时，空闲连接被断开 = 未捕获异常 = 进程退出。
// 仓库面尤其危险：pg_duckdb 后端崩溃 / 集群 reinit 都会断连接，整个 API 会跟着死。
const env = { DATA_WAREHOUSE_URL: 'postgres://nobody@127.0.0.1:1/none' }

describe('warehouse 池 · 连接级错误不得升级成进程崩溃（#2484）', () => {
  afterEach(() => {
    resetWarehousePool()
    resetAnalystPool()
    vi.restoreAllMocks()
  })

  it('★ 写池带 error 监听；emit 只留痕，不抛', () => {
    const pool = warehousePool(env)
    expect(pool.listenerCount('error')).toBeGreaterThan(0)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
    expect(spy.mock.calls.join('\n')).toContain('Connection terminated unexpectedly')
    return pool.end().catch(() => {})
  })

  it('★ 分析师只读池同样带 error 监听', () => {
    const pool = analystPool(env)
    expect(pool.listenerCount('error')).toBeGreaterThan(0)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => pool.emit('error', new Error('server closed the connection unexpectedly'))).not.toThrow()
    expect(spy.mock.calls.join('\n')).toContain('server closed the connection unexpectedly')
    return pool.end().catch(() => {})
  })
})
