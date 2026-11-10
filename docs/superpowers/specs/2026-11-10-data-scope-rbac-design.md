# 数据范围 RBAC：岗位角色 + 品牌/门店/品类 scope（设计）

> **状态：设计已确认（2026-11-10，用户拍板 D1–D4）；2026-11-10 按 `data-analysis` 口径修订。**
> 关联 issue：#1883。旧系统只作为**迁移源**，迁移后冻结/废弃；新系统按本设计自建。
> 架构先行：实施中任何方向/范围调整，先改本文再动码。

## 0. 一句话

把旧系统「岗位 + 数据范围」的授权模型，在新系统重建为 **RBAC（岗位/平台码）+ ABAC（数据范围）**：
角色只留 5 个岗位；品牌/门店/品类作为一等 `data.scope`；`authorizeCore()` 是唯一执法点；
旧系统一次性只读迁移，之后新系统是唯一事实源。

## 1. 背景与已确认决策

新平台 `shanhaiyiguo-org` 是独立权限体系（模块码 + `authorizeCore`）。旧 `data-analysis`
系统已经有一套正确的数据范围定义（见 §1.2），本设计采用它的**角色/维度语义**，但执法仍在新平台
的 `authorizeCore`，不引入 Casbin。

**2026-11-10 用户确认**：

| # | 决策 |
|---|---|
| D1 | **品类 scope 对门店总量指标 = 拒绝**（fail-closed）——品类是商品维度，门店总量没有该维度。 |
| D2 | **没有门店 scope 的普通 `data:query` 用户 = 拒绝**；`data:manage`/`tenant:admin` 例外。 |
| D3 | **`范围|全店` = `all`**（该维度不裁）。 |
| D4 | **4 个旧账号**（`DongJiJuan_1`、`Dongjijuan`）**别名到 `DongJiJuan`**（同一人；旧账号均 `isForbidden`）。 |

### 1.1 一个必须修正的迁移源

此前从共享 Casdoor `sso.hookflow.cn/shanhai` 看到的 **27 个角色 / 75 条成员**，**不是
`data-analysis` 的角色层**。`data-analysis` 的真相在它自己的 DB/接口：

- `org_users.role_codes`（5 个岗位角色）
- `org_users.scope_resources`（Casdoor resource 投影）
- `maps_branch_group`（区域包 → branch_number）
- `dim_branch.first_level_region / second_level_region / branch_number`
- `dim_item.category_group`

**迁移源必须改为 `data-analysis` 的库/接口**；共享 Casdoor 27 角色只在确认与 `data-analysis`
同源时才使用。

### 1.2 data-analysis 的参考口径（2026-11-10 代码库核对）

| 维度 | data-analysis 定义 |
|---|---|
| 角色 | `boss`（老板/运营总）、`zone_manager`（战区主管）、`manager`（店长）、`buyer`（采购/业务）、`finance`（财务） |
| 角色默认范围 | boss/zone_manager/finance：全店/全品牌/全品类 + 成本可见；manager：全店/全品牌/全品类、无成本；buyer：全店/全品牌 + 默认品类 `水果`、无成本 |
| 品牌 | `system_book_code`（3120 熊喵鲜生 / 64188 品品甜） |
| 门店 | `first_level_region` / `second_level_region`（区域包）→ `branch_number`（跨账套复合键，如 `3120-0027`）；`范围|全店` = all |
| 品类 | **`dim_item.category_group` 三类**：水果 / 标品 / 耗材 / 其他 |
| 成本 | `field:cost` / `can_see_cost` |
| 岗位自动授予 | `dept_role_mapping` 按部门名映射角色（birthright） |
| 当前生产 | Casdoor resources → `org_users.scope_resources` → `get_user_perms`/claims → RLS；`data_permissions` 已 sunset |
| 长期方案 | `permission-architecture-longterm.md` 的 Casbin PDP **未实施**；本设计不引入 Casbin，仍用 `authorizeCore` 单一 PEP |

`category_group` 的权威映射（`150_dim_item_category_group.sql` / `067_category_three_class.sql`）：

```
category_path 首段 = 生鲜              → 水果
                   标品 / 废弃档案 / 广西柳州 → 标品
                   包装耗材 / 运费/仓储用耗材   → 耗材
                   其他                         → 其他
```

