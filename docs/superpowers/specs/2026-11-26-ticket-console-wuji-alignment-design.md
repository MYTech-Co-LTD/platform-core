# 售后工单页对齐无极：设计（筛选 / 计数 / 金额预览 / 导出 / 批量删除）

> 2026-11-26 用户拍板。issue：**#2884**。上游：`2026-09-15-aftersales-module-design.md`
> （售后域总设计）、`2026-10-09-500-ticket-settlement-price-design.md`（挂原单取价）。
> 本文是**实施正典**；旧 spec 的 §2.1 / §2.2 / §2.4 / §3.1 按本文同步修订
> （修订记录见旧 spec §7 同日条目）。
>
> **为什么有这一篇**：M3a 移植工单页时，按「无端点支撑」砍掉了批量删除、导出、品牌筛选、
> 状态计数，处理弹窗也只做「盲提交」（无金额预览）。2026-11-26 用户要求与无极工单管理页
> 功能对齐，并逐项确认了范围与规则。本文把「补什么、怎么补、哪些仍不做」定死。

## 0 范围与既定决策（用户逐项确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 对齐范围 | **全部补齐**：状态计数、品牌筛选、批量删除、导出、服务端金额预览 |
| 2 | 金额实时计算 | 由**服务端预览端点**算，前端不写第二份公式（守 §0.3「服务端权威计算」） |
| 3 | 按比例退款 | 公式不变；**建单时冻结所选结算行的数量**为 `basic_quantity`，让比例真正生效。存量待处理单该值仍为 0（迁移不跨表回填，见 §8） |
| 4 | 批量删除 | 新增权限码 **`aftersales:delete`**，默认无人持有；**不限状态**；逐单事务 + 审计 + 附件清理 |
| 5 | 补字段 | 新增 `watermark_at`（水印时间）、`opinion`（处理人售后意见）；`damage_quantity` 支持两位小数 |
| 6 | 紧急状态 | **不做**——无极提单页也没有这个控件，提交时恒为空串；本项目移动端同样不采集 |
| 7 | 视觉 | 沿用 `DESIGN.md`（圆点+文字状态、胶囊控件、antd）；不照搬无极的 TDesign 渐变标签 |
| 8 | 页面结构 | 拆成筛选条 / 搜索条 / 表格 / 处理弹窗 / 详情弹窗 / 附件预览 / 导出，每块可单独测 |

**明确不做**：把无极的 Vue 页面原样搬进 console（console 是 React，旧 spec §0.2 已否决）；
前端全量拉取再前端分页/前端计数；跨页勾选（本轮勾选**限当前页**，≤100 条，见 §3）；
批次号（无数据源）；紧急状态；移动端提单页的 UI 改版（只放开服务端的小数校验）。

## 1 数据模型（新增迁移 `010_ticket_console_fields.sql`，可重复执行）

| 列 | 变更 | 原因 |
|---|---|---|
| `damage_quantity` | `integer` → `numeric(12,2)`，保留 `not null default 0`，加 `>= 0` 检查 | 移动端已按两位小数收，服务端一直拒；按公斤计的商品（生产约 4700 个）受影响 |
| `basic_quantity` | `integer` → `numeric(14,6)`，加 `>= 0` 检查 | 与 `data.dim_settlement_order_line.quantity decimal(14,6)` **同精度**；建单时冻结该行数量 |
| `opinion`（新） | `text not null default ''` | 处理人的售后意见，和店员填的报损原因 `remark` 分开；处理后不再覆盖 `remark` |
| `watermark_at`（新） | `date`，可空 | 照片水印上的日期；处理时必填，存量行为空 |

SQL 形状（幂等）：

```sql
alter table aftersales.ticket
  alter column damage_quantity type numeric(12,2) using damage_quantity::numeric(12,2),
  alter column basic_quantity  type numeric(14,6) using basic_quantity::numeric(14,6),
  add column if not exists opinion      text not null default '',
  add column if not exists watermark_at date;

-- `add constraint if not exists` 在 PG 里不存在；用 DO 块（与 008 同款）。
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'aftersales_ticket_damage_qty_chk'
                   and conrelid = 'aftersales.ticket'::regclass) then
    alter table aftersales.ticket add constraint aftersales_ticket_damage_qty_chk
      check (damage_quantity >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'aftersales_ticket_basic_qty_chk'
                   and conrelid = 'aftersales.ticket'::regclass) then
    alter table aftersales.ticket add constraint aftersales_ticket_basic_qty_chk
      check (basic_quantity >= 0);
  end if;
end $$;
```

