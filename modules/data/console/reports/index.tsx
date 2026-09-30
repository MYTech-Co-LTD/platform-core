// console/reports/index.tsx — 「报表」页签：观看面（清单 + 嵌入预览）+ 管理面（data:manage）。
//
// 四条纪律落在这个文件里：
//  ① **不发 Metabase 凭据、不自己拼嵌入 URL**：iframe 的 src 只能来自平台的
//     `GET /reports/:id/embed-url`（服务端签的短期 JWT，locked.tenant = 调用者 org）。
//     前端拿不到 secret，也就没有「自己换租户」的面。
//  ② 管理动作（页门/发布/回收）只对 `data:manage` 身份出现（spec §3⑤ 管理面唯一）——
//     scope 判定读 Console 壳经 Outlet 注入的 session.scopes（demo 模块先例），这只是
//     **视图选择**；真正的授权由宿主门卫按 manifest 施加，前端不重复判权。
//     登记/改登记内容（标题、锁参）仍走 API/管线，不在消费层第二次定义口径。
//  ③ renderer='platform'（平台自绘）的行**没有 Metabase 嵌入通道**——「打开」走平台自绘渲染器
//     `<SpecView/>`（拉规格 + 逐面板 POST /query，Task 4），不碰 embed-url；服务端 embed-url
//     对该类行仍守卫（409 RENDERER_NOT_EMBEDDABLE），那条是陈旧视图/竞态的防御。
//  ④ **编辑入口**（#346 计划 3）：「编辑」换的是 `GET /reports/:id/edit-url` 给的**一次性 handoff
//     URL**（专用入口 origin，票据兑换与自有 Cookie 都在代理侧完成）——前端照旧**不碰 Metabase
//     凭据**。iframe 能直接打开是因为专用入口与 console **同父域**（反代的 SameSite=Lax Cookie
//     照发）。逐行按 renderer 给按钮（platform 行没有可编辑的 dashboard），同 ③ 一样只是视图选择。
//     ⚠️ 正因为票据**一次性**，「在新标签打开」兜底不能复用 iframe 那枚票，必须**重新领票**
//     （见 `edit` 的 opts.newTab）——否则兜底在最需要它的场景下必然 401。
import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { ApiError, apiGet, apiSend, messageOf } from '../lib/api'
import SpecView from './SpecView'

/** Console 壳 Outlet context 的结构子集（壳侧真实形状见 apps/web ConsoleOutletContext；demo 模块先例） */
interface ConsoleContext {
  session: { scopes: string[] }
}

interface ReportRow {
  id: string
  title: string
  requiredScope: string | null
  renderer: 'metabase' | 'platform'
  // **登记侧**版本（写保护的读侧）：`GET /reports/manage` 每行回带；三个写动作回带它
  // （PUT 走 body `expectedVersion`、DELETE 走查询串 `?expectedVersion=`）。服务端不服 ⇒ 409 STALE_WRITE。
  // ⚠️ 观看面 `GET /reports` **刻意不带**它（那里没有写动作）——本类型只服务管理面，故必填。
  // ⚠️ 本仓有**第二份**同名 `ReportRow`（`modules/data/domain/report-store.ts`，Task 1/3 已加 version）：
  //    两处不同文件、编译器不会互相提醒，加字段时都要改（Task 1 已知 minor）。
  version: number
}