## 2. 目标与非目标

**目标**：

1. 新系统只有 **5 个岗位角色**（boss/zone_manager/manager/buyer/finance），不继承旧范围角色；
2. 数据范围作为一等实体：`brand` / `store` / `category` 三类 scope；
3. 所有查询面（`/query`、MCP、问数/chat、报表、下钻）在 `authorizeCore()` 统一裁；
4. 旧系统一次性迁移；迁移后冻结，不做双写；
5. shadow → enforce，可观测、可回滚。

**非目标**：

- `看板|*` 报表可见性（二期，用资产 ACL/报表映射）；
- `data:precise`（旧体系无对应物，未拍板）；
- 旧系统继续写；
- 引入 OPA/Zanzibar/Postgres RLS/Casbin 第二套权限系统；
- 前端/词表/报表渲染承担安全职责；
- 跨租户数据范围。

## 3. 模型

### 3.1 身份 / 角色 / 动作

| 概念 | 归属 | 说明 |
|---|---|---|
| 用户 | Casdoor `shanhaiyiguo-org` | 同一企微通讯录；按 `userid` 对齐 |
| 岗位角色 | Casdoor Role | **5 个 data-analysis 角色**：`boss` / `zone_manager` / `manager` / `buyer` / `finance` |
| 动作权限 | 平台 manifest 码 | `data:query`；成本角色 `data:cost`；`data:create`/`data:precise` 按需；`tenant:admin` 只给明确管理员 |
| 数据范围 | `data.scope` + `data.scope_assignment` | `brand` / `store` / `category`；可层级、可 `all` |

**角色默认动作（对齐 data-analysis）**：

| 角色 | 中文名 | 平台码 |
|---|---|---|
| `boss` | 老板/运营总 | `data:query` + `data:cost` |
| `zone_manager` | 战区主管 | `data:query` + `data:cost` |
| `finance` | 财务 | `data:query` + `data:cost` |
| `manager` | 店长 | `data:query`（无成本） |
| `buyer` | 采购/业务 | `data:query`（无成本；默认品类 `水果`） |

**旧 Casdoor 中文角色 → 新角色**（仅用于迁移映射；旧 27 角色不是新模型）：

| 旧 | 新 | 备注 |
|---|---|---|
| `总经理` | `boss` | |
| `战区总` | `zone_manager` | |
| `采购负责人` | `buyer` | |
| `财务总` | `finance` | |
| `小区经理` | **待定** | data-analysis 5 角色无此职位；按 data-analysis `role_codes` 导出结果决定映射到 `zone_manager` 还是 `manager`，不猜 |
| `范围|*` | 不是角色 | 转成 `store` scope assignment |

> `data:manage` / `tenant:admin` 不来自旧角色；它们是管理身份，单独授予，并**绕过数据范围**
> （管理面需要看全量；与资产 ACL 的管理员代管同口径）。

**岗位自动授予（birthright）**：采用 data-analysis 的 `dept_role_mapping` 思路，
按 `platform.org_node` 的部门名映射角色（总经办/运营总/老板→boss；战区/区域/大区→zone_manager；
店长/门店→manager；采购/业务/品类→buyer；财务→finance；未匹配→待配置，不默认最高权限）。
首版可由迁移脚本/seed 落地，后续再做定时同步。

### 3.2 数据范围

`data.scope`：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigserial | |
| `org` | text | 租户（`casdoor_org`） |
| `name` | text | 人类可读名（如 `东部战区`、`熊喵鲜生`、`水果`） |
| `kind` | text | `brand` / `store` / `category` |
| `selector` | jsonb | 受控 selector，见下 |
| `legacy_label` | text null | **仅迁移溯源**；迁移后不参与判定 |
| `created_at` / `updated_at` | timestamptz | |

`data.scope_assignment`：

| 列 | 说明 |
|---|---|
| `org` | 租户 |
| `subject_type` | `role` / `user` |
| `subject_id` | Casdoor role 短名 / Casdoor user name |
| `scope_id` | → `data.scope(id)` |
| 主键 | `(org, subject_type, subject_id, scope_id)` |

**selector 闭集**（只允许这些键；值只来自受控维表）：