**建单侧同步（`routes/ticket-guest.ts`）**：取价查询多读 `quantity`，插入工单时
`basic_quantity = coalesce(quantity, 0)`。`quantity` 可空（视图允许），空值按 0 冻结并在
工单上保留可追溯的四元组（source / order_no / item_code / line_key），不编造数量。

**存量语义**：`damage_quantity` 的整数值无损转成两位小数；`basic_quantity` 保持原值
（历史单为 0）；`opinion` 空串；`watermark_at` 为空。**不跨表回填**存量单的
`basic_quantity`——回填依赖 `data.dim_settlement_order_line` 先就绪，装机会失败；
生产现存那张待处理单（AS-00000010）按比例处理仍会全额赔，部署后是否手工补由用户当场定。

## 2 接口

### 2.1 manifest 声明

新增权限码：

```yaml
permissions:
  - { code: aftersales:delete, name: 售后工单删除 }
```

新增/变更端点（全部走既有 `declaredScopeGate`，声明即授权、漏声明即 403）：

| 端点 | scope | 说明 |
|---|---|---|
| `GET /tickets` | `aftersales:manage` | 扩筛选与行字段（见 2.2） |
| `GET /tickets/counts`（新） | `aftersales:manage` | 状态全局计数 + 品牌跟随状态计数 |
| `GET /tickets/:id` | `aftersales:manage` | 详情补品牌/报损金额/基本数量/基本单价/售后意见/水印时间 |
| `POST /tickets/:id/quote`（新） | `aftersales:manage` | 金额预览，**只算不写**；与处理共用 `resolveProcess` |
| `POST /tickets/:id/process` | `aftersales:manage` | 售后意见必填（≤500）、水印时间必填；不再收/写 `remark` |
| `GET /tickets/export`（新） | `aftersales:manage` | 服务端生成 Excel |
| `GET /tickets/export-manifest`（新） | `aftersales:manage` | 附件打包清单（每单附件的预签名地址） |
| `POST /tickets/batch-delete`（新） | `aftersales:delete` | 批量删除；权限码单独，默认无人持有 |

**路由顺序**：`/tickets/counts`、`/tickets/export`、`/tickets/export-manifest` 必须注册在
`/tickets/:id` **之前**，否则会被 `:id` 吞掉（`counts` 不是合法 id ⇒ 400 INVALID_ID）。
`module.test.ts` 的路由↔manifest 双向核对会兜住漏声明。

### 2.2 `GET /tickets`（扩筛选与行字段）

查询参数（全部可选）：

| 参数 | 语义 |
|---|---|
| `status` | `pending` / `completed` / `cancelled` |
| `brand` | `xiongmao` / `pptd`；**不提供**「无品牌」选项（65 家无前缀门店不进品牌筛选） |
| `code` | 工单编号，ILIKE 包含 |
| `product` | 商品名，ILIKE 包含 |
| `store` | 门店名，ILIKE 包含 |
| `relatedOrder` | 关联订单号，ILIKE 包含 |
| `opinion` | 售后意见，ILIKE 包含 |
| `processedFrom` / `processedTo` | 处理日期范围，`YYYY-MM-DD`，**按 Asia/Shanghai 整天**、两端都含 |
| `page` / `size` | 既有 `parsePageParam`，不变 |

