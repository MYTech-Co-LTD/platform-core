# 门店画像：门店级品牌 + 等级（售后门店页签运营面）

> 2026-11-27 用户拍板：品牌/等级归 **data 共享**；等级 **手工配置、门店级**；门店页签
> **可编辑 + 批量导入**。本文是门店画像的正典。上游：
> `2026-11-26-tenant-brand-dimension-design.md`（品牌维度）、
> `2026-11-26-ticket-console-wuji-alignment-design.md`（工单页）。
> issue：**#2924**。

## 0. 一句话

**门店级品牌和等级统一进 `data.store_profile`**；`brand_assignment` 只保留商品级覆盖。
门店页签读写这份门店画像；工单提单快照品牌/等级；工单筛选按
`状态 → 搜索/时间 → 等级 → 品牌（最末级）` 计数。

## 1. 数据模型（data 057）

```sql
-- 等级字典（手工维护；code 不可变）
create table if not exists data.store_level_registry (
  org        text not null,
  code       text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  name       text not null check (name <> ''),
  sort       integer not null default 0,
  enabled    boolean not null default true,
  source     text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org, code)
);

-- 门店画像：一店一行；门店级品牌 + 等级
create table if not exists data.store_profile (
  org          text not null,
  store_code   text not null,
  brand_code   text,
  brand_source text not null default '',
  brand_locked boolean not null default false,
  level_code   text,
  level_source text not null default '',
  level_locked boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (org, store_code),
  foreign key (org, brand_code) references data.brand_registry(org, code),
  foreign key (org, level_code) references data.store_level_registry(org, code)
);

create table if not exists data.store_profile_audit (
  id         bigserial primary key,
  org        text not null,
  actor      text not null default '',
  action     text not null,          -- profile.update / profile.import / level.create / level.update / profile.migrate
  store_code text not null default '',
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists data_store_profile_audit_org_at_idx
  on data.store_profile_audit (org, created_at desc);
```

**迁移现有品牌（一次性、幂等）**：把 `brand_assignment` 的 `subject_type='store'` 行复制进
`store_profile(brand_code, brand_source, brand_locked)`，然后删除这些行；`brand_assignment`
只保留 `subject_type='product'`（商品级覆盖）。复制用 `on conflict (org,store_code) do update`
只更新 brand 三列，不碰 level。

**稳定视图**：

```sql
drop view if exists data.v_store_level_registry;
create view data.v_store_level_registry as
select org, code, name, sort, enabled, source, updated_at
  from data.store_level_registry;

drop view if exists data.v_store_profile;
create view data.v_store_profile as
select b.org,
       b.code        as store_code,
       b.name        as store_name,
       sp.brand_code,
       br.name       as brand_name,
       coalesce(sp.brand_source, '') as brand_source,
       sp.level_code,
       lr.name       as level_name,
       coalesce(sp.level_source, '') as level_source,
       sp.updated_at
  from data.dim_branch b
  left join data.store_profile sp
    on sp.org = b.org and sp.store_code = b.code
  left join data.brand_registry br
    on br.org = b.org and br.code = sp.brand_code
  left join data.store_level_registry lr
    on lr.org = b.org and lr.code = sp.level_code;
```

`data.v_brand_assignment` 保留（迁移后只剩 product 行）；工单品牌解析 = product 分配 >
`v_store_profile.brand_code` > 未分类。

## 2. 归属与权限

- 数据在 **data**；门店页签只是 UI。
- 读门店 + 品牌/等级 tag：`GET /stores`（aftersales:manage，join `v_store_profile`）。
- 读品牌/等级选项 + 覆盖率：`GET /stores/profile-options`（aftersales:manage）。
- **写**：data 模块，新增最小权限码 **`data:store`**：
  - `PUT /store-profiles/:storeCode`（单个编辑）
  - `POST /store-profiles/import`（dry-run / apply）
  - `POST /store-levels`、`PATCH /store-levels/:code`（等级字典）
