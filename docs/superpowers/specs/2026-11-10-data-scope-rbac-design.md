# 数据范围 RBAC：岗位角色 + 品牌/门店/品类 scope（设计）

> **状态：Phase 1 代码已实现（2026-11-11，PR 见 §7.2）；Phase 2/3 待上线。**
> 设计已确认（2026-11-10，用户拍板 D1–D4）；2026-11-10 按 `data-analysis` 口径修订。
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

### 1.1 迁移源：Casdoor 已够（已实测）

`data-analysis` 的正式授权在 Casdoor `sso.shanhaiyiguo.com`（与 `sso.hookflow.cn` **同一实例**，
同一 IP `113.249.101.33`）的 `shanhai` org。`scripts/configure-casdoor-roles.sh` 确认：

- **5 个职能角色**：`总经理` / `财务总` / `战区总` / `小区经理` / `采购负责人`；
  permission resources = 全部能力点（品牌/品类/字段/门禁/看板）。
- **22 个范围角色**：每个一级/二级区域 + `全店`；permission resources = `范围|X`。

合计 **27 个角色 / 75 条成员**——就是我们 2026-11-10 在 Casdoor 读到的那一组。

`data-analysis` 的 `roles` 表（`boss/zone_manager/manager/buyer/finance`）是**另一层 UI/默认值/
部门映射**，不是 Casdoor 的授权角色。迁移源以 **Casdoor 的 27 角色 / `permission.resources` /
`Role.Users`** 为准；`data-analysis` DB 只在需要 `maps_branch_group`/`category_group` 原始投影时
使用（本设计改用平台 `dim_region` / item 维重建，不依赖它）。

### 1.2 data-analysis 的参考口径（2026-11-10 代码库核对）

| 维度 | data-analysis 定义 |
|---|---|
| Casdoor 授权角色 | **5 职能**（`总经理`/`财务总`/`战区总`/`小区经理`/`采购负责人`）+ **22 范围**（`范围|X`）；见 `scripts/configure-casdoor-roles.sh` |
| `roles` 表（UI/默认层） | `boss/zone_manager/manager/buyer/finance`；只作显示/默认/birthright，**不是** Casdoor 授权源 |
| 实际 permission resources | 5 职能角色当前都带全部能力点（含 `字段|成本可见`、`门禁|管理台`、`看板|*`）；新设计成本照旧全给，门禁/看板另定（见 §3.1） |
| `roles` 表默认范围（参考） | boss/zone_manager/finance：全店/全品牌/全品类 + 成本可见；manager：全店/全品牌/全品类、无成本；buyer：全店/全品牌 + 默认品类 `水果`、无成本 |
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

1. 新系统只有 **5 个职能角色**（总经理/财务总/战区总/小区经理/采购负责人）；22 个 `范围|*` 角色不建角色，转成 store scope；
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
| 岗位角色 | Casdoor Role | **5 个职能角色**：`总经理` / `财务总` / `战区总` / `小区经理` / `采购负责人`（`roles` 表的 `boss/zone_manager/manager/buyer/finance` 只是 UI/默认层别名） |
| 动作权限 | 平台 manifest 码 | `data:query`；成本角色 `data:cost`；`data:create`/`data:precise` 按需；`tenant:admin` 只给明确管理员 |
| 数据范围 | `data.scope` + `data.scope_assignment` | `brand` / `store` / `category`；可层级、可 `all` |

**角色默认动作（成本照旧；按 Casdoor 实际 permission resources）**：

| 角色（Casdoor 职能角色） | 平台码 |
|---|---|
| `总经理` / `财务总` / `战区总` / `采购负责人` | `data:query` + `data:cost` |
| `小区经理` | `data:query`（实际 Casdoor 权限里没有 `字段|成本可见`，照旧保留） |

> **2026-11-10 用户拍板「照旧」**：按 Casdoor 实际 permission resources 保留成本口径——
> `总经理/财务总/战区总/采购负责人` 有 `字段|成本可见` → `data:cost`；`小区经理` 没有。
> `门禁|管理台` 只有 `总经理` 有，仍不映射成 `tenant:admin`；`看板|*` 二期。
> 迁移 dry-run 只列 `门禁`/`看板` 差异。

