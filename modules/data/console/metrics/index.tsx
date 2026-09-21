// console/metrics/index.tsx — 指标管理：**只读列表 + 下线**。
// 不含新增/编辑——两条硬约束排除了 UI 手搓指标定义这条路（详见模块 docs / brief 注记）：
// ① MetricBody 的 subjectColumn 与 selectSql 都是 min(1) 必填，简表单必然 400 INVALID_BODY；
// ② 口径只定义一次（分层设计）：指标定义随管线走代码评审，console 提供 SQL 输入框
//   = 在消费层第二次定义口径；且本计划没有校验 subjectColumn 真在数仓表存在的机制，
//   UI 写入的坏定义会**静默返回错数据**。写入路径走 POST/PUT /metrics（data:manage，管线/运维用）。
import { useEffect, useState } from 'react'
import { Button, Space, Table, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'

interface MetricRow {
  id: string
  title: string
  description: string
  requiredScope: string | null
  subjectColumn: string
}

export default function MetricsPage() {
  const [rows, setRows] = useState<MetricRow[]>([])
  const [messageApi, ctx] = message.useMessage()

  const load = () => apiGet('/metrics/all')
    .then((b) => setRows((b as { metrics: MetricRow[] }).metrics))
    .catch((e) => messageApi.error(messageOf(e)))
  useEffect(() => { void load() }, [])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: 'id', dataIndex: 'id' }, { title: '标题', dataIndex: 'title' },
        { title: '说明', dataIndex: 'description' },
        { title: '所需 scope', dataIndex: 'requiredScope', render: (v: string | null) => v ?? '不限' },
        // 主体列**显示出来**（只读）：它是主体钉死的依据，管理员必须能一眼看出这个指标按哪列隔离。
        { title: '主体列', dataIndex: 'subjectColumn' },
        { title: '操作', render: (_: unknown, r: MetricRow) => (
            <Button danger size="small"
                    onClick={async () => {
                      try { await apiSend(`/metrics/${r.id}`, 'DELETE'); await load() }
                      catch (e) { messageApi.error(messageOf(e)) }
                    }}>删除</Button>) },
      ]} />
    </Space>
  )
}
