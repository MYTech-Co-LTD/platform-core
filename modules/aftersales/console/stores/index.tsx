// stores/index.tsx — 门店档案（只读起步，spec §3.1）。
//
// `GET /stores` 已回 `{items,total,page,size}`（#155，与 /products 同形）⇒ **可真分页**；
// 但 console 分页重构不在 #155 ⇒ 本页仍单页展示、**不放分页控件**（不摆假页码）。
import { useCallback } from 'react'
import { Alert, Table } from 'antd'
import { apiGet } from '../lib/api'
import { useList } from '../lib/useList'
import { ListCard } from '../lib/ui'
import type { Paged, StoreItem } from '../../api-types'

export default function StoresPage() {
  const load = useCallback(async () => (await apiGet<Paged<StoreItem>>('/stores')).items, [])
  const { items, loading, error } = useList(load)

  return (
    <ListCard>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Table<StoreItem>
        rowKey="id"
        size="small"
        dataSource={items}
        loading={loading}
        pagination={false}
        locale={{ emptyText: '还没有门店档案。数据面的门店维表发布后会出现在这里。' }}
        columns={[
          { title: '门店', dataIndex: 'name' },
          { title: '地址', dataIndex: 'address' },
          { title: '电话', dataIndex: 'phone', width: 160 },
        ]}
      />
    </ListCard>
  )
}
