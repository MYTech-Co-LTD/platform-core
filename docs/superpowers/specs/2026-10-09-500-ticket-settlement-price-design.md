# 工单取价设计：按单结算价 + 建单挂原单 + 发布面归一（#500 价格接线定稿）

> 2026-10-09/10 brainstorming 定稿。上游：#500（ticket 自然键化 + 建单价格接线——本稿**替换**其第 3 步
> 「价格 join dim_item_price」）、#481（价格源，验收② 在本稿内）、#499（数据面，R2/R3 已落地）。
> 现状断言全部按 2026-10-08/10 的**真机探针实测**（探针记录见 WeKnora 条目 `cb31a2fb` 与
> `74cf2ad4` 订正版），不是照抄文档。

## 0 一句话

售后工单**挂原单取价**：移动端选店→选结算单（MO/WO）→选行，服务端按原单行把 `price_minor`
（基本单位分价）冻进票面；两张流出单据在**发布面归一成一张表** `data.dim_settlement_order_line`，
售后模块不感知源数与账套数；WO→门店的映射靠**客户档案对照表**（精确键+精确同名，绝不造店）。

## 1 业务图景与已拍板决策

**图景（2026-10-10 用户订正）**：公司双品牌——熊喵＝账套 3120（主）、品品甜＝账套 64188。
品品甜门店是**自家门店**，只是相对 3120 是批发客户。门店进货结算两条通路：

| 通路 | 单据 | 收货方标识 | 结算价 |
|---|---|---|---|
| 熊喵门店 ← 3120 | MO 配送调出单（`dim_transfer_out`） | `branch_code`（现成） | `out_money ÷ quantity` |
| 品品甜门店 ← 3120 | WO 批发销售单（`dim_wholesale_out`） | `client_fid`（无名称） | `order_detail_price`（≡money÷qty） |

**已拍板（用户逐项确认）**：

1. **按实际结算价**（按单成交价），不用档案价 ⇒ `dim_item_price` 退出工单链路（表保留，价格批其他用途不动）。
2. **建单挂原单号**：不挂单不给价。价随单走、票面可追溯到具体单，调价/促销逐单差异由「用户选哪张单」裁决。
3. **发布面归一（方案 A）**：物化一张 `data.dim_settlement_order_line`；售后只见一张表。
4. **fail-closed**：引用的单/行不存在、或无价 ⇒ `PRICE_NOT_FOUND` 400（#500 原则，不 fallback 不取 0）。
5. **通用化**：单账套客户、双账套客户、无数据面客户共用同一套模块代码，差异全收在发布脚本的数据里。

## 2 实测底座（本稿成立的前提，全部真机验证过）

| 事实 | 证据 |
|---|---|
| 批发单接口 76 键（单头+明细）**无客户名称**，只有 `client_fid` | 2026-10-10 探针全键清单 |
| 客户名称唯一出处＝`nhsoft.whs.ai.client.find`（进销存批发客户档案）；**裸能力码路径 + GET**；文档 `/whs/ai/` 前缀报「PAT接口路由未配置」、裸码 POST 报 method not supported；GET 下 `keyword` 不生效、`limit` 绑定松散（请求 200 实返 ~700）、总量 2000+ | 2026-10-10 真机 200 实测 |
| `nhsoft.wms.ai.client.find`（WMS 配送客户，864 条）是**另一个人群**（`wms_out_num` 小序号，批发客户号尾段 395/758 全 MISS）⇒ 不可用 | 同上 |
| `client_fid` 与 64188 门店码**不同构**（交集 = 0） | stg 对撞 SQL 实测 |
| 品品甜客户名与 64188 门店名**精确同名**（5/5 唯一命中，无跨账套同名冲突）；64188 店码是「曲靖01」式中文码 | stg_lemeng_branch 实测 |
| 客户档案 2121+ 条、13 种 client_type（个体订购/甜选/友商…）⇒ 大杂烩，只能当对照表 | 档案抽样分布 |
| MO/WO 发布面已带 `org` 列 + `price_minor`（基本单位分价）；`org` 语义 = 009 跨账套去重租户视图 | 迁移 012/013 + publish-dims ①口径 |

## 3 架构与数据流