```json
{ "system_book": ["3120"] }          // brand
{ "region_l1": ["东部战区"] }        // store（一级区域）
{ "region_name": ["东部一区"] }      // store（二级区域）
{ "all": true }                      // store / category 全量
{ "category_group": ["水果"] }       // category（水果/标品/耗材/其他）
```

- `brand` scope 只允许 `system_book`；
- `store` scope 只允许 `region_l1` / `region_name` / `all`；
- `category` scope 只允许 `category_group` / `all`；
- 配置期校验 selector 值存在于 `dim_brand` / `dim_region` / `dim_item.category_group`；
  不存在 ⇒ 拒绝配置（fail-closed）。

### 3.3 有效范围

```
有效 scope = 用户直接 assignment ∪ 用户所属角色的 assignment
同 kind：并集（union）；任一 all ⇒ 该 kind 不裁
不同 kind：AND（brand AND store AND category）
```

**默认拒绝**（对普通 `data:query` 用户）：

- 没有 `store` scope ⇒ 拒绝（D2）；
- 没有 `brand` scope ⇒ 拒绝（与 D2 同口径；迁移会为 5 个岗位角色配 brand）；
- 没有 `category` scope ⇒ 对 item 粒度指标拒绝（与 D1 同口径；迁移会为岗位角色配 category）；
- `data:manage` / `tenant:admin` 例外：不裁。

> 迁移必须保证每个业务用户至少有一个 brand/store/category scope；dry-run 会列出缺口，缺口先补再切 enforce。
>
> **注**：D1/D2 只明确「store 无 scope 拒绝」「品类对门店总量拒绝」；**brand / category 无 scope
> 也按拒绝**，是同一最小权限口径的延伸，不是额外拍板。若 Phase 0 评估认为应改为
> 「无 brand = 全品牌 / 无 category = 全品类」，只改这一段；**默认按拒绝**。

## 4. 数据模型与 SQL（基于现有维表）

### 4.1 品牌 = `system_book`

`dbt/seeds/dim_brand.csv`：

```
3120,熊喵鲜生
64188,品品甜
```

事实表/门店维都有 `system_book`；直接：

```sql
AND system_book IN ('3120', '64188')
```

### 4.2 门店 = `region_l1` / `region_name`

`dbt/seeds/dim_region.csv`（`system_book, region_id, region_name, region_l1, level`）：

- 二级 `region_name`：`东部一区`、`中部二区`…
- 一级 `region_l1`：`东部战区`、`广西大区`、`贵州宣威大区`、`其他门店`、`其余门店1`…
- 根 `所有区域` = level 0 ⇒ `all`

`dim_lemeng_branch` 已 join 出 `system_book / branch_num / region_id / region_name / region_l1`。

SQL（**复合键**，防两账套门店号串号）：

```sql
AND (system_book, branch_num) IN (
  SELECT system_book, branch_num
    FROM dim_lemeng_branch
   WHERE org = '<requester.orgId>'
     AND (region_l1 IN (...) OR region_name IN (...))
)
```

`all` ⇒ 不加 store 谓词。

> data-analysis 用 `branch_number`（`system_book-branch_num`）作为跨账套复合键；
> 平台现有事实表是 `(system_book, branch_num)` 两列，本设计用行值复合键等价表达；
> 不要退化成裸 `branch_num`。

### 4.3 品类 = `category_group`（三类，单独建）

**权威定义来自 data-analysis**：`dim_item.category_group`（水果 / 标品 / 耗材 / 其他），
不是原始 `item_department_name` / `item_category_name`。

旧 `品类|水果` / `品类|标品` / `品类|耗材` **直接映射**到 `category_group`，不需要猜部门/品类层级。

平台侧需要把 `category_group` 物化到 item 维：

- 首选：在 item 契约/staging 增加 `category_path`（若源提供），按
  `150_dim_item_category_group.sql` 的 CASE 生成 `category_group`；
- 若新 item 源没有 `category_path`：增加一份**受控映射规则**
  （`data.category_group_rule` 或 dbt seed），把 `item_category_name` / `item_department_name`
  映射到 水果/标品/耗材/其他；映射必须业务确认，不猜；
- `dim_item_latest` 增加 `category_group` 列（以及可选的 `top_category`），供 scope 解析直接读。