- ILIKE 的 `%` `_` `\` 必须转义（与 `ticket-guest.ts` / `masterdata.ts` 同款 `escapeLike`）。
- 时间范围 SQL 口径：
  `processed_at >= ($from::date)::timestamp at time zone 'Asia/Shanghai'`，
  `processed_at < (($to::date) + 1)::timestamp at time zone 'Asia/Shanghai'`。
- 品牌是**派生维度**，不新增存储列：按工单快照的 `store_name` 前缀判断——
  `熊喵%` ⇒ `xiongmao`，`品品甜%` ⇒ `pptd`，其余为空（不进品牌筛选）。用快照而不是
  当前门店表，保证历史单的品牌不随门店改名漂移。
- 行字段在现有基础上补：`brand`、`amount_minor`（pending 为 null，**不补 0**）、
  `opinion`、`watermark_at`、`image_count`、`video_count`（按 `ticket_attachment.content_type`
  前缀 `image/` / `video/` 计）。附件计数用 `left join lateral` 或相关子查询，主查询仍走
  `(org, id desc)` / `(org, status, id desc)` 索引。
- 排序、分页、`total` 语义不变。

### 2.3 `GET /tickets/counts`

响应：

```json
{
  "status": { "all": 123, "pending": 4, "completed": 110, "cancelled": 9 },
  "brand":  { "xiongmao": 80, "pptd": 30, "none": 13 }
}
```

- `status` 计数是**全局的**：只按 org，不受品牌、搜索、时间范围影响。
- `brand` 计数**只跟随 `status`**：传了 `status` 就统计该状态下的品牌分布，不跟随品牌本身
  或其他搜索条件（否则点一个品牌后另一个品牌的计数会归零，胶囊没法再点回去）。
- `brand.none` 可选返回（无品牌前缀门店数），UI 不展示为胶囊。

### 2.4 `POST /tickets/:id/quote`

请求体与处理动作同形（discriminated union）：

```ts
{ amountType: 'ratio'; refundRatio: number }
| { amountType: 'fixed'; amountMinor: number }
| { amountType: 'reject' }
```

- 只读工单快照（`damage_quantity`、`basic_quantity`、`coalesce(settlement_price_minor,
  basic_unit_price_minor)` 作单价），调用 `resolveProcess`，**不写任何列**。
- 只有 `pending` 可预览；非 pending ⇒ `409 ALREADY_PROCESSED`（与处理同语义）。
- 响应：

```json
{ "status": "completed", "amountType": "ratio", "amountMinor": 225,
  "refundRatio": 0.1, "damageAmountMinor": 900 }
```

  `damageAmountMinor` = 报损金额（毛额）= `damage_quantity × 单价`，按分四舍五入；
  它是**固定金额输入框的上限来源**，前端不再自己乘。
- 校验与错误码沿用处理端点（`INVALID_BODY` / `INVALID_ID` / `NOT_FOUND` /
  `ALREADY_PROCESSED` / 金额校验错误）。

### 2.5 `POST /tickets/:id/process`

请求体变更：

```ts
{
  amountType: 'ratio' | 'fixed' | 'reject'
  refundRatio?: number          // ratio 路
  amountMinor?: number          // fixed 路
  opinion: string               // 新增：1..500 字，必填
  watermarkAt: string           // 新增：YYYY-MM-DD，必填
}
```

- **`remark` 从处理体移除**：处理不再写 `remark`（那是店员填的报损原因）。
  历史客户端若仍传 `remark`，zod 默认剥掉，不报错、不落库。
- `opinion` 去首尾空白后 1..500 字；`watermarkAt` 用 `^\\d{4}-\\d{2}-\\d{2}$` 且是真实日期。
- 事务内写：`status`、`amount_type`、`amount_minor`、`refund_ratio`、`operator`、
  `processed_at`、`opinion`、`watermark_at`；条件更新仍是 `where status='pending'`，
  影响行数 0 ⇒ 409。
- 审计 `ticket.process` 的 detail 补 `watermarkAt`；通知链路（#2805）不变。

### 2.6 `GET /tickets/export` 与 `GET /tickets/export-manifest`

两者共用同一套范围参数：

| 参数 | 语义 |
|---|---|
| `range` | `selected`（用 `ids`）/ `filtered`（用 2.2 的筛选参数）/ `all` |
| `ids` | `selected` 时必填，逗号分隔，1..100 个；仅当前页可达（见 §3） |
| 2.2 的全部筛选参数 | `filtered` / `all` 时生效（`all` 忽略筛选） |
| `columns` | 仅 export：逗号分隔的列 key；缺省 = 全部；未知 key ⇒ 400 `INVALID_COLUMNS` |

- **行数上限 20,000**：超过 ⇒ 400 `EXPORT_TOO_LARGE`，提示缩小筛选范围。上限是为了保护
  `exceljs` 的内存与响应时间（应用服务器出口只有 5–6 Mbps，大文件本来也不适合这里）。
- `GET /tickets/export`：服务端生成 `.xlsx`，`Content-Type` 为
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`；
  `Content-Disposition: attachment; filename*=UTF-8''...`（中文文件名按 RFC 5987 编码）。
- 列定义（key / 表头 / 值）：