```
[采集]  lemeng.client 新源（whs.client.find 全量翻页快照，3120）
          │  走 collect-source A→I（契约+L0+staging，独立 issue）
          ▼
[湖/staging]  stg_lemeng_client（staging.stg_lemeng_transfer_out / stg_lemeng_wholesale_out 已在）
          │
          ▼
[发布]  publish-dims.mjs（每日幂等，一处收口）
          ├─ MO 行：store_code = branch_code（现成）──────────────┐
          ├─ WO 行：client_fid → ①data.client_store_override     ├─▶ data.dim_settlement_order_line
          │         → ②stg client_name 精确同名 → dim_branch.code ┘   （未映射：不进面 + 大声红）
          ▼
[消费]  aftersales 模块（只读这一张面）
          选店 → GET 结算单列表 → 选单选行 → 建单冻结 price_minor + 依据四元组
```

发布逻辑**只在 publish-dims 一处**；migration 只建表；售后模块零客户差异（架构不变量不动：
服务拆分/技术栈/数据流向/存储方案均沿用 `docs/architecture.md` 既定格局，新端点随 aftersales
manifest `api.internal` 声明更新）。

## 4 取价面 schema（migration 014 草案）

```sql
create table data.dim_settlement_order_line (
  org          text not null,
  source       text not null,            -- 'transfer' | 'wholesale'
  store_code   text not null,            -- MO=branch_code；WO=对照表解析后的门店码
  store_name   text,
  order_no     text not null,            -- MO…/WO…（工单关联键）
  order_bizday date not null,            -- 制单日（选单排序/新鲜度）
  order_time   text,                     -- 制单时间（展示）
  item_code    text not null,
  item_name    text,
  line_key     text not null,            -- MO=item_grade_num；WO=order_detail_num（行身份）
  quantity     decimal(14,6),
  money        decimal(14,2),
  price_minor  bigint not null,          -- 基本单位分价（工单冻结值）
  primary key (org, order_no, item_code, line_key)
);
create index data_dim_settlement_order_line_store_idx
  on data.dim_settlement_order_line (org, store_code, order_bizday);
```

语义钉死：

- **行粒度 = 原单行**。MO 同单同商品多 grade 行、WO 同单同商品多明细行都各自成行——挂原单取价
  必须行级精确，发布侧**不做**跨行聚合（与 012 的单内批次聚合不同：012 是把批次并到 grade 行，
  本面沿用其结果行）。
- 只收 **state_code=3（已审）且 money>0** 的行（沿用 012/013 发布判据；赠品行无结算价不进面）。
- `order_no` 空间 MO*/WO* 天然不相交，PK 不需要 source；source 列仅作展示与审计。
- 幂等：发布侧 delete 后整批 insert（现有模式）；迁移 drop 重建（首建无消费方）。

**对照表（migration 015）**——唯一的人工兜底，且只兜「改名漂移」：

```sql
create table data.client_store_override (
  org        text not null,
  client_fid text not null,
  store_code text not null,
  primary key (org, client_fid)
);
```

## 5 WO→门店映射解析规则（publish-dims 内实现）

按序解析，**先override 后同名**：

1. `client_store_override` 命中 ⇒ 用其 store_code（人工 curated，走 SQL/迁移种子维护，本期不做 UI）。
2. `stg_lemeng_client.client_name` **精确同名**匹配 `data.dim_branch.name`：
   命中 1 行 ⇒ 用之；命中多行 ⇒ 按现有 009 口径①（system_book 字典序小者）取一，与 dim_branch
   去重天然同源。
3. 0 命中 ⇒ **该 client 的行不进面**，未映射清单大声红（publish 日志 + 现有告警通路），
   绝不造店。非门店客户（「品品甜」总账户、「品品甜左总」等）天然落在此类。

**单源分工铁律**：dim_branch 是门店唯一事实源（地址/电话/启停一律以它为准）；客户档案只消费
`client_fid + client_name` 两列做键查找，行不进门店维、不进任何门店列表。改名漂移（一端改名）
表现为映射率下跌告警 → 人工补 override，不会静默错。

## 6 售后模块改动（#500 本体）

### 6.1 端点（随 manifest `api.internal` 声明更新）

- `GET /guest/settlement-orders?store_code=<code>&days=30`：按店列近期结算单（bizday 倒序，
  days 默认 30、clamp 上限 90），按单分组返回 `{orderNo, source, bizday, lines:[{itemCode,
  itemName, lineKey, quantity, priceMinor}]}`。数据源 = 本面单表查询。
