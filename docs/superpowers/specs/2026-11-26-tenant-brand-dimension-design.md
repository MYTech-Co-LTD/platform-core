# 租户品牌维度：`data` 读模型 + 工单快照（品牌筛选通用化）

> 2026-11-26 用户拍板；issue：**#2892**。上游：`2026-11-26-ticket-console-wuji-alignment-design.md`
> （工单页对齐无极，品牌筛选目前是硬编码名称前缀）。本文是**品牌模型的正典**。
>
> **一句话**：品牌归属是**租户主数据**，不是模块私有表、不是 `platform` 运营配置、也不是
> `data.dim_branch` 的一个派生列。它落在 `data` 的租户级读模型（`brand_registry` +
> `brand_assignment` + 稳定视图），售后提单时解析并**快照到工单**，报表/BI 共用同一条
> `dataDependencies` 读路径。

## 0. 背景与问题

- shanhai 有熊喵 / 品品甜两个品牌，工单页需要品牌筛选与计数。
- 当前实现（`routes/ticket-query.ts:12`）用 `store_name` 前缀 `熊喵%` / `品品甜%` 推导品牌，
  并把 `Brand` 写成 `'xiongmao' | 'pptd'` 的联合类型；UI 固定两个胶囊。
- 其他租户可能 0 个、1 个、N 个品牌；品牌可能挂在门店、商品或账套上；不能假设「两个品牌 +
  名称前缀」。
- 品牌映射会被跨模块使用（售后、报表/BI、未来的其他模块），因此不能归售后模块私有；
  也不能放 `platform` 配置 schema——本仓 B1 禁止 `modules/**` 读 `platform`，数据模块/
  报表也读不到，跨模块复用不成立。

## 1. 决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 品牌归属放哪 | **`data` 层的租户级读模型**：`data.brand_registry` + `data.brand_assignment` + 两个稳定视图 |
| 2 | 是否给 `data.dim_branch` 加品牌列 | **不加**（源没有、账套去重会判错、单列表达不了商品级/多品牌） |
| 3 | 是否放 `platform` schema | **不放**（模块读不到；数据面/报表也读不到；会逼出多套 port/投影） |
| 4 | 是否放售后模块内 | **不放**（跨模块 + 租户级，模块私有表会把共享主数据锁死在一个模块里） |
| 5 | 工单读侧 | **提单时解析 + 快照** `brand_code/brand_name/brand_source/brand_origin`；读侧不 join |
| 6 | 解析顺序 | `product` 分配 > `store` 分配 > 未分类；后续有真实案例再加租户级策略 |
| 7 | 失败姿态 | 读模型缺失/查询失败 ⇒ **未分类 + 告警**，绝不阻断提单 |
| 8 | 0/1/N 品牌 | 0：不显示；1：不显示筛选；2–4：胶囊；5+：Select；未分类为一等选项 |
| 9 | 生命周期 | code 不可变、禁用不删、历史品牌仍可筛、回填只填空、人工不被源同步覆盖 |
| 10 | 谁配置 | v1 复用 `data:manage`（data 管理面/脚本）；有明确运营需求再加 `data:brand` |

## 2. 为什么不能直接给 `data.dim_branch` 加品牌列

三道硬墙（均有实证）：

1. **源里没有**：`dbt/models/lemeng/staging/stg_lemeng_branch.sql` 的列来自
   `contracts/common/lemeng.branch.json`（16 列），没有 brand；乐檬 `branch.find` 不返回品牌。
2. **账套品牌 ≠ 门店品牌**：`dbt/seeds/dim_brand.csv` 是 `system_book → brand`（3120 熊喵 /
   64188 品品甜）；`data.dim_branch` 跨账套去重的排序是 `system_book asc`（3120 优先，
   `scripts/lemeng/publish-dims.mjs:131-141`），而品品甜门店同时是 3120 的批发客户 ⇒
   会被判成熊喵。**正好把 shanhai 需要的两个品牌判反**。
3. **粒度/契约**：湖上门店维粒度是 `(system_book, snapshot, branch_num)`，发布视图压成
   `(org, code)`；单列表达不了「一店多品牌 / 商品级品牌」；加列要动契约、L0 管线、data-plane
   lock、dbt staging/mart、publish-dims 列清单与 B10/B13 门禁——为一个租户属性动整条链，
   代价与收益不成比例。