**旧 Casdoor 角色 → 新模型**：

| 旧 Casdoor | 新 |
|---|---|
| 5 个职能角色（总经理/财务总/战区总/小区经理/采购负责人） | **1:1 保留为 5 个新职能角色**；成员迁入 |
| 22 个 `范围|*` 角色（含 `全店`） | **不建角色**；转成 `store` scope + user-level assignment |
| 5 职能角色 permission 里的 `品牌|*` / `品类|*` | role-level `brand` / `category` scope |
| `字段|成本可见` | 平台码 `data:cost`（总经理/财务总/战区总/采购负责人；小区经理没有，照旧） |
| `门禁|报表中心` | 平台码 `data:query`（所有数据职能角色） |
| `门禁|管理台` | 不映射；`tenant:admin` 另行指定 |
| `看板|*` | 二期：报表可见性（资产 ACL `scope` 受让方） |

> `data:manage` / `tenant:admin` 不来自旧角色；它们是管理身份，单独授予，并**绕过数据范围**
> （管理面需要看全量；与资产 ACL 的管理员代管同口径）。

**岗位自动授予（birthright）**：采用 data-analysis 的 `dept_role_mapping` 思路，
按 `platform.org_node` 的部门名映射到 **5 个职能角色**（总经办/运营总/老板→总经理；
财务→财务总；战区/区域/大区→战区总；采购/业务/品类→采购负责人；小区/门店/店长→小区经理；
未匹配→待配置，不默认最高权限）。首版可由迁移脚本/seed 落地，后续再做定时同步。

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

平台侧物化（2026-11-10 实测数据面）：

- `stg_lemeng_item` 已有 `item_category_id` / `item_category_parent_id` /
  `item_category_level` / `item_category_name`；**level=1 的根类别名正好是 data-analysis
  `category_path` 的首段**：`生鲜 / 标品 / 废弃档案 / 广西柳州 / 包装耗材 / 运费/仓储用耗材`
  （3120/64188 实测；64188 无 `广西柳州` 根）。
- 因此**不要按叶子 `item_category_name` 或 `item_department_name` 直接映射**；正确做法是从
  `item_category_id` 沿 `parent_id` 向上走到 `level=1`，取根类别名 `top_category_name`，再查
  受控映射 seed `dim_category_group_map(top_category_name, category_group)`：
  - `生鲜` → 水果
  - `标品` / `废弃档案` / `广西柳州` → 标品
  - `包装耗材` / `运费/仓储用耗材` → 耗材
  - 其他 → 其他
- 物化：`dim_item_latest`（或新 `dim_item`）增加 `top_category_name` / `category_group`；
  由最新快照的类别树 join 得到。若源以后提供 `category_path`，可直接用；当前不需要改契约。
- 质量门禁：
  - dbt test：每个 level=1 根类别必须在 `dim_category_group_map` 中有映射
    （`assert_dim_item_category_root_mapped`，**硬失败**，防止新根静默落 `其他`）；
  - 监控 `category_group='其他'` 的数量（`warn_category_group_other`）；非 0 或增长 ⇒ 告警并补映射；
  - 映射 seed 走 PR 评审，**不在多处 SQL 里写 CASE**。

**2026-11-11 真机实测（shanhai 数据面）——祖先链缺口（issue #1913）**：

`stg_lemeng_item` 只带商品**自己被指派的类别**（id/parent_id/level/name），中间层节点
（level 2–4）若没有商品直接挂它，就**不在任何快照里出现** ⇒ 沿 `parent_id` 走不到根：

- 类别 281，其中 **77 个**（level 3: 36 / 4: 29 / 5: 12）`top_category_name` 为 null；
- 涉及 **1,828 个在售商品（4.3%）**，落 `category_group='其他'`；
- 源契约无 `category_path` / `parent_name`（`contracts/common/lemeng.item.json` 已核）。

