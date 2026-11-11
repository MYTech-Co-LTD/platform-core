import { describe, expect, it } from 'vitest'
import { warehousePoolConfig } from './warehouse'

describe('warehousePoolConfig（连接与内存预算，#1951）', () => {
  it('默认：每池 3 连接、30s 语句超时、10s 建连超时', () => {
    expect(warehousePoolConfig({})).toEqual({
      max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, statement_timeout: 30_000,
    })
  })

  it('env 覆盖生效', () => {
    expect(warehousePoolConfig({
      DATA_WAREHOUSE_POOL_MAX: '2',
      DATA_WAREHOUSE_IDLE_MS: '5000',
      DATA_WAREHOUSE_CONNECT_MS: '3000',
      DATA_QUERY_TIMEOUT_MS: '60000',
    })).toEqual({ max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 3000, statement_timeout: 60000 })
  })

  it('非法值回落默认（配置错误不该让进程起不来）', () => {
    expect(warehousePoolConfig({ DATA_WAREHOUSE_POOL_MAX: '0' }).max).toBe(3)
    expect(warehousePoolConfig({ DATA_WAREHOUSE_POOL_MAX: 'abc' }).max).toBe(3)
    expect(warehousePoolConfig({ DATA_QUERY_TIMEOUT_MS: '-1' }).statement_timeout).toBe(30_000)
  })
})
