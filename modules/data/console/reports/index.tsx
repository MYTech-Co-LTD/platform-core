// console/reports/index.tsx — 「报表」页签：观看面（清单 + 嵌入预览）+ 管理面（data:manage）。
//
// 三条纪律落在这个文件里：
//  ① **不发 Metabase 凭据、不自己拼嵌入 URL**：iframe 的 src 只能来自平台的
//     `GET /reports/:id/embed-url`（服务端签的短期 JWT，locked.tenant = 调用者 org）。
//     前端拿不到 secret，也就没有「自己换租户」的面。
//  ② 管理动作（页门/发布/回收）只对 `data:manage` 身份出现（spec §3⑤ 管理面唯一）——
//     scope 判定读 Console 壳经 Outlet 注入的 session.scopes（demo 模块先例），这只是
//     **视图选择**；真正的授权由宿主门卫按 manifest 施加，前端不重复判权。
//     登记/改登记内容（标题、锁参）仍走 API/管线，不在消费层第二次定义口径。
//  ③ renderer='platform'（平台自绘）的行**没有 Metabase 嵌入通道**——「打开」置灰；
//     服务端 embed-url 同样守卫（409 RENDERER_NOT_EMBEDDABLE），这里是前置体验。
import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'

/** Console 壳 Outlet context 的结构子集（壳侧真实形状见 apps/web ConsoleOutletContext；demo 模块先例） */
interface ConsoleContext {
  session: { scopes: string[] }
}

interface ReportRow {
  id: string
  title: string
  requiredScope: string | null
  renderer: 'metabase' | 'platform'
}

export default function ReportsPage() {
  const { session } = useOutletContext<ConsoleContext>()
  const canManage = session.scopes.includes('data:manage')

  const [rows, setRows] = useState<ReportRow[]>([])
  const [embed, setEmbed] = useState<{ title: string; url: string } | null>(null)
  const [gateEdit, setGateEdit] = useState<ReportRow | null>(null)
  const [gateDraft, setGateDraft] = useState('')
  const [messageApi, ctx] = message.useMessage()

  const load = () => {
    // 视图选择（不是鉴权）：manage 身份用管理清单（含页门未放行的行），观看清单不变
    const path = canManage ? '/reports/manage' : '/reports'
    return apiGet(path)
      .then((b) => setRows((b as { reports: ReportRow[] }).reports))
      .catch((e) => messageApi.error(messageOf(e)))
  }
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

  const publish = async (r: ReportRow) => {
    try {
      await apiSend(`/reports/${r.id}`, 'PUT', { requiredScope: null })
      messageApi.success(`已发布「${r.title}」`)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  const recycle = async (r: ReportRow) => {
    try {
      await apiSend(`/reports/${r.id}`, 'DELETE')
      messageApi.success(`已回收「${r.title}」`)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  const saveGate = async () => {
    if (gateEdit === null || gateDraft.trim() === '') return
    try {
      await apiSend(`/reports/${gateEdit.id}`, 'PUT', { requiredScope: gateDraft.trim() })
      messageApi.success('页门已更新')
      setGateEdit(null)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  const openBtn = (r: ReportRow) =>
    r.renderer === 'platform' ? (
      <Tooltip title="平台自绘报表暂无嵌入预览通道（渲染通路接入后开放）">
        <Button size="small" disabled>打开</Button>
      </Tooltip>
    ) : (
      <Button size="small" onClick={() => void open(r)}>打开</Button>
    )

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: '报表标题', dataIndex: 'title' },
        ...(canManage ? [{
          title: '渲染器', dataIndex: 'renderer',
          render: (v: ReportRow['renderer']) => (v === 'platform' ? <Tag color="purple">平台自绘</Tag> : <Tag>Metabase</Tag>),
        }] : []),
        { title: '页门', dataIndex: 'requiredScope', render: (v: string | null) => v ?? '不限' },
        {
          title: '操作', render: (_: unknown, r: ReportRow) => (
            <Space size="small">
              {openBtn(r)}
              {canManage && (
                <>
                  <Button size="small" onClick={() => { setGateEdit(r); setGateDraft(r.requiredScope ?? '') }}>
                    改页门
                  </Button>
                  {r.requiredScope !== null && (
                    // okText/cancelText 显式写中文：Popconfirm 的默认 okText 取 **locale**
                    // （未配 zh_CN 时是 "OK"）——发布是对全租户可见的动作，确认按钮上的字
                    // 应当自己掌握，不随宿主是否配了 locale 漂（同 console/metrics 的裁决）。
                    <Popconfirm title={`发布后所有拿到本模块的人都能看到「${r.title}」，确定？`}
                                okText="确认发布" cancelText="取消"
                                onConfirm={() => void publish(r)}>
                      <Button size="small">发布</Button>
                    </Popconfirm>
                  )}
                  <Popconfirm title={`回收会删除「${r.title}」及其报表本体，确定？`}
                              okText="确认回收" cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => void recycle(r)}>
                    <Button size="small" danger>回收</Button>
                  </Popconfirm>
                </>
              )}
            </Space>
          ),
        },
      ]} />
      <Modal title={`改页门：${gateEdit?.title ?? ''}`}
             open={gateEdit !== null}
             okText="确定" cancelText="取消"
             onOk={() => void saveGate()}
             okButtonProps={{ disabled: gateDraft.trim() === '' }}
             onCancel={() => setGateEdit(null)}>
        <Typography.Paragraph type="secondary">
          页门 = 持有该 scope 才能在清单和嵌入里看到这张报表；发布（清空页门）用上方「发布」。
        </Typography.Paragraph>
        <Input value={gateDraft} onChange={(e) => setGateDraft(e.target.value)} placeholder="如 sales:read" />
      </Modal>
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