处置：`assert_dim_item_category_root_resolved` 定为 **warn**（不是 error）——后果是 fail-closed
（这些商品对 水果/标品/耗材 scope 的人不可见，admin/全店不受影响），而 error 会让整个 lemeng 域
物化失败、冻结全部新鲜度水位（同 `warn_region_unregistered` 的裁决）。补数路径：接乐檬品类树或
一次性导入祖先节点（#1913）。**不可按 `item_department_name` 映射**：实测同名部门跨多个根
（root=标品/废弃档案 都有 dept=零食部）。
- 权限只用 `category_group`；细分类别树保留做下钻/分析，不作为授权维度。

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
- `data.query_audit` 增加 `scope_plan jsonb` / `scope_denial text`（**043 迁移，2026-11-11 已落地**）：
  shadow 也落（记录「本来会裁成什么样」），denial 与成功查询都能按人/按指标聚合；
- scope 变更落 `data.scope_audit`（新建/修改/assignment），管理面 `GET /scopes/audit` 只读回溯。

### 5.5 管理面

- `GET/POST/PUT/DELETE /data/scopes`（`data:manage`）；
- `PUT /data/scopes/:id/assignments`（role/user 整组替换）；
- `GET /data/scopes/effective?user=&roles=`（预览有效 scope，dry-run）；
- 全部写后回读 + 审计；selector 值必须存在于受控维表。
- **已落地（2026-11-11）**：`modules/data/domain/scope-admin.ts`（判定链单实现）+
  `routes/scopes.ts`（HTTP 形状映射）+ manifest 六条声明。细节取舍：
  - brand selector 不允许 `all`（运行期只读 `system_book`，`all` 会造成「看起来配了、
    其实恒 no_brand_scope」的坏门，配置面直接拦）；
  - `subject_id` 不做 Casdoor 存在性校验（模块拿不到用户/角色清单，B1）——配错主体是
    惰性的（解析时空匹配），无越权面；
  - preview 的 granted/effective 按 (kind, JSON 形状) 去重——SQL 按 assignment 行返回，
    user+role 双路命中同一 scope 会重复；
  - UI（2026-11-11 落地）：console 第四页签「数据范围」（`data:manage` 才出现，菜单过滤只是
    入口姿态、API 门卫才是真闸）——scope CRUD 表单（按 kind 切换输入面）+ assignment
    整组替换 Drawer + 有效范围预览卡；配置错值由服务端点名回显（`VALUE_NOT_IN_DIMS` + detail）。

## 6. 迁移（data-analysis 只读，一次性）

### 6.1 迁移源与用户对齐

- **源 = Casdoor**（`sso.shanhaiyiguo.com` / `sso.hookflow.cn` 同一实例，org `shanhai`）：
  - 27 个角色（5 职能 + 22 范围）；
  - 每个角色的 `permission.resources`；
  - `Role.Users`（75 条成员）。
- **不需要 data-analysis DB** 才能拿到角色/成员；DB 仅作可选的交叉核验
  （`maps_branch_group`/`category_group` 原始投影）。
- 用户按企微 `userid` 对齐；D4 的 4 个旧账号别名（`DongJiJuan_1`/`Dongjijuan` → `DongJiJuan`）
  在 Casdoor `shanhai` org 中已确认是同一人；
- 旧 `shanhai` org 全程**只读**；新 `shanhaiyiguo-org` 是写入目标。

### 6.2 Casdoor 角色/资源 → 新模型

| Casdoor（`shanhai`） | 新 |
|---|---|
| 5 个职能角色（总经理/财务总/战区总/小区经理/采购负责人） | **1:1 保留为 5 个新职能角色**；`Role.Users` 迁入 |
| 22 个 `范围|X` 角色（含 `全店`） | **不建角色**；转成 `store` scope + user-level assignment |
| 职能角色 permission 里的 `品牌|*` | role-level `brand` scope（`system_book`） |
| 职能角色 permission 里的 `品类|*` | role-level `category` scope（`category_group`） |
| 职能角色 permission 里的 `字段|成本可见` | 平台码 `data:cost`（5 个职能角色都保留，照旧） |
| `门禁|报表中心` | 平台码 `data:query`（所有数据职能角色） |
| `门禁|管理台` | 不映射；`tenant:admin` 另行指定 |
| `看板|*` | 二期：报表可见性（资产 ACL `scope` 受让方） |