即使加了列，也**解决不了历史口径**：`data.dim_branch` 只有当前发布快照，历史工单 join 当前维
会在门店换品牌时被重新分类。工单仍必须快照品牌。

**什么时候可以进维表**：源里有可靠的门店品牌字段、品牌是门店级、接受日更发布节奏，并且
仍保留工单快照。届时正确形状是 `dim_store_brand` / `dim_product_brand` **桥表**，不是单列。

## 3. 数据模型（`modules/data/migrations/056_brand_dimension.sql`）

```sql
-- 租户品牌字典
create table if not exists data.brand_registry (
  org        text not null,
  code       text not null,
  name       text not null,
  sort       integer not null default 0,
  enabled    boolean not null default true,
  source     text not null default 'manual'
             check (source in ('source_field','book','mapping','prefix','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org, code)
);

-- 主体 → 品牌分配（一主体一品牌；product 优先于 store）
create table if not exists data.brand_assignment (
  org          text not null,
  subject_type text not null check (subject_type in ('store','product')),
  subject_code text not null,
  brand_code   text not null,
  source       text not null
               check (source in ('source_field','book','mapping','prefix','manual','backfill')),
  -- manual 行锁定：源同步不得覆盖（人工优先于源）
  locked       boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (org, subject_type, subject_code),
  foreign key (org, brand_code) references data.brand_registry(org, code)
);
create index if not exists data_brand_assignment_org_brand_idx
  on data.brand_assignment (org, brand_code);

-- 变更审计（配置是主数据，必须有痕）
create table if not exists data.brand_audit (
  id           bigserial primary key,
  org          text not null,
  actor        text not null default '',
  action       text not null,          -- brand.create / brand.update / assignment.upsert / assignment.import / assignment.backfill
  subject_type text,
  subject_code text,
  brand_code   text,
  detail       jsonb not null default '{}',
  at           timestamptz not null default now()
);
create index if not exists data_brand_audit_org_at_idx on data.brand_audit (org, at desc);
```

稳定视图（消费者只读，不读基表；`drop view if exists` + `create view`，不用
`create or replace`）：

```sql
drop view if exists data.v_brand_registry;
create view data.v_brand_registry as
select org, code, name, sort, enabled, source, updated_at
  from data.brand_registry;

drop view if exists data.v_brand_assignment;
create view data.v_brand_assignment as
select a.org, a.subject_type, a.subject_code,
       a.brand_code, r.name as brand_name,
       a.source, coalesce(r.enabled, false) as brand_enabled,
       a.updated_at
  from data.brand_assignment a
  left join data.brand_registry r
    on r.org = a.org and r.code = a.brand_code;
```

**命名纪律**：现有 `dim_brand` 是**账套品牌**（数据范围/问数用），不是租户品牌。新表一律用
`brand_registry` / `brand_assignment`，并在 `dim_brand` 的 seed/schema 注释里写明两者区别，
避免未来 join 错。

## 4. 解析与工单快照

### 4.1 解析

```ts
resolveBrand(org, { productCode, storeCode }) →
  // 1. data.v_brand_assignment where subject_type='product' and subject_code=productCode
  //    and brand_enabled = true
  // 2. 同上 subject_type='store' and subject_code=storeCode
  // 3. 都没有 ⇒ null（未分类）
```

- 查询失败 / 视图缺失 ⇒ `null` + warn；**不阻断提单**。
- 解析结果带来源：`brand_source = 'product' | 'store' | 'unavailable'`，
  `brand_origin = assignment.source`（`source_field/book/mapping/prefix/manual`）。

### 4.2 工单快照（`modules/aftersales/migrations/011_ticket_brand_snapshot.sql`）

```sql
alter table aftersales.ticket
  add column if not exists brand_code   text not null default '',
  add column if not exists brand_name   text not null default '',
  add column if not exists brand_source text not null default '',
  add column if not exists brand_origin text not null default '';
create index if not exists aftersales_ticket_org_brand_id_idx
  on aftersales.ticket (org, brand_code, id desc);
```