- 没有 `data:store` 时门店页签**只读**（tag 可见，编辑/导入按钮隐藏）；data API 403 兜底。
- 角色页提供「售后门店画像管理员」= `aftersales:manage` + `data:store`。

## 3. data API

### 3.1 `PUT /store-profiles/:storeCode`（data:store）

```json
{ "brandCode": "xiongmao", "levelCode": "A" }
```

- `brandCode` / `levelCode` 可为 `null`（清空）。校验：门店存在于 `data.dim_branch`；
  brand/level code 存在于对应 registry（或 null）。
- 事务内 upsert `store_profile`；`brand_source='manual'`, `brand_locked=true`,
  `level_source='manual'`, `level_locked=true`；审计 `profile.update`（from/to）。
- 返回更新后的 `v_store_profile` 一行。

### 3.2 `POST /store-profiles/import`（data:store）

```json
{ "dryRun": true, "overrideLocked": false,
  "rows": [{ "storeCode": "S01", "brandCode": "xiongmao", "levelCode": "A" }] }
```

- UTF-8 CSV 由 console 解析成 rows；服务端只收 JSON。
- 空/缺省 `brandCode`/`levelCode`：**保持不变**；清空用 `null`（CSV 里 `__clear__` 映射成 null）。
- 校验：门店存在、brand/level 存在、重复 `storeCode` 后者覆盖并计入 warning。
- `dryRun=true` 只返回逐行错误/将变更；`apply` 时合法行一个事务 upsert，非法行跳过；
  `brand_locked/level_locked=true` 的行默认跳过，`overrideLocked=true` 才覆盖。
- 上限 5,000 行；审计 `profile.import`（行数/成功/跳过/错误摘要）。

### 3.3 `POST /store-levels` / `PATCH /store-levels/:code`（data:store）

- code 创建后不可变；name/sort/enabled 可改；禁用不删（历史工单仍可筛）。
- 审计 `level.create` / `level.update`。

## 4. 门店页签（aftersales console）

- 列：编码、名称、**品牌 tag**、**等级 tag**、启用、地址/电话；有 `data:store` 才显示编辑。
- 编辑抽屉：品牌下拉（`/stores/profile-options`，含「无品牌」）、等级下拉（含「未分级」）。
- 批量导入：CSV 文本框/文件，`store_code,brand_code,level_code`；先 dry-run 预览，再 apply；
  展示逐行错误与覆盖率。
- 等级字典：小弹窗维护 code/name/排序/启用。
- 覆盖率：`已标记品牌 309/374`、`已分级 X/374`；未标记/未分级可见。
- 门店档案快照日由 `data.dim_branch.snapshot` 给出（日更发布；新门店等发布后才可分配）。

## 5. 工单快照与解析

- 迁移 `012_ticket_store_level_snapshot.sql`：

```sql
alter table aftersales.ticket
  add column if not exists store_level_code   text not null default '',
  add column if not exists store_level_name   text not null default '',
  add column if not exists store_level_source text not null default '';
create index if not exists aftersales_ticket_org_level_id_idx
  on aftersales.ticket (org, store_level_code, id desc);
```

- 提单解析：
  - 品牌：product 分配（`v_brand_assignment` subject_type='product'）> `v_store_profile.brand_code`
    > 未分类；
  - 等级：`v_store_profile.level_code` > 未分级。
  - 查询失败 fail-open（未分类/未分级），不阻断提单。
- 历史单：只填空回填（brand/level），`source='backfill'`，审计；不覆盖已有快照。
- 门店改品牌/等级：历史单快照不变；新单用新值。

## 6. 工单筛选 / 计数（层级）

顺序：**状态 → 搜索/处理时间 → 等级 → 品牌（最末级）**。

