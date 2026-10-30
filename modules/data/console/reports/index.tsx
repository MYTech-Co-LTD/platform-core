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
//  ⑤ **版本通路只属于 renderer='platform' 行**（月报重做 Task 12；设计 §6.4）：「发布/下线/版本/
//     独立链接」走 `/reports/:id/publish|unpublish|versions`，而 Metabase 行的「发布」仍旧是
//     **清页门**（PUT `/reports/:id`）——两条同名动作语义不同，一律按 renderer 分流，互不影响。
//     平台行的「改页门」入口下线（页门由发布时从面板派生；手改会与版本快照不一致，服务端
//     `PUT` 对 platform 行回 409 `USE_PUBLISH_ENDPOINT`）。
import { useEffect, useRef, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { Button, Drawer, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip, Tree, Typography, message } from 'antd'
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
  /**
   * 部门门（spec 2026-10-30 §3.4）：ext_id 数组，**子树继承**（配父部门 ⇒ 子部门成员也可见）。
   * `null` / 空 = 无部门门。观看清单与管理清单都回带；改门走 `PUT /reports/:id/dept-gate`。
   */
  requiredDepts?: string[] | null
  renderer: 'metabase' | 'platform'
  // **登记侧**版本（写保护的读侧）：`GET /reports/manage` 每行回带；三个写动作回带它
  // （PUT 走 body `expectedVersion`、DELETE 走查询串 `?expectedVersion=`）。服务端不服 ⇒ 409 STALE_WRITE。
  // ⚠️ 观看面 `GET /reports` **刻意不带**它（那里没有写动作）——本类型只服务管理面，故必填。
  // ⚠️ 本仓有**第二份**同名 `ReportRow`（`modules/data/domain/report-store.ts`，Task 1/3 已加 version）：
  //    两处不同文件、编译器不会互相提醒，加字段时都要改（Task 1 已知 minor）。
  version: number
  // ── 版本徽标（月报重做 Task 12；设计 §8.2）─────────────────────────────────────
  // 只有 `GET /reports/manage` 回带（观看清单刻意不带）；版本通路也只属于 platform 行。
  // `publishedVersion = null` = 未发布/已下线；`hasUnpublishedChanges` = 指针存在且草稿改过。
  publishedVersion: number | null
  hasUnpublishedChanges: boolean
}

/** `GET /reports/dept-options` 的一行：活节点平表（前端按 `parentExtId` 组树）。 */
interface DeptOption {
  extId: string
  name: string
  parentExtId: string | null
  memberCount: number
}

/** `GET /reports/:id/versions` 的一行（列表只给元数据，正文快照走 `/versions/:version`）。 */
interface VersionRow {
  version: number
  title: string
  publishedAt: string
  publishedBy: string
  note: string
  draftVersion: number
  isCurrent: boolean
}

