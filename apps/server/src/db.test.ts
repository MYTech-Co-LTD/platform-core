import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPool } from './db'

// #2484：pg 的 Pool 没有 'error' 监听时，空闲连接被断开 = 未捕获异常 = 进程退出。
// 这里钉的是**兜底存在**：池必须有 error 监听，且该监听只留痕、不抛。
describe('getPool · 连接级错误不得升级成进程崩溃（#2484）', () => {
  afterEach(() => vi.restoreAllMocks())

  it('★ 池带 error 监听；emit 一条连接断开只留痕，不抛', () => {
    const pool = getPool({ databaseUrl: 'postgres://nobody@127.0.0.1:1/none' })
    expect(pool.listenerCount('error')).toBeGreaterThan(0)

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
    expect(spy.mock.calls.join('\n')).toContain('Connection terminated unexpectedly')

    return pool.end().catch(() => {})
  })

  it('同一 URL 复用同一个池（不因重复调用丢监听）', () => {
    const cfg = { databaseUrl: 'postgres://nobody@127.0.0.1:1/none2' }
    const a = getPool(cfg)
    const b = getPool(cfg)
    expect(a).toBe(b)
    expect(b.listenerCount('error')).toBeGreaterThan(0)
    return a.end().catch(() => {})
  })
})