SQL（**复合键**）：

```sql
AND (system_book, item_num) IN (
  SELECT system_book, item_num
    FROM dim_item_latest
   WHERE org = '<requester.orgId>'
     AND category_group IN (...)
)
```

**只对商品粒度指标生效**（`item_num` 在 `grainDimsOf(metric)` 里）。门店总量指标没有商品维度
⇒ 按 D1 **拒绝**（`range_dimension_missing`），不静默放行。

### 4.4 维度可用性判定

`grainDimsOf(metric)`（= `metric.groupBy` 拆分）决定指标能接受哪些 scope：

| scope kind | 指标粒度必须包含 | 否则 |
|---|---|---|
| brand | `system_book` | 拒绝（`range_dimension_missing`） |
| store | `branch_num`（首选）或 `region_l1`/`region_name` | 拒绝 |
| category | `item_num`（首选）或 `category_group` | 拒绝（D1） |

- 复合键要求 `system_book` 在粒度里；没有 ⇒ 拒绝（防跨账套串号）；
- 指标粒度含 `region_l1`/`region_name` 但无 `branch_num` 时，可直接用 region 谓词；
- 指标粒度含 `category_group` 但无 `item_num` 时，可直接用 category 谓词。

## 5. 执法与接线

### 5.1 单一执法点

`modules/data/domain/authz.ts` 的 `authorizeCore()`：

- 新增 `scopeFilters: string[]` 参数（与现有 `extraFilters` 同位置追加到 `filters`）；
- `authorize()` / `toolbox/discovery.ts` 的调用方传入同一份 `scopeFilters`；
- `query-service.ts` 在加载 catalog 时一并解析有效 scope，算出 filters；
- 所有查询面（`/query`、MCP、chat、报表、下钻）自动生效。

### 5.2 会话身份补 `roles`

`data.scope_assignment` 有 role-level assignment，而当前 `Requester` 只有 `scopes`、没有 `roles`。
新增：

- `SessionPayload` / `Identity` 增加 `roles?: string[]`；
- `session-middleware` 在登录/刷新时写入 `user.roles`（短名归一）；
- `pat-auth.ts` / `wecom-channel-auth.ts` 的 identity 同样带 `user.roles`；
- `modules/data/routes/context.ts` 的 `Requester` 增加 `roles: string[]`（旧会话缺省 `[]`）；
- 旧会话（无 `roles`）在 5 分钟 scopes 刷新后自然补上；兼容期内 role-level scope 不生效，
  但迁移会同时给用户直接 assignment 兜底（见 §6.4），不会出现空窗。

### 5.3 解析顺序

```
1. 从 data.scope / assignment 取用户 + 角色的有效 scope
2. 按 kind 合并：同 kind 并集；all 胜；不同 kind AND
3. 对每个 kind：
   - 指标粒度有对应维度 ⇒ 生成 SQL 谓词
   - 没有 ⇒ 拒绝（range_dimension_missing）
4. 无 scope（非管理员）⇒ 拒绝（no_scope）
```

### 5.4 模式开关与审计

`DATA_SCOPE_MODE`（env，**显式三态**）：

| 值 | 行为 |
|---|---|
| `off` | 不解析、不裁（仅过渡/本地；生产不得长期使用） |
| `shadow` | 解析并记录「将裁掉/将拒绝」，**不拦**；用于对照 data-analysis |
| `enforce` | 真正裁/拒绝 |

- 生产上线顺序：`off` → `shadow` → `enforce`；每次切换都留审计；
- `data.query_audit` 增加 `scope_plan jsonb` / `scope_denial text`（迁移）；
- scope 变更落 `data.scope_audit`（新建/修改/assignment）。

### 5.5 管理面

- `GET/POST/PUT/DELETE /data/scopes`（`data:manage` 或 `tenant:admin`）；
- `PUT /data/scopes/:id/assignments`（role/user 整组替换）；
- `GET /data/scopes/effective?user=`（预览有效 scope，dry-run）；
- 全部写后回读 + 审计；selector 值必须存在于受控维表。

## 6. 迁移（data-analysis 只读，一次性）

### 6.1 迁移源与用户对齐

- **源 = data-analysis 的 DB/接口**：`org_users.role_codes`、`org_users.scope_resources`、
  `maps_branch_group`、`dim_branch`、`dim_item.category_group`；
