// products/index.tsx — 商品档案（只读起步，spec §3.1）。
//
// `GET /products` 回 `{ items, total, page, size }` ⇒ **可以真分页**（#155 起 /stores 等
// 三端点同形；本页是分页口径的原点）。价格是服务端给的整数分，这里只做展示格式化、不做任何推导。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Table, Typography } from 'antd'
import { apiGet, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import type { Paged, ProductItem } from '../../api-types'

const SIZE = 20

export default function ProductsPage() {
  const [items, setItems] = useState<ProductItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await apiGet<Paged<ProductItem>>(`/products?page=${page}&size=${SIZE}`)
      setItems(body.items)
      setTotal(body.total)
    } catch (e: unknown) {
      setItems([])
      setTotal(0)
      setError(messageOf(e))
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div>
      <Typography.Text type="secondary">共 {total} 条</Typography.Text>
      {error ? <Alert type="error" showIcon title={error} style={{ margin: '12px 0' }} /> : null}
      <Table<ProductItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={{ current: page, pageSize: SIZE, total, showSizeChanger: false, onChange: setPage }}
        columns={[
          { title: '商品', dataIndex: 'name' },
          { title: '规格', dataIndex: 'spec', width: 160, render: (v: string | null) => v ?? '—' },
          { title: '基础数量', dataIndex: 'basicQuantity', width: 100 },
          {
            title: '基础单价',
            dataIndex: 'basicUnitPriceMinor',
            width: 140,
            render: (v: number) => formatMinor(v),
          },
        ]}
      />
    </div>
  )
}