| key | 表头 | 值 |
|---|---|---|
| `code` | 工单编号 | 文本 |
| `status` | 状态 | 中文（待处理/已处理/已驳回） |
| `brand` | 品牌 | 熊喵/品品甜/空 |
| `productName` | 商品 | 文本 |
| `storeName` | 门店 | 文本 |
| `relatedOrder` | 关联订单 | 文本 |
| `damageQuantity` | 报损数量 | 数值（≤2 位小数） |
| `damageAmount` | 报损金额 | 数值（元，2 位小数；**毛额**，pending 也有值） |
| `refundAmount` | 赔付金额 | 数值（元，2 位小数；pending 为空） |
| `amountType` | 售后类型 | 按比例/固定金额/驳回 |
| `refundRatio` | 比例 | 数值（小数比例，Excel 百分比格式） |
| `operator` | 处理人 | 文本 |
| `opinion` | 售后意见 | 文本 |
| `watermarkAt` | 水印时间 | `YYYY-MM-DD` |
| `attachments` | 附件数 | 数值（图片数+视频数） |
| `createdAt` | 提交时间 | `YYYY-MM-DD HH:mm`（Asia/Shanghai） |
| `processedAt` | 处理时间 | 同上，pending 为空 |
| `arrivalAt` | 到货时间 | 同上，空为 — |
| `storeAffiliation` | 归属 | 一致/门店不一致/未登记 |

- `GET /tickets/export-manifest`：响应 `{ "tickets": [ { "id", "code", "attachments": [
  { "id", "objectKey", "contentType", "sizeBytes", "url" } ] } ] }`；`url` 是预签名 GET，
  **TTL 3600 秒**（比单次查看的 600 秒长，因为批量下载可能耗时）。无附件的工单
  `attachments` 为空数组、仍出现在清单里？**不出现**——清单只列有附件的工单，减少体积。
- 两个端点都只读，不落审计（与查看同档）。

### 2.7 `POST /tickets/batch-delete`

```ts
{ ids: number[] }   // 1..100 个正整数，去重
```

响应（200，逐单结果；请求本身合法就不因部分失败而整体 4xx）：

```json
{ "deleted": [12, 15], "failed": [ { "id": 13, "code": "AS-00000013", "error": "NOT_FOUND" } ] }
```

- 权限由 manifest 的 `aftersales:delete` 施加，handler 不再自己判 scope。
- 逐单一个事务（见 §5.2）：先解析该单全部附件的 `storage_ref`（任一解析不出来 ⇒ 该单
  整体失败、不做任何删除），再事务删附件行 + 工单 + 审计，提交后删对象。
- 审计 `ticket.delete`，`target` = 工单编号，detail = `{status, amountMinor, attachments,
  objectDeleteFailures}`。
- 空数组 / 超 100 / 非整数 ⇒ 400 `INVALID_BODY`。

## 3 页面与交互（`modules/aftersales/console/tickets/`）

### 3.1 文件拆分

| 文件 | 职责 |
|---|---|
| `index.tsx` | 页面编排：筛选/分页/勾选状态、数据加载、弹窗开关 |
| `FilterBar.tsx` | 状态胶囊 + 品牌胶囊（带计数） |
| `SearchBar.tsx` | 五个输入框 + 处理时间范围 + 搜索/重置 |
| `TicketTable.tsx` | 列定义、行内操作、分页、每页条数 |
| `ProcessDialog.tsx` | 处理弹窗（重写：信息+附件在上、表单在下、预览金额） |
| `DetailDialog.tsx` | 详情弹窗（五段） |
| `AttachmentPreview.tsx` | 图片/视频预览、上一个/下一个、键盘 |
| `ExportDialog.tsx` | 字段勾选 + 是否含附件 + 导出 |
| `lib/export.ts` | 导出编排：取 xlsx、取清单、直连对象存储下载、浏览器打包 |
| `lib/brand.ts` | 品牌常量/文案（`xiongmao`/`pptd`）与状态文案复用 |

`api-types.ts` 同步补请求/响应类型，服务端与 console 共用（两侧不各写一份）。

### 3.2 筛选条

- **状态胶囊**：全部、待处理、已处理、已驳回，各带计数（来自 `/tickets/counts`）。
  点未选中的 ⇒ 选中并查询；点已选中的 ⇒ 回到「全部」。
- **品牌胶囊**：熊喵、品品甜，各带计数（跟随当前状态）。点已选中的再点一次取消。
- 两类点击都：立即查询、回第 1 页、**清空勾选**。
- 计数刷新时机：首次加载、处理成功、删除成功、筛选条件变化（防抖后）。

