// console/reports/index.tsx — 「报表」页签：本租户可见的报表清单 + 嵌入预览。
//
// 两条纪律落在这个文件里：
//  ① **不发 Metabase 凭据、不自己拼嵌入 URL**：iframe 的 src 只能来自平台的
//     `GET /reports/:id/embed-url`（服务端签的短期 JWT，locked.tenant = 调用者 org）。
//     前端拿不到 secret，也就没有「自己换租户」的面。
//  ② 只读：**不含建/改/删**——建报表是跨租户能力（`data:manage`），走 API/管线，
//     不在消费层第二次定义口径（同 console/metrics 的裁决理由）。
import { useEffect, useState } from 'react'
import { Button, Space, Table, Typography, message } from 'antd'
import { apiGet, messageOf } from '../lib/api'

interface ReportRow {
  id: string
  title: string
  requiredScope: string | null
}

export default function ReportsPage() {
  const [rows, setRows] = useState<ReportRow[]>([])
  const [embed, setEmbed] = useState<{ title: string; url: string } | null>(null)
  const [messageApi, ctx] = message.useMessage()

  const load = () => apiGet('/reports')
    .then((b) => setRows((b as { reports: ReportRow[] }).reports))
    .catch((e) => messageApi.error(messageOf(e)))
  useEffect(() => { void load() }, [])

  /** 打开 = 向平台换一次嵌入 URL（每次现签，10 分钟有效）。失败只提示，不留半开的面板。 */
  const open = async (r: ReportRow) => {
    try {
      const b = await apiGet(`/reports/${r.id}/embed-url`) as { url: string }
      setEmbed({ title: r.title, url: b.url })
    } catch (e) {
      messageApi.error(messageOf(e))
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: '报表标题', dataIndex: 'title' },
        { title: '所需 scope', dataIndex: 'requiredScope', render: (v: string | null) => v ?? '不限' },
        { title: '操作', render: (_: unknown, r: ReportRow) => (
            <Button size="small" onClick={() => void open(r)}>打开</Button>) },
      ]} />
      {embed !== null && (
        <div>
          <Typography.Text type="secondary">
            {embed.title}——嵌入预览（嵌入令牌 10 分钟有效，刷新页面即失效）
          </Typography.Text>
          {/* title 必填：无标题的 iframe 对读屏器是一块无名的空白 */}
          <iframe
            title={`报表嵌入预览：${embed.title}`}
            src={embed.url}
            style={{ width: '100%', height: 640, border: '1px solid #f0f0f0', marginTop: 8 }}
          />
        </div>
      )}
    </Space>
  )
}