export default function ReportsPage() {
  const { session } = useOutletContext<ConsoleContext>()
  const canManage = session.scopes.includes('data:manage')

  const [rows, setRows] = useState<ReportRow[]>([])
  // 请求者自己的部门闭包（`GET /reports/manage` 回带；本人部门 + 全部祖先）。只用来判
  // 「打开」按钮的可用性——真正的授权在服务端（前端不重复判权，见文件头②）。
  // `null` = **不知道**（观看清单不带这个键）：那时**不判部门门**——那里的行已经被服务端裁过，
  // 拿未知当「空集」会把看得见的行误置灰。
  const [myDepts, setMyDepts] = useState<string[] | null>(null)
  const [embed, setEmbed] = useState<{ title: string; url: string } | null>(null)
  // platform 行的「打开」渲染 <SpecView/>（Task 4）：数据面在组件内自取（规格 + 逐面板 /query），
  // 这里只记「哪张报表」，关闭即清。
  const [selfDrawn, setSelfDrawn] = useState<{ title: string; id: string } | null>(null)
  const [editUrl, setEditUrl] = useState<{ title: string; url: string } | null>(null)
  // `editRow` 记住当前要编辑的那一行：兜底按钮要用它**重新领票**（票据一次性，见 JSX 注）。
  const [editRow, setEditRow] = useState<ReportRow | null>(null)
  const [gateEdit, setGateEdit] = useState<ReportRow | null>(null)
  const [gateDraft, setGateDraft] = useState('')
  // 部门门（spec 2026-10-30 §3.4）：编辑态目标行 + 全量部门选项（首开时拉一次、缓存）
  // + 勾选集合（`ext_id`）。两渲染器共用同一个入口（服务端 `PUT /reports/:id/dept-gate`）。
  const [deptEdit, setDeptEdit] = useState<ReportRow | null>(null)
  const [deptOptions, setDeptOptions] = useState<DeptOption[] | null>(null)
  const [deptChecked, setDeptChecked] = useState<string[]>([])
  // 版本通路（platform 行）的三种面：发布备注 Modal / 版本历史抽屉 / 抽屉里的行快照。
  const [publishTarget, setPublishTarget] = useState<ReportRow | null>(null)
  const [publishNote, setPublishNote] = useState('')
  const [versions, setVersions] = useState<{ row: ReportRow; rows: VersionRow[] } | null>(null)
  const [messageApi, ctx] = message.useMessage()

  /**
   * 拉清单。**返回值 = 本次落地的行**（null = 失败）：回滚成功后要拿刷新后的行去换抽屉里的
   * 行快照（否则第二次回滚还带陈旧 `expectedVersion`，必撞 409）。
   */
  const load = async (): Promise<ReportRow[] | null> => {
    // 视图选择（不是鉴权）：manage 身份用管理清单（含页门未放行的行），观看清单不变
    const path = canManage ? '/reports/manage' : '/reports'
    try {
      const b = await apiGet(path)
      const reports = (b as { reports: ReportRow[] }).reports
      // 管理清单另带 `myDepts`（请求者自己的部门闭包，含祖先）；观看清单没有这个键
      // ⇒ 落 `null`（**不知道 ≠ 空集**：观看清单的行已被服务端裁过，不能再拿空集去掉一遍）。
      setMyDepts((b as { myDepts?: string[] }).myDepts ?? null)
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
      return reports
    } catch (e) {
      messageApi.error(messageOf(e))
      return null
    }
  }
  useEffect(() => { void load() }, [])

  // 深链（#1047）：`/console/data/reports?open=<id>` —— 列表就绪后自动打开该自绘报表（分享/收藏直达）。
  // 只消费一次（deepLinkDone 防 load 刷新后重复弹）；行不在观看清单（页门不过/已删）⇒ 静默留在列表，
  // 列表自身的页门列就是解释。Metabase 行不走此路（它的独立地址是 embed-url 那条线）。
  const [searchParams] = useSearchParams()
  const deepLinkDone = useRef(false)
  useEffect(() => {
    if (deepLinkDone.current || rows.length === 0) return
    deepLinkDone.current = true
    const id = searchParams.get('open')
    if (!id) return
    const r = rows.find((x) => x.id === id)
    if (r && r.renderer === 'platform' && canOpen(r)) {
      setSelfDrawn({ title: r.title, id: r.id })
    }
  }, [rows, searchParams])

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
  // ⚠️ 名字带 Gate：Metabase 行的「发布」= **清页门**，与平台行的「发布版本」是两条通路
  //    （见文件头 ⑤）。本函数只由 metabase 行的按钮调用。
  const publishGate = async (r: ReportRow) => {
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

  // ── 部门门（spec 2026-10-30 §3.4；#1173）：**两种渲染器共用**一个改门入口 ──────────
  // 语义早于这里就要清楚：配的是「**这些部门及其子树**里的人可以看」，与页门**叠加**
  // （两个门都要过）。空勾选 = 清空部门门 = 不限部门。
  const openDeptGate = async (r: ReportRow) => {
    setDeptEdit(r)
    setDeptChecked(r.requiredDepts ?? [])
    if (deptOptions !== null) return          // 已拉过就复用（组织架构不常变）
    try {
      const b = await apiGet('/reports/dept-options') as { depts: DeptOption[] }
      setDeptOptions(b.depts)
    } catch (e) {
      messageApi.error(messageOf(e))
      setDeptEdit(null)
    }
  }

  /**
   * 保存部门门。⚠️ **已发布的平台行**上，线上链接仍按**那一版快照**的门判权，要等下一次发布
   * 才生效——弹框里的说明文案必须讲清（否则会被当成「改了没生效」的 bug）。
   * 409 收口同改页门：`deptEdit` 是加载时的行快照，不关框就会拿陈旧版本反复重试。
   */
  const saveDeptGate = async () => {
    const r = deptEdit
    if (r === null) return
    try {
      await apiSend(`/reports/${r.id}/dept-gate`, 'PUT', {
        requiredDepts: deptChecked,
        expectedVersion: r.version,
      })
      messageApi.success(deptChecked.length === 0 ? '已清除部门门' : '部门门已更新')
      setDeptEdit(null)
    } catch (e) {
      messageApi.error(messageOf(e))
      if (e instanceof ApiError && e.status === 409) setDeptEdit(null)
    }
    await load()
  }

  /** 平表 → antd Tree 的树（按 `parentExtId` 挂；找不到父亲的当根，不会丢节点）。 */
  const deptTreeData = (opts: DeptOption[]) => {
    type Node = { title: string; key: string; children: Node[] }
    const nodes = new Map<string, Node>(opts.map((o) => [
      o.extId, { title: `${o.name}（${o.memberCount}）`, key: o.extId, children: [] },
    ]))
    const roots: Node[] = []
    for (const o of opts) {
      const node = nodes.get(o.extId)!
      const parent = o.parentExtId === null ? undefined : nodes.get(o.parentExtId)
      if (parent === undefined) roots.push(node)
      else parent.children.push(node)
    }
    return roots
  }

  // ── 版本通路（platform 行；设计 §6.4）───────────────────────────────────────────
  // 发布 = 对当前草稿做**不可变快照**（`POST /reports/:id/publish`），独立链接从此展示这一版；
  // 与 Metabase 行的「发布」（清页门）是两条不同通路，见文件头 ⑤。

  /**
   * 版本端点的失败体是 `{ ok:false, reason, detail }`（服务端直接回 `PublishOutcome`），
   * 模块薄封装 `toError` 已同时认 `{ error }` 与 `{ ok:false, reason, detail }`，`reason`/`detail`
   * 会经 `messageOf` 呈现（2026-10-26 起）。下面按状态码回填只是 `HTTP_4xx` 兜底，避免裸码。
   * ⚠️ 「已为你刷新」为真：三个调用点的 catch 都 `await load()`（与 STALE_WRITE 同口径）。
   */
  const versionErrorText = (e: unknown): string => {
    if (e instanceof ApiError && e.code.startsWith('HTTP_')) {
      if (e.status === 409) return '这份报表刚被别人改过，已为你刷新，请重试'
      if (e.status === 404) return '目标不存在或已被删除'
      if (e.status === 403) return '没有权限执行该操作（需要更高授权或页门放行）'
      return '操作未通过校验（规格/指标/可加性），请修正草稿后重试'
    }
    return messageOf(e)
  }

  /** 发布（platform 行）：Modal 里可填 note，随版本永久留存。 */
  const publishPlatform = async () => {
    const r = publishTarget
    if (r === null) return
    try {
      const b = await apiSend(`/reports/${r.id}/publish`, 'POST', {
        expectedVersion: r.version,
        note: publishNote.trim(),
      }) as { publishedVersion: number; unchanged?: boolean }
      messageApi.success(b.unchanged === true
        ? `内容未变，仍是 v${b.publishedVersion}`
        : `已发布 v${b.publishedVersion}`)
      setPublishTarget(null)
      setPublishNote('')
    } catch (e) {
      messageApi.error(versionErrorText(e))
      // 同改页门 Modal 的订正记录：409 必须**关框**——框里持的是加载时的行快照，
      // 不关就会拿着陈旧 expectedVersion 反复重试、反复 409（看起来像坏掉了）。
      if (e instanceof ApiError && e.status === 409) {
        setPublishTarget(null)
        setPublishNote('')
      }
    }
    await load()
  }

  /** 下线：独立链接立即失效，但**版本行不删**（append-only），可再发布恢复。 */
  const unpublish = async (r: ReportRow) => {
    try {
      await apiSend(`/reports/${r.id}/unpublish`, 'POST', { expectedVersion: r.version })
      messageApi.success(`已下线「${r.title}」`)
    } catch (e) {
      messageApi.error(versionErrorText(e))
    }
    await load()
  }

  /** 复制独立链接；剪贴板不可用（非安全上下文 / 权限被拒）⇒ 把链接摆出来让人自己复制。 */
  const copyLink = async (r: ReportRow) => {
    const url = `${window.location.origin}/r/${r.id}`
    try {
      await navigator.clipboard.writeText(url)
      messageApi.success('独立链接已复制')
    } catch {
      messageApi.info(url)
    }
  }

  const fetchVersions = async (id: string) =>
    (await apiGet(`/reports/${id}/versions`)) as { versions: VersionRow[] }

  const openVersions = async (r: ReportRow) => {
    try {
      const b = await fetchVersions(r.id)
      setVersions({ row: r, rows: b.versions })
    } catch (e) {
      messageApi.error(messageOf(e))
    }
  }

  /**
   * 回滚 = 用旧版本内容**生成一个新版本**（不删历史、不倒退版本号），故不是「恢复指针」。
   * 成功后必须同时刷新两处：列表（`load()` → 新 `version`）与抽屉里的行快照
   * （否则再点一次回滚仍带旧 `expectedVersion`）＋版本列表（`isCurrent` 挪到新版本）。
   */
  const rollback = async (r: ReportRow, v: number) => {
    try {
      const b = await apiSend(`/reports/${r.id}/versions/${v}/rollback`, 'POST', {
        expectedVersion: r.version,
        note: `回滚自 v${v}`,
      }) as { publishedVersion: number }
      messageApi.success(`已回滚，当前发布 v${b.publishedVersion}`)
      const fresh = await load()
      const live = fresh?.find((x) => x.id === r.id) ?? r
      try {
        const list = await fetchVersions(r.id)
        setVersions((cur) => (cur !== null && cur.row.id === r.id ? { row: live, rows: list.versions } : cur))
      } catch {
        // 抽屉列表刷新失败不影响回滚结果；下次打开抽屉会重新拉。
      }
    } catch (e) {
      messageApi.error(versionErrorText(e))
      // 与改页门同款收口：409 关抽屉，重试只能从刷新后的列表重新进入。
      if (e instanceof ApiError && e.status === 409) setVersions(null)
      await load()
    }
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
    (r.requiredScope === null || session.scopes.includes(r.requiredScope)) && deptOk(r)

  /**
   * 部门门的体验层判据（与 `canOpen` 的页门那半同构）：配了门的行，只有「我在门里」才默认可按。
   * 子树继承由服务端写成闭包（`myDepts` 已含祖先）⇒ 这里只做集合相交，不重复展开树。
   * `myDepts === null`（观看清单）⇒ 不判（见 state 的注）。
   */
  function deptOk(r: ReportRow): boolean {
    const gate = r.requiredDepts ?? []
    if (gate.length === 0) return true
    if (myDepts === null) return true
    return gate.some((d) => myDepts.includes(d))
  }

  const openBtn = (r: ReportRow) => !canOpen(r) ? (
      // ⚠️ antd 6.6.3 已移除 v5 的 `getDisabledCompatibleChildren` ⇒ Tooltip 在禁用的原生 button
      // 上不保证弹；表格里的「页门」「部门门」两列是兜底说明（恒在，不依赖悬停），Tooltip 是锦上添花。
      <Tooltip title={
        r.requiredScope !== null && !session.scopes.includes(r.requiredScope)
          ? `你的账号没有这张报表的页门权限（${r.requiredScope}）`
          : '你的部门不在这张报表的部门门里'
      }>
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
            <Space size={4} wrap>
              {v}
              {r.renderer === 'platform' && <Tag color="purple">平台自绘</Tag>}
              {/* 版本徽标（月报重做 Task 12；设计 §8.2）：只有管理清单带 `publishedVersion` /
                  `hasUnpublishedChanges`，且版本通路只属于 platform 行——Metabase 行标题保持原样，
                  不硬造一个「未发布」（它根本没有版本概念）。 */}
              {canManage && r.renderer === 'platform' && (
                r.publishedVersion === null
                  ? <Tag>未发布</Tag>
                  : r.hasUnpublishedChanges
                    ? <Tag color="orange">{`v${r.publishedVersion} · 有未发布改动`}</Tag>
                    : <Tag color="green">{`已发布 v${r.publishedVersion}`}</Tag>
              )}
            </Space>
          ),
        },
        ...(canManage ? [{
          title: '渲染器', dataIndex: 'renderer',
          render: (v: ReportRow['renderer']) => (v === 'platform' ? <Tag color="purple">平台自绘</Tag> : <Tag>Metabase</Tag>),
        }] : []),
        { title: '页门', dataIndex: 'requiredScope', render: (v: string | null) => v ?? '不限' },
        // 部门门（spec 2026-10-30 §3.4）：恒在的列（不依赖悬停）——它是「打开」置灰的另一半理由。
        // 显示的是**门里配的部门数**（子树继承意味着实际覆盖更多），悬停给出 ext_id。
        {
          title: '部门门', dataIndex: 'requiredDepts',
          render: (v: string[] | null | undefined) => {
            const gate = v ?? []
            if (gate.length === 0) return '不限'
            return (
              <Tooltip title={`限定部门（含其子部门）：${gate.join('、')}`}>
                <Tag color="blue">{`${gate.length} 个部门`}</Tag>
              </Tooltip>
            )
          },
        },
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
              {/* 部门门：**与渲染器无关**（自绘行也要能配），故放在两支条件之外。
                  与「改页门」的区别：页门按 scope，部门门按组织架构（子树继承）。 */}
              {canManage && (
                <Button size="small" onClick={() => void openDeptGate(r)}>
                  {(r.requiredDepts ?? []).length === 0 ? '配部门门' : '改部门门'}
                </Button>
              )}
              {/* ── Metabase 行：既有管理动作**一字不动**（改页门/发布=清页门/回收）────────── */}
              {canManage && r.renderer === 'metabase' && (
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
                                onConfirm={() => void publishGate(r)}>
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
              {/* ── platform 行：版本通路（设计 §6.4）。**没有「改页门」**——页门由发布时从面板
                     派生并随快照钉死；手改会与线上快照不一致（服务端 PUT 对该类行 409）。────── */}
              {canManage && r.renderer === 'platform' && (
                <>
                  <Button size="small" onClick={() => { setPublishTarget(r); setPublishNote('') }}>发布</Button>
                  {r.publishedVersion !== null && (
                    <Popconfirm title={`下线后独立链接立即失效（历史版本保留），确定下线「${r.title}」？`}
                                okText="确认下线" cancelText="取消"
                                onConfirm={() => void unpublish(r)}>
                      <Button size="small">下线</Button>
                    </Popconfirm>
                  )}
                  <Button size="small" onClick={() => void openVersions(r)}>版本</Button>
                  {r.publishedVersion !== null && (
                    <Button size="small" onClick={() => void copyLink(r)}>复制链接</Button>
                  )}
                  {/* 回收连带删 report_versions（on delete cascade）⇒ 文案必须写明历史一并删除
                      （设计 §6.4），否则会有人以为还能找回旧版本。 */}
                  <Popconfirm title={`回收会删除「${r.title}」、报表本体及其全部历史版本，确定？`}
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
      {/* 部门门（spec 2026-10-30 §3.4）：组织架构树多选。**子树继承**——勾一个部门，它的下级部门
          的成员都算在内；页门与部门门**叠加**（两个都过才可见）。
          ⚠️ 已发布的平台行：线上链接按**那一版快照**的门判权，改完要点「发布」才生效。 */}
      <Modal title={`部门门：${deptEdit?.title ?? ''}`}
             open={deptEdit !== null}
             okText="确定" cancelText="取消"
             width={520}
             onOk={() => void saveDeptGate()}
             onCancel={() => setDeptEdit(null)}>
        <Typography.Paragraph type="secondary">
          勾选「哪些部门可以看」。包含所勾部门的**全部子部门**；不勾 = 不限部门。
          部门门与页门**叠加**（两个都要过）。已发布的平台自绘报表需再「发布」一次才影响线上链接。
        </Typography.Paragraph>
        {deptOptions === null || deptOptions.length === 0 ? (
          <Typography.Text type="secondary">
            {deptOptions === null ? '正在加载组织架构…' : '本租户还没有同步组织架构（先在企业微信同步）'}
          </Typography.Text>
        ) : (
          // ⚠️ 别用 `defaultExpandAll`：真实租户有 272 个部门（山海实测），全展开的树在
          //    弹框里会撑到 7800px 高、连「确定」都够不着。默认只展开**第一层**，其余按需点开；
          //    容器限高滚动（与通知模块的部门选择器同款）。
          <>
            <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              {`共 ${deptOptions.length} 个部门，默认只展开第一层（勾父部门包含其全部子部门）`}
            </Typography.Text>
            <div style={{ maxHeight: 280, overflow: 'auto', border: '1px solid #f0f0f0', padding: 8 }}>
              <Tree checkable selectable={false}
                    treeData={deptTreeData(deptOptions)}
                    defaultExpandedKeys={deptTreeData(deptOptions).map((n) => n.key)}
                    checkedKeys={deptChecked}
                    onCheck={(keys) => setDeptChecked(
                      (Array.isArray(keys) ? keys : keys.checked).map(String),
                    )} />
            </div>
          </>
        )}
      </Modal>
      {/* 发布版本（platform 行）：note 随版本永久留存（审计面），可选但值得填。 */}
      <Modal title={`发布：${publishTarget?.title ?? ''}`}
             open={publishTarget !== null}
             okText="确认发布" cancelText="取消"
             onOk={() => void publishPlatform()}
             onCancel={() => { setPublishTarget(null); setPublishNote('') }}>
        <Typography.Paragraph type="secondary">
          发布会对当前草稿生成不可变快照；独立链接从现在起展示这一版。发布备注可选（随版本永久留存）。
        </Typography.Paragraph>
        <Input value={publishNote} maxLength={200}
               onChange={(e) => setPublishNote(e.target.value)}
               placeholder="发布备注（可选）" />
      </Modal>
      {/* 版本历史抽屉：每行可「查看」钉住版本的独立链接（`/r/:id?v=N`）或「回滚」到该版。
          `wide` 的列不多，640 足够；正文快照不进列表（服务端只给元数据）。 */}
      <Drawer title={`版本历史：${versions?.row.title ?? ''}`}
              open={versions !== null}
              onClose={() => setVersions(null)}
              width={640}>
        <Table rowKey="version" size="small" pagination={false}
               dataSource={versions?.rows ?? []}
               locale={{ emptyText: '暂无发布历史' }}
               columns={[
                 {
                   title: '版本', dataIndex: 'version',
                   render: (v: number, row: VersionRow) => (
                     <Space size={4}>
                       {`v${v}`}
                       {row.isCurrent && <Tag color="green">线上</Tag>}
                     </Space>
                   ),
                 },
                 {
                   title: '发布时间', dataIndex: 'publishedAt',
                   // 服务端是 RFC3339 UTC；这里只做扫读用的截断，时区不换算（审计原文在 API）。
                   render: (v: string) => v.slice(0, 16).replace('T', ' '),
                 },
                 { title: '发布人', dataIndex: 'publishedBy' },
                 { title: '备注', dataIndex: 'note' },
                 {
                   title: '操作',
                   render: (_: unknown, row: VersionRow) => (
                     <Space size="small">
                       <Button size="small" onClick={() => {
                         if (versions === null) return
                         window.open(`${window.location.origin}/r/${versions.row.id}?v=${row.version}`,
                           '_blank', 'noopener,noreferrer')
                       }}>查看</Button>
                       {/* 线上版自己不能「回滚到自己」（会白生成一版），故只在非当前版本给。 */}
                       {!row.isCurrent && (
                         <Popconfirm title={`回滚会用 v${row.version} 的内容生成一个新版本（历史不删），确定？`}
                                     okText="确认回滚" cancelText="取消"
                                     onConfirm={() => { if (versions !== null) void rollback(versions.row, row.version) }}>
                           <Button size="small">回滚</Button>
                         </Popconfirm>
                       )}
                     </Space>
                   ),
                 },
               ]} />
      </Drawer>
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