### 3.3 搜索条

- 五个输入框：工单编号、商品、门店、关联订单、售后意见。
- 处理时间范围：`DatePicker.RangePicker`，只到日，两端含。
- 回车或点「搜索」生效；「重置」清空五个输入框与时间范围，**并把状态/品牌都回到全部**，
  一次查询回第 1 页（「全部条件」按字面执行）。
- 任何搜索生效都清空勾选。

### 3.4 工具条与表格

- 左侧「已选择 N 项」；右侧「导出」下拉（选中 / 筛选结果 / 全部；「选中」在 0 项时禁用）；
  持有 `aftersales:delete` 的人多一个「删除」按钮（红色危险样式）。
- 表格列（顺序）：勾选、序号、工单编号、操作、状态、品牌、商品、门店、关联订单、
  到货时间、报损数量、报损金额、售后类型、比例、附件、售后意见、水印时间、处理人、
  提交时间、处理时间、归属。
  - **保留现有「到货时间」「归属」列**（旧功能不回归）。
  - 左侧固定：勾选、序号、工单编号、操作（照无极；操作在左）。
  - 编号可点开详情；待处理行操作是「处理」，其余是「查看」（打开详情）。
  - 附件列文案 `图片 3 · 视频 1`，无附件显示 `—`；点击打开该单附件预览。
  - **报损金额**（毛额 = 报损数量 × 单价）：pending 也显示（数量与单价都已冻结）；
    **赔付金额**（`amount_minor`）：pending 显示 `—`（**不显示 ¥0.00**，避免误以为算过且为 0）。
  - 比例：已处理且 ratio 路显示百分比；其余 `—`。
- 每页 20 / 50 / 100，默认 20；选择记在 `localStorage['aftersales.tickets.pageSize']`。
- **勾选只在当前页**：翻页、改筛选、改每页条数都清空勾选。理由：批量删除/导出都要把 id
  塞进 URL/请求体，跨页勾选会无限长且无明确上限；无极的批量操作也是页内语义。

### 3.5 处理弹窗

- 上半：工单信息（编号、商品、门店、报损数量、单价、关联订单、到货时间）+ 附件 **chip**
  （只显示「图片 i / 视频 i」与是否可预览，**不放 `<img>` 缩略图**——打开处理弹窗不产生
  任何附件字节下载；点击 chip 才进附件预览）。
- 下半表单：
  - 金额类型：按比例 / 固定金额 / 驳回。
  - **比例下拉来自规则表**：`GET /rules` 全量取回，按 `refundRatio` 去重后**从小到大**；
    `0` 标成「全额赔付（0%）」。规则表为空 ⇒ 下拉为空并提示「规则表为空，请先在规则页
    添加规则」，不允许盲填比例。
  - 固定金额：`InputNumber` 上限 = 预览返回的 `damageAmountMinor`（元显示）。
  - 水印时间：`DatePicker`，默认今天，必填。
  - 售后意见：`TextArea`，必填，500 字上限，实时计数。
- **实时金额**：比例/固定金额变化后（300ms 防抖）调 `POST /tickets/:id/quote`，显示
  「预计赔付 ¥x.xx」；预览失败显示行内错误，但**仍允许提交**（服务端提交时会重算，
  服务端是唯一真相）。前端不写任何乘法公式。
- 提交成功：关弹窗 → 刷新列表与计数 → message 显示「已处理，赔付 ¥x.xx」或「已驳回」。
- `409 ALREADY_PROCESSED`：提示「已被他人处理」并刷新列表。
- 已处理的单**不提供「处理」入口**：本项目把 completed/cancelled 当终态（与无极的
  「可覆盖处理」有意不同；要改只能删了重提）。

### 3.6 详情弹窗（五段）

1. **工单信息**：编号、状态、品牌、商品、门店、关联订单、提交人、到货时间。
2. **报损信息**：报损数量、基本数量、基本单价、报损金额（毛额）、报损原因（`remark`）。
3. **附件**：缩略图/文件列表（图片、视频、其他），点击进预览。
4. **处理信息**：售后类型、比例、赔付金额、处理人、售后意见（`opinion`）、水印时间。
5. **时间信息**：提交时间、处理时间（pending 显示 `—`）。

### 3.7 附件预览（懒加载 + 单次缓存，2026-11-27 补；issue #2903）