- 不再以共享 Casdoor `sso.hookflow.cn/shanhai` 的 27 角色/75 成员为迁移基线；
- 用户按企微 `userid` 对齐；D4 的 4 个旧账号别名仅在 data-analysis 导出中存在时使用；
- 旧 `shanhai` org 全程**只读**；新 `shanhaiyiguo-org` 是写入目标。

### 6.2 data-analysis 角色/范围 → 新模型

| data-analysis | 新 |
|---|---|
| `role_codes` 中的 `boss/zone_manager/manager/buyer/finance` | 5 个 Casdoor 岗位角色；成员迁入 |
| `scope_resources` / `get_user_perms` 的 `data_scope.brands` | `brand` scope（`system_book`） |
| `data_scope.branch_nums` / `maps_branch_group` | `store` scope（区域包或 branch 复合键；`全店` = all） |
| `data_scope.categories` | `category` scope（`category_group`） |
| `fields.cost` / `field:cost` | 平台码 `data:cost` |
| `data-analysis:admin` / 门禁 | 不映射到数据范围；`tenant:admin` 另行指定 |
| 旧 `看板|*`/`view-board:*` | 二期：报表可见性（资产 ACL `scope`） |

### 6.3 范围 selector 生成

- `范围|全店` / `branch_nums=["*"]` → `{ "all": true }`（D3）；
- 区域包名（一级/二级）→ `{ "region_l1": [name] }` / `{ "region_name": [name] }`；
- 直接 `branch_number`（`system_book-branch_num`）→ `{ "branch": [number] }`（**可选 selector**；
  若使用，解析成 `(system_book, branch_num)` 复合键）；
- `brands`（`system_book_code`）→ `{ "system_book": [code] }`；
- `categories`（`category_group`）→ `{ "category_group": [group] }`；
- 任一 selector 值不在对应维表 ⇒ dry-run 报错，人工确认（不猜）。

### 6.4 迁移脚本

一次性脚本（`scripts/migrate-data-scopes.mjs` 或 data 模块 CLI）：

1. 只读导出 data-analysis 的 `org_users.role_codes` / `scope_resources` / `maps_branch_group`；
2. 读平台 `dim_region` / `dim_brand` / `dim_item_latest(category_group)` 生成 selector；
3. 输出 dry-run：新角色、scope、assignment、无法映射的用户/资源、无岗位角色的用户、
   `小区经理` 映射待定项；
4. 人工确认后 `--apply`；
5. 写后回读：每个目标用户的有效 scope 预览；
6. 旧系统置只读/冻结（流程动作，不改 Casdoor）。

**兜底**：迁移同时给每个业务用户写 **user-level assignment**（brand/store/category），
即使 `roles` 还没进会话，enforce 也不会出现空窗；role-level assignment 作为后续维护面。

## 7. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| Phase 0 | 本文 + data-analysis 只读导出 + 映射 dry-run | 导出字段可读；`category_group` 映射确认；`小区经理` 映射定稿 |
| Phase 1 | `data.scope`/`assignment`；`dim_item_latest` 补 `category_group`；会话 `roles`；scope 管理端点 | schema/端点/审计；旧系统零写入 |
| Phase 2 | `authorizeCore` scopeFilters + `DATA_SCOPE_MODE=shadow`；对照 data-analysis 抽样 | shadow 日志与 data-analysis 结果一致 |
| Phase 3 | `enforce`；迁移完成；scope 管理 UI（可选） | 授权矩阵全绿；无 scope 拒绝；管理员例外 |
| Phase 4 | `看板|*` 报表可见性；`data:precise`（如拍板） | 另立 spec |

**授权矩阵（最小集）**：

- 有 store scope 的用户：只看该区域门店；跨区域不可见；
- `all`：不裁；
- 无 store scope 的普通 `data:query`：拒绝；
- `data:manage`/`tenant:admin`：不裁；
- brand scope：只看到对应 `system_book`；
- category scope：`category_group` 在 item 粒度指标生效；门店总量指标拒绝（D1）；
- 复合键：同 `branch_num` 在两账套不会串；
- `scopeFilters` 注入的 SQL 在 `authorizeCore` 的输出里可见，且不改变既有 `subject` 钉死。

