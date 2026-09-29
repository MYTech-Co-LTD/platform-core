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
//  ④ **编辑入口**（#346 计划 3）：「编辑」换的是 `GET /reports/:id/edit-url` 给的**一次性 handoff
//     URL**（专用入口 origin，票据兑换与自有 Cookie 都在代理侧完成）——前端照旧**不碰 Metabase
//     凭据**。iframe 能直接打开是因为专用入口与 console **同父域**（反代的 SameSite=Lax Cookie
//     照发）。逐行按 renderer 给按钮（platform 行没有可编辑的 dashboard），同 ③ 一样只是视图选择。
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
  const [editUrl, setEditUrl] = useState<{ title: string; url: string } | null>(null)
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

  /**
   * 编辑 = 向平台换一次**专用入口**的 handoff URL（Task 1 的 `GET /reports/:id/edit-url`）。
   *
   * 与「打开」同一条纪律：URL 只能来自平台，前端拿不到任何 Metabase 凭据。
   * handoff URL 一次性 + 短时票据，代理侧兑换成自有 host-only Cookie；面板用 iframe 打开
   * 是因为专用入口与 console **同父域**（反代的 SameSite=Lax Cookie 照发）。失败只提示，
   * 不留半开的面板（与 open 同款）。
   */
  const edit = async (r: ReportRow) => {
    try {
      const b = await apiGet(`/reports/${r.id}/edit-url`) as { url: string }
      setEditUrl({ title: r.title, url: b.url })
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

  /**
   * 「打开」的可用性 = **渲染器 + 页门**两个体验层判据（与观看面的 `visibleTo` 同构）。
   *
   * ⚠️ 页门这一维是本分支新打通的路径：管理清单按 spec **不裁行**（管理员必须看得见、能改页门），
   * 于是一个「门是自己没有的 scope」的行会出现在表里——它的 `embed-url` 服务端必然 **403**
   * （改前 console 只渲染裁过的清单，这条路不可达）。这里把「按了必然失败」前置成不可按。
   *
   * **服务端仍是权威**：本函数只是视图层的前置体验，不是鉴权（前端不重复判权，见文件头②）。
   */
  const canOpen = (r: ReportRow) =>
    r.renderer !== 'platform' && (r.requiredScope === null || session.scopes.includes(r.requiredScope))

  /**
   * 置灰的**原因**（Tooltip 文案）：平台自绘与页门不足是两件完全不同的事，用户该做的动作也不同。
   *
   * ⚠️ antd 6.6.3 已移除 v5 的 `getDisabledCompatibleChildren` ⇒ **Tooltip 在禁用的原生 button 上
   * 不保证弹**。所以表格里的「页门」列是**兜底说明**（它恒在，不依赖悬停）；Tooltip 是锦上添花。
   */
  const openBlockReason = (r: ReportRow): string =>
    r.renderer === 'platform'
      ? '平台自绘报表暂无嵌入预览通道（渲染通路接入后开放）'
      : `你的账号没有这张报表的页门权限（${r.requiredScope}）`

  const openBtn = (r: ReportRow) =>
    canOpen(r) ? (
      <Button size="small" onClick={() => void open(r)}>打开</Button>
    ) : (
      <Tooltip title={openBlockReason(r)}>
        <Button size="small" disabled>打开</Button>
      </Tooltip>
    )

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        // ⚠️ 订正记录（2026-09-29，Task 5 评审 spec ❌ + 人裁「两视图都加」）：徽章必须内联在**标题**里
        //    ——原稿把它只放在管理视图的条件列里，观看视图就只剩一个置灰按钮；而本仓 antd 6.6.3 已移除
        //    v5 的 `getDisabledCompatibleChildren`，**Tooltip 在禁用按钮上不保证弹**，普通员工会看到
        //    一个没有理由的灰按钮。徽章自己承担「为什么这行点不开」。管理视图另留一列「渲染器」便于扫读。
        {
          title: '报表标题', dataIndex: 'title',
          render: (v: string, r: ReportRow) => (
            <Space size={4}>
              {v}
              {r.renderer === 'platform' && <Tag color="purple">平台自绘</Tag>}
            </Space>
          ),
        },
        ...(canManage ? [{
          title: '渲染器', dataIndex: 'renderer',
          render: (v: ReportRow['renderer']) => (v === 'platform' ? <Tag color="purple">平台自绘</Tag> : <Tag>Metabase</Tag>),
        }] : []),
        { title: '页门', dataIndex: 'requiredScope', render: (v: string | null) => v ?? '不限' },
        {
          title: '操作', render: (_: unknown, r: ReportRow) => (
            <Space size="small">
              {openBtn(r)}
              {/* 「编辑」与「打开」是**两条不同通路**：打开 = 嵌入预览（embed-url，只读令牌）；
                  编辑 = 专用入口反代会话（edit-url，可写）。平台自绘行没有 Metabase dashboard 可编辑，
                  故按 renderer 逐行给按钮（服务端同守卫：409 RENDERER_NOT_EDITABLE）。 */}
              {canManage && r.renderer === 'metabase' && (
                <Button size="small" onClick={() => void edit(r)}>编辑</Button>
              )}
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
      {editUrl !== null && (
        <div>
          <Typography.Text type="secondary">
            {editUrl.title}——编辑页（专用入口；会话 8 小时有效，关闭后需从列表重新进入）
          </Typography.Text>
          {/* 同父域 ⇒ iframe 内仍是同站，反代的 SameSite=Lax Cookie 照发 */}
          <iframe
            title={`报表编辑：${editUrl.title}`}
            src={editUrl.url}
            style={{ width: '100%', height: 720, border: '1px solid #f0f0f0', marginTop: 8 }}
          />
          <Button size="small" href={editUrl.url} target="_blank" rel="noreferrer">在新标签打开</Button>
        </div>
      )}
    </Space>
  )
}