- **只有本弹窗打开时才加载当前这一个附件**；列表/处理/详情弹窗只拿元数据，不加载字节。
- 图片：`fetch(url)` 取 Blob → `URL.createObjectURL`，按 **attachment id** 缓存；重复打开/
  上一个下一个切回**不再重新下载**。对象 URL 在页面 `pagehide` 时统一 revoke。
- 视频：只缓存预签名 URL，`<video preload="metadata">` 流式播放，**不整段下载**；URL 过期/
  播放报错换一次新 URL（仍不整段下载）。
- 其他类型：下载链接，点击才产生字节。
- 上一个 / 下一个按钮 + 键盘 `←` `→`；`Esc` 关闭。
- 计数器「第 i / N 个」；文件名按 `附件 i`（原始文件名未存储，见 §8）。
- 从列表附件列进入：`GET /tickets/:id` 只取附件元数据 + 预签名 URL；字节仍只在预览里按需加载。
- 预览缓存按会话存活（关闭弹窗不清），目的是「每个附件只真正取一次」；页面卸载才释放。

### 3.8 导出弹窗

- 字段勾选：默认全选；选择记在 `localStorage['aftersales.tickets.exportColumns']`
  （存 key 列表；新增列若不在已存列表里，默认不勾——以显式选择为准）。
- 「包含附件」勾选框，默认不勾。
- 导出流程：
  1. 勾了附件 ⇒ 先取 `GET /tickets/export-manifest`（同一范围参数）。
  2. 取 `GET /tickets/export` 拿 xlsx blob。
  3. 勾了附件 ⇒ 对清单里的每个 `url` **直接向对象存储** `fetch` 下载（不经应用服务器），
     在浏览器里用 `fflate` 打成 zip；zip 内含同一份 xlsx + 附件文件。
  4. 未勾附件 ⇒ 直接下载 xlsx。
- 文件名：`售后工单_YYYYMMDD_HHmm.xlsx` / `售后工单_YYYYMMDD_HHmm.zip`。
- zip 内附件命名 `AS-00000012/001.jpg`（单号/序号.扩展名；扩展名按 content_type 映射，
  未知用 `bin`）。**原始文件名没有存储**，这是数据缺口，不在本轮补列。
- 附件总量上限 500 MB（前端预估 `sizeBytes` 之和）；超过提示「缩小范围或分次导出」。
- 导出中显示进度（至少：准备清单 / 下载附件 i/N / 打包），避免大包时界面无反馈。

### 3.9 删除

- 二次确认内容：选中 N 条，其中待处理/已处理/已驳回各几条，附件共 M 个；
  「工单与附件会一并删除，不可恢复」。
- 确认后调 `POST /tickets/batch-delete`；结果弹窗列出成功/失败（失败的给出单号与原因）。
- 成功后：清空勾选、刷新列表与计数。

## 4 金额（服务端权威）

- 公式不变（旧 spec §2.4）：
  `赔付 = max(0, 报损数量 − 基本数量 × 比例) × 基本单价`，四舍五入到分。
- `basic_quantity` = 建单时所选结算行的采购数量（例：进货 15 件、报损 2 件、单价 4.50 元、
  比例 10% ⇒ `(2 − 15×0.1) × 4.50 = 2.25` 元）。存量单该值为 0 ⇒ 比例不起作用（全额赔）。
- 比例来自 `ticket_rule.refund_ratio`（小数，`numeric(6,4)`）；下拉去重升序，0 标「全额赔付」。
- 预览与处理**同一个函数** `resolveProcess` / `computeAmountMinor`：预览返回的金额与提交后
  落库的金额必然一致（同一份归一后的比例、同一份快照）。
- **固定金额的服务端校验仍是原有上界**（`MAX_FIXED_AMOUNT_MINOR`）；「不超过报损金额」只在
  UI 生效（用户批准的设计口径）。这是已知边界：构造请求可绕过 UI 上限，见 §8。

## 5 导出与删除的实现要点

### 5.1 Excel 生成

- **不能在 aftersales 里 import `modules/data/domain/xlsx.ts`**：B1 禁止跨模块引用。
- 在模块内新增 `modules/aftersales/domain/xlsx.ts`，依赖 `exceljs`（与 data 模块同一做法）：
  表头冻结、数值单元格、金额 `#,##0.00`、比例 `0.00%`、无法解析为数的值按文本写。