- 提单：解析成功后写四个字段；未分类写空串 + `brand_source='unavailable'`。
- 历史单：一次性回填（只填空值），`brand_source='backfill'`、`brand_origin='backfill'`，
  幂等、带 `data.brand_audit`。**绝不覆盖已有非空值**。
- 列表/详情/计数/导出：只按 `ticket.brand_code` / `brand_name`，读侧不 join。

## 5. API

### 5.1 品牌选项并入 `GET /tickets/counts`（不另开端点）

品牌选项与计数和状态计数来自同一个端点，避免同一份数据两条接口、两次请求：

```json
{
  "status": { "all": 212, "pending": 12, "completed": 180, "cancelled": 20 },
  "brand": {
    "options": [
      { "code": "xiongmao", "name": "熊喵", "count": 120 },
      { "code": "pptd", "name": "品品甜", "count": 80 }
    ],
    "unclassified": 12,
    "showFilter": true,
    "degraded": false
  }
}
```

- `options` = `data.v_brand_registry` 的品牌（含停用，历史可筛）**∪** 工单里出现过的历史品牌；
  名称优先字典，字典缺失回落到工单快照名；排序用 `sort`，缺失排后。
- `count` 跟随当前 `status`（与状态胶囊语义一致）；`unclassified` 同样跟随 `status`。
- `showFilter = options.length >= 2 || unclassified > 0`；0/1 品牌且无未分类 ⇒ `false`，
  console 不渲染品牌行。
- 视图缺失/查询失败 ⇒ 品牌面 `{ options:[], unclassified:0, showFilter:false, degraded:true }`，
  状态计数照常返回，不是 500。

### 5.2 `GET /tickets?brand=<code>`

- 允许值 = 当前字典 ∪ 工单历史品牌；未分类用保留值 `__unclassified__`（brand code 不允许以
  `__` 开头，避免撞名）。
- 非法值 ⇒ 400 `INVALID_BRAND`；`__unclassified__` ⇒ `brand_code = ''`。

### 5.3 `GET /tickets/counts`

```json
{
  "status": { "all": 212, "pending": 12, "completed": 180, "cancelled": 20 },
  "brand": { "options": [ ... ], "unclassified": 12 }
}
```

状态计数仍全局；品牌计数只跟随 `status`（与 wuji 语义一致）。

### 5.4 导出

- 品牌列用 `ticket.brand_name` 快照；字典改名不回溯历史导出。
- 字段选择、行数上限、附件清单不变。

## 6. Console（工单页）

- `FilterBar` 接收 `brandOptions / unclassified / brand`，不再 import 硬编码
  `BRAND_LABEL/BRAND_TONE`。
- 0/1 品牌：不渲染品牌行；`showFilter=false` 时不发计数查询。
- 2–4：中性色胶囊（不用状态色）；点击已选中的再点一次取消。
- 5+：换 `Select` 或横向滚动。
- 未分类：若 `unclassified > 0`，显示弱化的「未分类 N」胶囊，点击筛出待补映射的单。
- 表格/详情：品牌列显示 `brand_name || brand_code`；空 ⇒ `—`。
- 导出字段「品牌」用快照名。

## 7. 生命周期与治理

| 场景 | 规则 |
|---|---|
| 品牌改名 | `code` 不可变，只改 `name`；工单/导出用快照名；筛选标签用当前名，找不到回落快照名 |
| 品牌停用 | `enabled=false`，**不删行**；历史工单仍可按该品牌筛 |
| 门店/商品换品牌 | 历史工单快照不变；新工单按新分配 |
| 手工 vs 源同步 | `locked=true` 的 manual 行不被源同步覆盖；源同步只更新 `locked=false` / `source='source_field'` 的行 |
| 回填 | 只填空值；幂等；每次写 `data.brand_audit` |
| 未分类 | 计数/筛选/覆盖率都展示；不是「被排除」 |
| 审计 | 字典/分配/导入/回填全部落 `data.brand_audit` |
| 覆盖率 | 已分配/未分配门店数、商品数；未分类增长要告警 |

## 8. shanhai 灌数与回填（一次性脚本，幂等）