### 6.3 范围 selector 生成

- `范围|全店` → `{ "all": true }`（D3）；
- 其余 `范围|*`：按名字查平台 `dim_region`：
  - 命中 `region_name`（level=2）⇒ `{ "region_name": [name] }`
  - 命中 `region_l1`（level=1）⇒ `{ "region_l1": [name] }`
  - 未命中 ⇒ dry-run 报错，人工确认（不猜）；
  - 2026-11-10 已核：22/22 全部命中；部分二级区只在单账套（按名字匹配自动落到实际账套）；
- `品牌|*`：按 `dim_brand` 映射到 `system_book`；
- `品类|*`：直接映射到 `category_group`（水果/标品/耗材）；不再猜 `item_department_name`/`item_category_name`。

### 6.4 迁移脚本

一次性脚本（`scripts/migrate-data-scopes.mjs` 或 data 模块 CLI）：

1. 只读读 Casdoor `shanhai` org：角色、`permission.resources`、`Role.Users`；
2. 读平台 `dim_region` / `dim_brand` / `dim_item_latest(category_group)` 生成 selector；
3. 输出 dry-run：新角色、scope、assignment、无法映射的用户/资源、无 store scope 的用户、
   「实际 Casdoor 有 / 新设计不给」的差异清单（门禁/看板）；
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

### 7.1 Phase 0 dry-run（2026-11-10，只读 Casdoor）

- 源：`shanhai` **27 角色 = 5 职能 + 22 范围**；75 条角色成员（**29 个唯一用户**）。
- 目标：`shanhaiyiguo-org` 497 用户（237 禁用）。
- 成员：**29/29 唯一用户全部命中**（4 个旧别名 `DongJiJuan_1` / `Dongjijuan` → `DongJiJuan`）。
- 22 个 `范围|*`：**22/22** 映射到 `region_l1` / `region_name` / `all`；0 个未知 selector。
- 5 职能角色资源：0 个未知资源；成本实际为：总经理/财务总/战区总/采购负责人有，`小区经理` 没有。
- `门禁|管理台` 仅 `总经理` 有；按拍板不映射 `tenant:admin`。
- `看板|*` 二期；旧数据有两组带空格/不带空格的看板名，保留原样待映射。
- 两个异常需确认：
  - `functionalOnly`：`ccccccccccccctv`（有职能角色、无 store scope；D2 会拒绝；疑似测试号）。
  - `rangeOnly`：`DongJiJuan`（两个旧别名带来的 store scope，但无职能角色；D2 会拒绝；
    需确认是否补一个职能角色，或按无数据权限处理）。
- 匹配到的用户均非禁用；目标 237 个禁用用户不在角色成员中。

### 7.2 Phase 1 实施状态（2026-11-11）

已落地（分支 `feat/data-scope-enforcement-1883`）：

| 工件 | 落点 | 状态 |
|---|---|---|
| scope schema | `modules/data/migrations/042_data_scope.sql`（`scope` / `scope_assignment` / `scope_audit`） | ✅ |
| 解析/合并/谓词 | `modules/data/domain/scope.ts`（`loadEffectiveScopes` / `buildScopePlan` / `scopeModeOf`） | ✅ 单测 |
| 唯一执法点接线 | `authz.ts` `authorizeCore(..., scopePlan)` + `query-service.ts` + `toolbox/discovery.ts` | ✅ 单测 |
| 会话 `roles` | `SessionPayload.roles` + `signSession`/`verifySession` + 三条登录路 + 会话刷新重签 | ✅ 单测 |
| 品类物化 | `dbt/models/lemeng/marts/dim_item_category.sql` + `dim_item_latest` 补 `top_category_name`/`category_group` + 受控 seed `dim_category_group_map` + 2 条硬断言 + 2 条 warn 哨兵 | ✅ 真机已建（281 类；`其他` 4.3% 系祖先链缺口，见 #1913） |
| 一次性迁移 | `scripts/migrate-data-scopes.mjs`（dry-run 默认；`--apply` 写 DB + Casdoor 5 职能角色） | ✅ 真机已 apply + 回读（2026-11-11） |
| scope 管理端点 | §5.5：六条 `data:manage` 端点（list/effective/create/update/delete/assignments）+ selector 维表校验 + 写后回读 + audit | ✅ 后端（domain/scope-admin.ts + routes/scopes.ts） |
| 判定入审计 | `043_query_audit_scope.sql` + `audit-store.ScopeAudit`（shadow/enforce 都落） | ✅ 端到端测试（enforce 真拆 SQL / shadow 只记） |
| scope 管理 UI | console「数据范围」页签（`data:manage` 才出现）：scope CRUD + assignment 整组替换 Drawer + 有效范围预览卡 | ✅ `console/scopes/index.tsx` |