export default function ReportsPage() {
  const { session } = useOutletContext<ConsoleContext>()
  const canManage = session.scopes.includes('data:manage')

  const [rows, setRows] = useState<ReportRow[]>([])
  const [embed, setEmbed] = useState<{ title: string; url: string } | null>(null)
  // platform 行的「打开」渲染 <SpecView/>（Task 4）：数据面在组件内自取（规格 + 逐面板 /query），
  // 这里只记「哪张报表」，关闭即清。
  const [selfDrawn, setSelfDrawn] = useState<{ title: string; id: string } | null>(null)
  const [editUrl, setEditUrl] = useState<{ title: string; url: string } | null>(null)
  // `editRow` 记住当前要编辑的那一行：兜底按钮要用它**重新领票**（票据一次性，见 JSX 注）。
  const [editRow, setEditRow] = useState<ReportRow | null>(null)
  const [gateEdit, setGateEdit] = useState<ReportRow | null>(null)
  const [gateDraft, setGateDraft] = useState('')
  const [messageApi, ctx] = message.useMessage()

  const load = () => {
    // 视图选择（不是鉴权）：manage 身份用管理清单（含页门未放行的行），观看清单不变
    const path = canManage ? '/reports/manage' : '/reports'
    return apiGet(path)
      .then((b) => {
        const reports = (b as { reports: ReportRow[] }).reports
        // ── fail-closed（评审 Minor ③，2026-09-29）────────────────────────────────
        // 无校验断言 `as ReportRow[]` 曾把「服务端漏带 version」静默成坏快照：写动作随后发出
        // `?expectedVersion=undefined`（PUT 则 body 里 undefined 被 JSON 丢掉 ⇒ 缺键）——服务端
        // 只回一句 400 `INVALID_BODY`「输入不合法」，**根因（清单契约破损）彻底静默**。
        // 这里提前拦：**坏快照不落地**（不 setRows ⇒ 表里没有行、也就没有能发出坏版本的写按钮），
        // 并把「缺版本」这件事明说。只在管理清单上判——观看清单 `GET /reports` **刻意不带** version
        // （那里没有写动作），对它判会把正常观看视图误判成坏数据。
        if (canManage && !reports.every((r) => Number.isInteger(r.version) && r.version > 0)) {
          // 客户端侧错误（非 HTTP 响应）⇒ status 传 0；`messageOf` 只认 `code`。
          throw new ApiError(0, 'SNAPSHOT_INVALID')
        }
        setRows(reports)
      })
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
   *
   * `opts.newTab` = 兜底通路：**重新领一张票**（票据一次性，理由见面板按钮上的订正记录），
   * 在新标签里用掉；此时不设 `editUrl`，因为 iframe 里那枚票已被消费、不该被覆盖。
   * ⚠️ 这条通路**必须同步预开窗**，且**不能带 `noopener`**——两条都在函数体内详注。
   */
  const edit = async (r: ReportRow, opts?: { newTab?: boolean }) => {
    // ⚠️ 订正记录（2026-09-29，Task 5 终审修复轮 I-5）：**同步**预开一个空白标签页——浏览器只认
    //    **同步点击上下文**里的 `window.open`，`await` 之后再开会被判成弹窗直接拦掉，用户看到的是
    //    「点了没反应」；而「CSP 挡住 iframe」正是**唯一**需要这条兜底的场景 ⇒ 那条路不能靠运气。
    // ⚠️ 这里**不带 `noopener`/`noreferrer`**（计划原稿带了，实测**不可用**）：按规范，带 `noopener`
    //    时 `window.open` **恒返回 `null`**（MDN `window.open` 的 `noopener` 条目：「…and returns
    //    `null`」；真机 Chromium 实测同结论——带它 `pre` 恒 null）⇒ 下面的 `pre.location.replace`
    //    永远够不到，兜底会退化成「每次只弹一句『被拦下了』」。
    //    等价改法：同步开窗后**立刻**断掉 `opener`（真机实测可赋值）——同样让新页拿不到
    //    `window.opener`，反制 tab-nabbing 的效果与 `noopener` 一致；导航仍然由我们完成。
    const pre = opts?.newTab === true ? window.open('about:blank', '_blank') : null
    if (pre !== null) pre.opener = null
    try {
      const b = await apiGet(`/reports/${r.id}/edit-url`) as { url: string }
      setEditRow(r)
      if (opts?.newTab === true) {
        // 开不出来（弹窗被拦，或用户已把那个空白页关掉）⇒ 明说，别让人以为「点了没反应」
        if (pre === null || pre.closed) {
          messageApi.warning('浏览器拦下了新标签页，请允许本站弹窗后重试')
          return
        }
        pre.location.replace(b.url)   // 兜底：新票在**已开好的**那个标签页里用掉
        return
      }
      setEditUrl({ title: r.title, url: b.url })
    } catch (e) {
      pre?.close()          // 失败时别把空白标签留在用户眼前
      messageApi.error(messageOf(e))
    }
  }

  // ── 三个写动作的共同纪律（写保护，spec §3③）─────────────────────────────────────
  // ① **必带该行读到的版本**：服务端 fail-closed（PUT 缺 `expectedVersion` ⇒ 400 INVALID_BODY；
  //    DELETE 缺/非法 `?expectedVersion=` ⇒ 400）。版本一律取**本行** `r.version`（管理清单读回），
  //    不是页面级缓存、更不是常量——取错行的版本会被 409 拦下（这正是写保护要的）。
  // ② **catch 里总是 `await load()`**：409（STALE_WRITE = 别人刚改过）之后列表必须刷新，
  //    否则用户拿着陈旧版本重试必然再撞一次；文案「已为你刷新」也因此为真。
  const publish = async (r: ReportRow) => {
    try {
      await apiSend(`/reports/${r.id}`, 'PUT', { requiredScope: null, expectedVersion: r.version })
      messageApi.success(`已发布「${r.title}」`)
    } catch (e) {
      messageApi.error(messageOf(e))
    }
    await load()
  }

  const recycle = async (r: ReportRow) => {
    try {
      // ⚠️ DELETE **无 body**：版本走**查询串**（`?expectedVersion=N`，Task 3 硬约束）
      await apiSend(`/reports/${r.id}?expectedVersion=${r.version}`, 'DELETE')
      messageApi.success(`已回收「${r.title}」`)
    } catch (e) {
      messageApi.error(messageOf(e))
    }
    await load()
  }

  const saveGate = async () => {
    if (gateEdit === null || gateDraft.trim() === '') return
    try {
      await apiSend(`/reports/${gateEdit.id}`, 'PUT', {
        requiredScope: gateDraft.trim(),
        expectedVersion: gateEdit.version,
      })
      messageApi.success('页门已更新')
      setGateEdit(null)
    } catch (e) {
      messageApi.error(messageOf(e))
      // ⚠️ 冲突（409 STALE_WRITE）必须**同时关掉 Modal**（评审 I-2，2026-09-29）：`gateEdit` 是
      //    **加载时**的行快照，`load()` 刷新的是 `rows`、刷不到它。若不关框，用户照着「请重试」
      //    在框内再点「确定」⇒ 再发一次**陈旧** `gateEdit.version` ⇒ 再一个 409（看起来像坏掉了）。
      //    关框 = **收口重试入口**：重试只能从刷新后的列表重新进入，那时拿到的才是新版本。
      //    只对 409 关：其余错（403/404/5xx/网络）关框会**丢掉用户刚敲的 scope**，反而更差。
      if (e instanceof ApiError && e.status === 409) setGateEdit(null)
    }
    await load()
  }

  /**
   * 「打开」的可用性 = **页门**这一个体验层判据（与观看面的 `visibleTo` 同构）。
   *
   * ⚠️ 页门这一维是本分支新打通的路径：管理清单按 spec **不裁行**（管理员必须看得见、能改页门），
   * 于是一个「门是自己没有的 scope」的行会出现在表里——它的 `embed-url` **和** `GET /spec`
   * 服务端都必然 403（改前 console 只渲染裁过的清单，这条路不可达）。这里把「按了必然失败」
   * 前置成不可按——**两条渲染路（embed-url / 自绘 spec）判的是同一道门**。
   *
   * ⚠️ 订正记录（2026-09-30，Task 4）：renderer='platform' 不再是置灰理由——自绘渲染通路
   * （`<SpecView/>`）已接入，「打开」对 platform 行改为打开自绘视图。
   *
   * **服务端仍是权威**：本函数只是视图层的前置体验，不是鉴权（前端不重复判权，见文件头②）。
   */
  const canOpen = (r: ReportRow) =>
    r.requiredScope === null || session.scopes.includes(r.requiredScope)

  const openBtn = (r: ReportRow) =>
    !canOpen(r) ? (
      // ⚠️ antd 6.6.3 已移除 v5 的 `getDisabledCompatibleChildren` ⇒ Tooltip 在禁用的原生 button
      // 上不保证弹；表格里的「页门」列是兜底说明（恒在，不依赖悬停），Tooltip 是锦上添花。
      <Tooltip title={`你的账号没有这张报表的页门权限（${r.requiredScope}）`}>
        <Button size="small" disabled>打开</Button>
      </Tooltip>
    ) : r.renderer === 'platform' ? (
      // platform 行：打开自绘视图（Tooltip 说明这条「打开」与 Metabase 嵌入预览不是一回事）
      <Tooltip title="打开自绘视图">
        <Button size="small" onClick={() => setSelfDrawn({ title: r.title, id: r.id })}>打开</Button>
      </Tooltip>
    ) : (
      // metabase 行：既有行为一字不动（embed-url 那条路，见 open）
      <Button size="small" onClick={() => void open(r)}>打开</Button>
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
      {/* platform 行的「打开」面板（Task 4）：标题栏与关闭按钮由 SpecView 自带；
          数据面（GET /spec + 逐面板 POST /query）全在组件内——本页不替它转发任何请求。 */}
      {selfDrawn !== null && (
        <SpecView reportId={selfDrawn.id} title={selfDrawn.title} onClose={() => setSelfDrawn(null)} />
      )}
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
      {/* 收窄 `editRow`（**不用 `editRow!`**，见下条订正记录）——面板与兜底按钮同属这个分支 */}
      {editUrl !== null && editRow !== null && (
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
          {/* ⚠️ 订正记录（2026-09-29，Task 5 评审轮）：**兜底不能复用同一枚票据**——票据是
              一次性（nonce 在 `/handoff` 即被消费），iframe 一渲染它就用掉了；若兜底链接的 href 也指向
              它，点开必然 401，而「CSP 挡住 iframe」那种**最需要兜底**的场景下票据同样已被消费 ⇒
              兜底路径整体失效。改为**重新领取**：再打一次 `edit-url` 换一枚新票，在新标签打开。 */}
          {/* ⚠️ 订正记录（2026-09-29，Task 5 修复轮）：这个按钮必须在 `editRow !== null` 的分支里——
              否则 `editRow: ReportRow | null` 传给 `edit(r: ReportRow, …)` 是 TS2345（实测复现）。
              外层条件写成 `editUrl !== null && editRow !== null &&` 即**自然收窄**；
              **不要**图省事写 `editRow!`（非空断言是类型逃逸，收窄才是正解）。 */}
          <Button size="small" onClick={() => void edit(editRow, { newTab: true })}>在新标签打开</Button>
        </div>
      )}
    </Space>
  )
}
