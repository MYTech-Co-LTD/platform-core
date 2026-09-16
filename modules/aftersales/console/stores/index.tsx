// stores/index.tsx — 门店档案（只读起步，spec §3.1）。
//
// `GET /stores` 回 `{ items }` **无 total**（服务端另有 `MAX_STORES` 上限）⇒ 单页展示、
// **不放分页控件**（spec §3.1 已知边界：不摆一个假的页码）。
import { useCallback } from 'react'
import { Alert, Table } from 'antd'
import { apiGet } from '../lib/api'
import { useList } from '../lib/useList'
import type { StoreItem, Unpaged } from '../../api-types'

export default function StoresPage() {
  const load = useCallback(async () => (await apiGet<Unpaged<StoreItem>>('/stores')).items, [])
  const { items, loading, error } = useList(load)

  return (
    <div>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<StoreItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={false}
        columns={[
          { title: '门店', dataIndex: 'name' },
          { title: '地址', dataIndex: 'address' },
          { title: '电话', dataIndex: 'phone', width: 160 },
        ]}
      />
    </div>
  )
}