仍未做 / 上线顺序：

1. **真机验证**：dbt 已在 shanhai 数据面跑过（2026-11-11：`dim_item_category` 281 行，
   根映射/唯一性 PASS；祖先缺口见 #1913）；**迁移脚本 dry-run 仍未跑**——
   `--source-org shanhai --target-org shanhaiyiguo-org` 核对 29 用户/22 范围。
2. **上线顺序**：`DATA_SCOPE_MODE=off` → `shadow`（对照 data-analysis 抽样）→ `enforce`；
   切换要留审计。`shadow` 日志事件为 `data_scope_shadow`（含 filters/denial/applied）。
3. **`其他` 品类的授权口径**：`品类|*` 只展开 水果/标品/耗材（本文 §6.3），`其他` 商品对
   非管理员不可见；`warn_category_group_other` 负责让这个数量可见——若业务要求「至少一人能看
   `其他`」，需在此明确后改迁移脚本。
4. **`data:cost` 的迁移**：脚本按源 `permission.resources` 的 `字段|成本可见` 授予
   （2026-11-10 实测：小区经理无、其余 4 个有）；不按角色名硬编码。

## 8. 风险与已知边界

1. **Casdoor 是迁移源**：27 个角色 / `permission.resources` / `Role.Users` 都已可读；
   不需要 data-analysis DB 才能做角色/成员迁移；DB 仅作可选交叉核验。
2. **27 个角色就是 data-analysis 的授权层**：`configure-casdoor-roles.sh` 确认 5 职能 + 22 范围；
   `roles` 表的 `boss/zone_manager/manager/buyer/finance` 是另一层 UI/默认值，不要混用。
3. **`category_group` 来源已实测**：平台 item 源的 level=1 根类别名与 data-analysis
   `category_path` 首段一致；按 `parent_id` 树取 `top_category_name` + 受控 seed 映射即可，
   不需要给 item 契约加 `category_path`。新增根类别未映射时 dbt test 会红，不静默落 `其他`。
4. **成本/门禁/看板口径**：成本**照旧**——总经理/财务总/战区总/采购负责人有 `data:cost`，
   小区经理没有（按 Casdoor 实际资源）；`门禁|管理台` 只有总经理有，不映射成 `tenant:admin`；
   `看板|*` 二期。迁移 dry-run 只列门禁/看板差异。
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
  - `scripts/configure-casdoor-roles.sh`（**实际授权角色**：5 职能 + 22 范围；
    permission resources = 全部能力点 / `范围|X`）
  - `scripts/assign-roles-2026-08-19.sh`（角色成员的实际挂载）
  - `scripts/backfill-scope-resources.mjs`（`org_users.scope_resources` 投影；
    `品牌|/品类|/字段|/范围|` → `data-analysis:brand/category/field/branch:*`）
  - `docs/design/permission-architecture-longterm.md`（长期 PDP/PEP 提案，未实施）
  - `docs/ops/permission-boundary.md`（Casdoor/data-analysis 职责边界；`范围|X` 门店资源）
  - `docs/ops/permission-maintenance.md`（当前生产：Casdoor resources + `scope_resources` + RLS）
  - `database/migrations/072_permission_roles.sql`（`roles` 表 5 个 UI 默认 code；
    `data_permissions` 为 legacy，已 sunset）
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