- `exceljs` 加进 `modules/aftersales/package.json` 的 dependencies。
- 浏览器打包用 `fflate`（同样加进模块 dependencies）；它是纯 JS、体积小、可在 worker 外跑。
- console 的日期控件用 `dayjs`（antd 的 peer 依赖），同样显式加进模块 dependencies——
  pnpm 严格 node_modules 下不能靠 antd 的传递依赖。

### 5.2 删除的单事务边界

S3 删除**不在数据库事务内**，所以顺序按「先解析、事务删行、提交后删对象」：

1. 事务外：读该单全部附件行，用 `storageCandidatesFor(c.get(TENANT_STORAGE))` +
   `storageResolverFor` 逐行解析 `storage_ref`；**任一解析不出来 ⇒ 该单整体失败**，
   不做任何破坏性动作（响应 `failed`，原因 `STORAGE_UNRESOLVED`）。
2. 事务内：`select ... for update` 锁工单；删附件行；删工单；写审计；提交。
3. 提交后：按解析出的配置 `deleteObject` 逐个删对象。失败**不回滚已提交的删除**，
   把失败 key 记进审计 detail 的 `objectDeleteFailures`，并打 warn 日志。
   结果：用户可见状态是干净的（工单和附件行都没了）；残留的是**不可见的孤儿对象**，
   后续可由附件 GC 扩展（对象存储列举）清理，而不是「工单还在、附件打不开」的半删。
   这与设计文字「先删对象再删行」的顺序不同，是有意的失败模式取舍（语义不变）。

- 审计与业务同事务（`writeAudit(client, ...)`），审计失败即整单回滚。
- 删除不检查状态（不限 pending/completed/cancelled）；审计保留
  `{status, amountMinor, attachments}` 摘要，但工单行本身不再可查。

## 6 测试与验收

### 6.1 服务端（真库）

- 迁移 010：重复执行不报错；整数存量值转换正确；check 约束拒绝负数；`opinion`/`watermark_at`
  默认值正确。
- `GET /tickets`：每个筛选参数单独生效与组合生效；ILIKE 通配符转义（输入 `%` 不匹配全部）；
  处理时间范围按 Asia/Shanghai 整天、两端含；品牌派生（熊喵/品品甜/无前缀）；附件图/视频计数；
  pending 的 `amount_minor` 为 null。
- `GET /tickets/counts`：状态计数全局；品牌计数只跟随 status（改品牌筛选不影响计数）。
- `POST /tickets/:id/quote`：ratio/fixed/reject 三路；与 process 落库金额逐分一致；非 pending ⇒ 409；
  不写库（前后行不变）。
- `POST /tickets/:id/process`：`opinion`/`watermarkAt` 缺失或越界 ⇒ 400；`remark` 不再被覆盖；
  比例归一后算钱与落库一致；条件更新并发仍 409。
- 建单：`basic_quantity` 冻结结算行 quantity（含 quantity 为空 ⇒ 0）；`damage_quantity` 两位小数
  接受、三位小数拒绝、负数拒绝。
- `GET /tickets/export`：列选择、三种 range、20,000 上限、中文文件名；xlsx 可被 exceljs 读回。
- `GET /tickets/export-manifest`：只列有附件工单；预签名 URL 有效；TTL 3600。
- `POST /tickets/batch-delete`：无 `aftersales:delete` ⇒ 403（门卫）；有权限 ⇒ 删除附件行/工单/对象，
  审计行存在且 detail 正确；`storage_ref` 解析失败 ⇒ 该单整体不动；部分成功响应形状；
  空/超限/重复 id。
- 路由↔manifest 双向核对（`module.test.ts`）覆盖全部新端点与 `aftersales:delete`。

### 6.2 console

- 筛选参数拼接、胶囊二次点击取消、搜索/重置清空全部条件、回第 1 页、清空勾选。
- 勾选工具条计数、翻页/改每页条数清空勾选、每页条数记忆。
- 删除确认里的分状态计数与附件数；删除结果的失败列表。
- 处理弹窗：规则去重升序、0% 文案、预览调用（防抖）、固定金额上限、
  必填校验、成功后刷新、409 文案。
- 导出弹窗：列选择记忆、筛选/选中/全部范围、含附件时 zip 编排（mock fetch）、
  500 MB 上限提示。
- 附件预览：上一个/下一个、键盘左右/Esc、图片/视频分支；**懒加载**——未打开预览不 fetch、
  打开只 fetch 当前一个、切回/重复打开走缓存不再 fetch。