| 维度 | 计数口径 |
|---|---|
| 状态 | 全局（只按 org） |
| 等级 | 状态 + 搜索 + 时间；**排除 level 与 brand**（brand 是下游最末级） |
| 品牌 | 状态 + 搜索 + 时间 + **等级**；**排除 brand** |
| 未分类品牌 | 品牌上游（状态+搜索+时间+等级） |
| 未分级 | 等级上游（状态+搜索+时间） |
| `showFilter` | 全局判断，搜索/筛选不会让整行胶囊消失 |

- 前端 `countsQuery = ticketQuery({...filters, brand:''})`（含 level）：
  - 点品牌：只刷新列表，不再拉计数；
  - 点等级：列表 + 计数都刷新（品牌计数包含等级）；
  - 搜索/状态/时间：列表 + 计数刷新。
- `GET /tickets/counts` 返回 `status` + `brand`（options/unclassified/showFilter/degraded）
  + `level`（options/unleveled/showFilter/degraded）。
- 工单列表/详情/导出新增「门店等级」；筛选参数 `level=<code>` / `__unleveled__`。

## 7. 契约 / 门禁 / 迁移顺序

- aftersales manifest `dataDependencies` 增 `data.v_store_profile`、`data.v_store_level_registry`；
  保留 `data.v_brand_registry` / `data.v_brand_assignment`（product）。
- B13 lock 登记新视图列集；B14 所有查询带 org。
- data 057 先于 aftersales 012 运行时；视图缺失时品牌/等级解析 fail-open，工单提交不失败。
- data 模块表数 +3（`store_level_registry` / `store_profile` / `store_profile_audit`），
  `module.test.ts` 穷举清单同步；视图不计入基表清单。
- `data:store` 权限进 data manifest，宿主 fan-out；部署后要在角色页授权。

## 8. 脚本

- `scripts/seed-brand-assignment.mjs` 改写到 `store_profile`（brand 部分）；产品级 brand 不再由它写。
- `scripts/backfill-ticket-brand.mjs` 更新为：product 品牌从 `v_brand_assignment`、store 品牌从
  `v_store_profile`；只填空。
- 新增 `scripts/backfill-ticket-level.mjs`：只填空级别，审计 `profile.backfill`。
- 现有生产 309 条 store 级品牌由迁移复制；不需重跑脚本。

## 9. 测试

- data 迁移：幂等；store 级品牌复制后从 `brand_assignment` 删除；视图列集/FK；表数。
- data API：PUT 校验/清空/锁定/审计；import dry-run/apply/未知码/重复/locked/上限；
  等级字典 create/update/disable；`data:store` 403。
- aftersales：`/stores` tag、options/coverage；提单快照品牌/等级；fail-open；
  历史回填只填空；工单筛选/计数层级（等级/品牌交叉）；0/1/N；导出列。
- Console：门店页签只读/可编辑、dry-run 预览、导入错误、覆盖率、等级字典；
  工单页等级胶囊 + 品牌最末级计数。
- E2E：门店页签编辑品牌/等级 → 新工单快照 → 工单筛选/计数/导出。

## 10. 明确不做

- 不给 `data.dim_branch` 加品牌/等级列（发布快照会覆盖）。
- 不硬编码 A/B/C 等级；不区分商品级等级（store-level only）。
- 不把门店画像放 platform schema（模块读不到）。
- 不用 `data:manage` 一把梭；不保留 store 级品牌在 `brand_assignment` 的第二事实源。
- 不做自动等级计算（手工配置为主；`source/locked` 留 seam）。

## 11. 流程

1. 本文 + issue。
2. data 057 + 迁移 + 视图 + B13 lock + `data:store`。
3. data API（profile/import/levels）+ 测试。
4. aftersales `/stores` tag/options/coverage、012 快照、解析/回填、筛选/计数/导出。
5. Console 门店页签 + 工单等级胶囊。
6. 测试/UI 验收/部署；上线后等级字典为空，需先维护等级再导入门店。