## 8. 风险与已知边界

1. **data-analysis DB/接口访问**：迁移源在其 DB/接口；需只读导出 `org_users.role_codes` /
   `scope_resources` / `maps_branch_group`；没有访问就不能做真实 dry-run。
2. **共享 Casdoor 27 角色不是 data-analysis 角色层**：不要拿之前的 27 角色/75 成员当迁移基线；
   先确认 data-analysis 的实际 `role_codes`。
3. **`category_group` 来源**：data-analysis 用 `category_path` 首段；平台 item 契约当前没有
   `category_path`。优先补列；否则建受控映射规则（`item_category_name`/`item_department_name` →
   `category_group`），必须业务确认，不猜。
4. **`小区经理` 映射**：data-analysis 5 角色无此职位；按导出结果决定 `zone_manager` 或 `manager`，
   或另立 `area_manager` 角色；不默认。
5. **`dim_item_latest` 补列**：需改 dbt 模型并重跑数据面；列缺失时 category scope 应拒绝而不是放行。
6. **`dim_lemeng_branch` 无契约**：`dimensions.yml` 已登记战区层级缺口；scope 解析可直接读该表，
   但语义层声明需后续补契约/稳定视图。
7. **会话 `roles` 兼容**：旧会话无 `roles`；迁移的 user-level 兜底保证 enforce 不空窗。
8. **两账套同名区域/门店号**：一律复合键 `(system_book, branch_num)` / `(system_book, item_num)`，
   禁止裸 `branch_num`/`item_num`。
9. **`data:manage`/`tenant:admin` 绕过**：必须确认这些码没有发给业务岗位；发错等于越权。
10. **旧系统冻结**：迁移后旧 data-analysis 不再写；如需并行期，必须明确“只读”窗口，禁止双写。
11. **`看板|*`/`data:precise`**：不在本期；`看板` 不进行级谓词。
12. **性能**：scope 子查询是小表；如出现慢查询，给 `dim_lemeng_branch(system_book,branch_num)`
    与 `dim_item_latest(system_book,item_num)` 补索引/物化 scope 值。
13. **默认拒绝的可用性**：迁移 dry-run 必须列出没有 brand/store/category 的业务用户；缺口先补。

## 9. 关联

- issue：#1883
- **data-analysis 参考**（`MYTech-Co-LTD/data-analysis`）：
  - `docs/design/permission-architecture-longterm.md`（长期 PDP/PEP 提案，未实施）
  - `docs/ops/permission-boundary.md`（Casdoor/data-analysis 职责边界；`范围|X` 门店资源）
  - `docs/ops/permission-maintenance.md`（当前生产：Casdoor resources + `scope_resources` + RLS）
  - `database/migrations/072_permission_roles.sql`（5 角色 + data_permissions 维度）
  - `database/migrations/150_dim_item_category_group.sql` / `067_category_three_class.sql`
    （`category_group` 三类映射）
  - `database/migrations/199_scope_packs_dim_truth.sql` / `200_get_user_perms_scope_resources.sql`
    （区域包 → branch_number；`scope_resources` → `data_scope`）
- 既有 spec：`2026-10-30-org-as-platform-primitive-design.md`（组织原语）、
  `2026-10-17-column-and-value-level-security-design.md`（列/值级）、
  `2026-11-01-mobile-first-business-surface-design.md` §4（资产 ACL）、
  `2026-11-10-platform-superadmin-and-cross-module-authz-design.md`（A1）
- 平台数据模型：`dbt/seeds/dim_brand.csv`、`dbt/seeds/dim_region.csv`、
  `dbt/models/lemeng/marts/dim_lemeng_branch.sql`、`dbt/models/lemeng/staging/stg_lemeng_item.sql`、
  `dbt/models/lemeng/marts/dim_item_latest.sql`、`dbt/semantics/dimensions.yml`
- 执法/接线：`modules/data/domain/authz.ts`、`modules/data/domain/query-service.ts`、
  `modules/data/domain/toolbox/discovery.ts`、`modules/data/routes/context.ts`、
  `apps/server/src/session-middleware.ts`、`apps/server/src/pat-auth.ts`、
  `apps/server/src/wecom-channel-auth.ts`