- 详情弹窗五段字段。

### 6.3 手工验收

- 本地 `dev:stack`：带图片和视频附件走完「提单 → 列表筛选/计数 → 预览 → 处理（比例与固定）→
  详情 → 导出（含附件）→ 批量删除（含附件）」。
- 合并部署后在生产 console 只读走一遍（筛选/计数/预览/详情/导出），**不在生产删数据**。
- 本工作树路径含中文，会打挂一类测试（`non-ascii-worktree-path-breaks-vitest`）；
  全量验证时克隆到纯英文路径再跑。

### 6.4 门禁

根 `pnpm test`（含 unit/gates/web/smoke）、`pnpm typecheck`、`pnpm build`、CI 全量绿后合并。

## 7 流程与发布

1. 本文落盘 + 旧 spec §2.2/§2.4/§3.1 同步修订（本轮**只改文档**）。
2. issue **#2884**（已开），分支 `feat/aftersales-ticket-console-wuji-alignment`。
3. 实施分波次（迁移/建单 → 查询/计数/预览/处理 → 导出/删除 → console 拆页 → 测试/验收）。
4. PR 带 `Closes #N`，CI 全绿后合并；merge main 触发自动部署。
5. 部署后必验（`deploy-verify.md`）：容器创建时间 > 镜像构建时间；在容器内 grep 新字符串
   （如 `tickets/counts`）确认新代码在跑；生产 console 只读走一遍。

**上线时要人知道的三件事**：

- **规则表是空的** ⇒ 处理弹窗的比例下拉没有选项；要先用规则页添加/导入规则。
- **`aftersales:delete` 默认无人持有** ⇒ 部署后要在角色页把它授给对应的人，删除按钮才出现。
- **存量待处理单 AS-00000010 的 `basic_quantity` 仍是 0** ⇒ 按比例处理会全额赔；
  迁移不自动补，部署后是否手工补由用户当场定。

## 8 已知边界 / 不做

| 边界 | 说明 |
|---|---|
| 固定金额上限只在 UI | 服务端仍只校验 `MAX_FIXED_AMOUNT_MINOR`；构造请求可超过「报损金额」。用户批准的口径；若要收严，另立小项加服务端校验 |
| 附件无原始文件名 | `ticket_attachment` 只存 `objectKey/contentType/sizeBytes`；zip 内用「单号/序号.扩展名」。补文件名要加列 + 改上传链路，不在本轮 |
| 跨页勾选 | 不支持；勾选限当前页（≤100），翻页/改筛选清空 |
| 导出上限 | 20,000 行 / 500 MB 附件；超过提示缩小范围 |
| 品牌派生 | 只看 `store_name` 前缀；65 家无前缀门店（仓储中心、管理中心等）不进品牌筛选 |
| 存量单比例 | AS-00000010 的 `basic_quantity` 为 0，比例处理=全额赔；不跨表回填 |
| 紧急状态 | 不做（无极提单页也不采集，列表该列在无极恒为「-」） |
| 批次号 | 无数据源，不做 |
| 删除完成单 | 允许（按权限、不限状态）；工单与金额不可恢复，审计只留摘要 |
| 删除的孤儿对象 | S3 删除在事务外；失败留下不可见孤儿对象，由后续 GC 扩展清理 |
| 已处理单不可重处理 | 与无极有意不同：本项目 completed/cancelled 是终态 |

## 9 与旧 spec 的对应修订

| 旧 spec 位置 | 修订 |
|---|---|
| §2.1 数据模型表 | `ticket` 行的字段说明补：`damage_quantity` 两位小数、`basic_quantity` 建单冻结结算行数量、`opinion`、`watermark_at` |
| §2.2 端点块与分面表 | 管理面补 `GET /tickets/counts`、`POST /tickets/:id/quote`、`GET /tickets/export`、`GET /tickets/export-manifest`、`POST /tickets/batch-delete`（后者 scope `aftersales:delete`）；`GET /tickets` 补筛选 |
| §2.4 金额规则 | 补「`basic_quantity` 的来源与存量语义」；处理动作补 `opinion`/`watermark_at` 必填、`remark` 不再覆盖 |
| §3.1 console 管理端 | 「砍掉」列改为「已由 2026-11-26 新端点补齐」；删除「处理弹窗不显示预估金额」整段，改为「预览端点 + 前端无公式」 |