- 建单 `SubmitBody` 增（自然键化后形态）：`orderNo`（MO/WO 形状校验）、`itemCode`、`lineKey`
  **三者必填**（选单页是行级选择，天然无歧义）；`storeCode` 由可选转**必填**——选单流程先选店，
  且 §6.2 的串店校验需要它做基准。

### 6.2 建单冻结（fail-closed 矩阵）

| 情形 | 行为 |
|---|---|
| (org, orderNo, itemCode, lineKey) 无行 / price 缺 | 400 `PRICE_NOT_FOUND` |
| 行存在但 `store_code ≠` 提交的 storeCode（串店引用） | 400 `ORDER_STORE_MISMATCH` |
| 正常 | 冻结 `settlement_*` 六列 + 金额按冻结价计算 |

ticket 迁移（并入 #500 的自然键化迁移段）：`settlement_source / settlement_order_no /
settlement_item_code / settlement_line_key / settlement_price_minor / settlement_bizday`（六列）。
退款等金额计算（#481 验收②）改读冻结价——票面金额有源、可审计、不随后续调价漂移。

### 6.3 与 #500 原范围的关系

- **照旧**：ticket `product_code/store_code` 自然键化（bigint 死列化）、`SubmitBody` 切 string、
  dim_item/dim_branch 校验、读侧投影、mobile 跟改、测试换 dim 夹具。
- **替换**：原第 3 步「价格 join `dim_item_price`（grade=0）」⇒ 本稿挂原单冻结。
- **新增**：选单端点、settlement_* 迁移列、客档采集段（下节）。

## 7 通用性（用户要求「尽量做成通用应用」的落点）

| 客户形态 | 行为 | 模块代码 |
|---|---|---|
| 单账套仅 MO（多数客户） | 面里只有 transfer 行 | 不变 |
| 双账套（山海） | WO 行经对照表混入同面 | 不变 |
| 有 MO 无 WO 客户档案 | 对照表为空即退化 | 不变 |
| 无数据面 | 面空 ⇒ 建单 PRICE_NOT_FOUND（fail-closed 即契约） | 不变 |

差异全部收在**发布脚本的数据**里（publish-dims 本来就 per-customer），消费面契约统一。

## 8 测试与验收

1. **采集段**：client 档案全量翻页入湖（页数哨兵按首跑标定）；已知 41 个 WO client_fid 在
   档案中 **41/41** 命中（fid→name 覆盖率）。
2. **映射段**：10-08 全量 WO 行经解析，映射率与未命中清单人工过目（预期≈100%，非门店客户除外）；
   抽样单与无极副本 price 逐分对平。
3. **售后段**：本地 dev-stack（MockCasdoor）端到端——选单→建单→票面 settlement_* 有源→退款
   计算出数；三类 400 各一例；mobile 真机走通（配方见记忆 platform-core-local-ui-verify-recipe，
   开发完自己验，§1.6）。
4. **mock 收严到真机形状**（#50/#51 教训）：client.find 的 mock 按本稿 §2 实测形状（GET、
   分页语义、字段集），不按想象放宽。

## 9 范围拆段（实施顺序 = 依赖序）

| 段 | 内容 | issue |
|---|---|---|
| ① 采集源 lemeng.client | 契约 + L0 管线（3120）+ staging + 探活（走 collect-source A→I 判停门） | 新开 issue（feat(data)） |
| ② 发布面 | migration 014/015 + publish-dims 归一逻辑 + 大声红 + 探活判据（映射率/面新鲜度） | 新开 issue（feat(data)） |
| ③ 售后接线 | #500 本体（自然键化 + 挂原单 + 冻结 + 端点 + mobile） | #500（本稿即其价格段设计） |

①→②→③ 严格串行；③ 中「自然键化」部分不依赖①②，可与①并行起工。

## 10 开放问题与债

- client 档案分页参数绑定松散（`keyword` 失效、`limit` 漂移）：首跑现场标定真实页容量与总量，
  哨兵阈值按实测定（批发单 19 页先例）。
- override 表本期无管理 UI（SQL 维护）；若漂移告警频繁再立 UI 债。
- 品品甜折扣系列（3120 有店档、又可能是 WO 客户）双通路场景：挂原单天然消歧，验收时抽一例确认即可。
- 同名多命中（跨账套同名店）当前按 ①口径自动取——若未来出现「同名不同店」，会静默取错侧；
  验收判据里加一条：多命中清单进大声红日志（取侧可自动，**报**必须响）。