1. `scripts/seed-brand-assignment.mjs`（`--dry-run` / `--apply`）：
   - 从 wuji `store_info.brand_relation` 读 `1=熊喵 / 2=品品甜`；
   - 写 `data.brand_registry`（`xiongmao/熊喵`、`pptd/品品甜`）；
   - 写 `data.brand_assignment`（`subject_type='store'`，`source='source_field'`）；
   - `brand_relation` 为空的门店用名称前缀兜底（`source='prefix'`），并计入未分配告警。
   - **无 wuji 凭据时的引导**：`--from-dim-branch --prefix-map` 直接按 `data.dim_branch`
     名称前缀分配（`source='prefix'`），与旧运行时行为一致；之后用 `--from-wuji` 的
     `source_field` 覆盖（prefix 行未锁，会被更新；manual 行不会被覆盖）。
2. `scripts/backfill-ticket-brand.mjs`（`--dry-run` / `--apply`）：
   - 只对 `brand_code=''` 的工单，按 `store_code`/`product_code` 查 `data.v_brand_assignment`；
   - 写入 `brand_code/brand_name`、`brand_source='backfill'`、`brand_origin='backfill'`；
   - 每批审计，可重跑，不覆盖非空值。

其他租户：默认无字典/无分配 ⇒ `showFilter=false`；接入时用脚本或 data 管理面导入
`subject_type,subject_code,brand_code`。

## 9. 契约、门禁、顺序

- aftersales manifest 增加：
  ```yaml
  dataDependencies:
    - data.dim_branch
    - data.dim_item
    - data.dim_settlement_order_line
    - data.v_brand_registry
    - data.v_brand_assignment
  ```
- `scripts/data-dependencies.lock.json` 登记两个视图的列集（B13）；列集变更必须显式登记。
- 所有查询带 `org` 谓词（B14）。
- 迁移顺序：data 的 `056` 必须先于 aftersales 运行时可用；若 loader 不能保证「全部迁移跑完
  再服务」，靠 resolver fail-open 兜底，并在启动检查里告警。
- 权限：v1 品牌配置复用 `data:manage`（data 管理面/脚本）；若出现「租户管理员无 data:manage
  但要配品牌」的真实案例，再加 `data:brand`（最小权限），不提前造码。
- 管理面：v1 先提供脚本 + 只读覆盖接口；data 后台的品牌导入页作为 P2。

## 10. 测试

- data 迁移：幂等重跑；视图列集；B13 lock；B14 org。
- resolver：product 优先、store 兜底、都无 ⇒ 未分类；视图缺失/查询失败 ⇒ fail-open 且不阻断提单。
- 提单：快照四字段；未分类写空串；`brand_source/origin` 正确。
- 列表/计数/导出：0/1/N；`brand=<code>`；`__unclassified__`；历史禁用品牌仍可筛；未知品牌 400。
- 回填：只填空、幂等、审计、不覆盖。
- console：`showFilter=false` 不渲染/不发计数；2–4 胶囊；5+ Select；未分类胶囊；中性色。
- 契约：manifest dataDependencies ↔ 代码引用一致；B13 列集；B14 org。
- 数据治理：manual 不被源同步覆盖；品牌改名/停用不改变历史快照。

## 11. 明确不做

- 不给 `data.dim_branch` 加品牌列（理由见 §2）。
- 不放 `platform.brand*`（模块读不到、数据面读不到、会逼出多套 port/投影）。
- 不在售后模块内自持品牌映射（跨模块 + 租户级）。
- 不上通用 EAV/JSONB 属性系统。
- 不把品牌当权限边界；品牌级授权是另一个需求（`data.scope` 的 brand 是账套范围，语义不同）。
- 不提前建 `dim_store_brand` 桥表；等源字段到位或第二个真实消费者出现再提升。

## 12. 上线与回滚

- 加性变更：data 表/视图 + aftersales 四个快照列；旧代码忽略新列，旧数据为空串。
- 视图缺失/解析失败 ⇒ 未分类 + 告警，不阻断工单提交。
- 回滚 aftersales：品牌筛选消失，工单与历史列保留；回滚 data：视图消失，resolver fail-open。
- 上线后验证：`showFilter` 对 shanhai 为 true、两品牌计数正确；未分类为 0 或可解释；
  `data.brand_audit` 有灌数/回填记录；`GET /tickets?brand=__unclassified__` 可筛。
