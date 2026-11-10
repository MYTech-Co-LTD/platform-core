# 数据范围 RBAC：岗位角色 + 品牌/门店/品类 scope（设计）

> **状态：设计已确认（2026-11-10，用户拍板 D1–D4）；实施未开工。**
> 关联 issue：#1883（本文）。旧系统只作为**迁移源**，迁移后冻结/废弃；新系统按本设计自建，
> 不复制旧 Casdoor 的 27 个角色和中文资源。
> 架构先行：实施中任何方向/范围调整，先改本文再动码。

## 0. 一句话

把旧系统「岗位 + 门店范围」的授权模型，在新系统重建为 **RBAC（岗位/平台码）+ ABAC（数据范围）**：
角色只留 5 个岗位；品牌/门店/品类作为一等 `data.scope`；`authorizeCore()` 是唯一执法点；
旧系统一次性只读迁移，之后新系统是唯一事实源。

## 1. 背景与已确认决策

旧 `shanhai` org 有 27 个 Casdoor 角色：5 个业务岗位 + 22 个 `范围|*` 门店范围角色；权限资源是
中文标签（`品牌|熊喵鲜生`、`品类|水果`、`范围|东部一区`、`门禁|报表中心`、`字段|成本可见`…）。
新平台 `shanhaiyiguo-org` 是独立权限体系（模块码 + `authorizeCore`）。

**2026-11-10 用户确认**：

| # | 决策 |
|---|---|
| D1 | **品类 scope 对门店总量指标 = 拒绝**（fail-closed）——品类是商品维度，门店总量没有该维度，不能“以为限制了品类、实际总量仍含全部品类”。 |
| D2 | **没有门店 scope 的普通 `data:query` 用户 = 拒绝**；`data:manage`/`tenant:admin` 例外。 |
| D3 | **`范围|全店` = `all`**（该维度不裁）。 |
| D4 | **4 个旧账号**（`DongJiJuan_1`、`Dongjijuan`）**别名到 `DongJiJuan`**（同一人；旧账号均 `isForbidden`）。 |

**迁移来源（2026-11-10 只读取证）**：

- 旧 `shanhai`：655 用户 / 27 角色 / 75 条角色成员。
- 新 `shanhaiyiguo-org`：497 用户 / 0 角色。
- 成员：71 精确命中 + 4 别名 → **75/75**。
- 旧范围标签与新维表**天然对齐**（见 §4），不需要外部「范围→门店」映射。

## 2. 目标与非目标

**目标**：

1. 新系统只有 **5 个岗位角色**（可按业务增删），不继承 22 个范围角色；
2. 数据范围作为一等实体：`brand` / `store` / `category` 三类 scope；
3. 所有查询面（`/query`、MCP、问数/chat、报表、下钻）在 `authorizeCore()` 统一裁；
4. 旧系统一次性迁移；迁移后冻结，不做双写；
5. shadow → enforce，可观测、可回滚。

**非目标**：

- `看板|*` 报表可见性（二期，用资产 ACL/报表映射）；
- `data:precise`（旧体系无对应物，未拍板）；
- 旧系统继续写；
- 引入 OPA/Zanzibar/Postgres RLS 第二套权限系统；
- 前端/词表/报表渲染承担安全职责；
- 跨租户数据范围。

## 3. 模型

### 3.1 身份 / 角色 / 动作

| 概念 | 归属 | 说明 |
|---|---|---|
| 用户 | Casdoor `shanhaiyiguo-org` | 同一企微通讯录；按 `userid` 对齐 |
| 岗位角色 | Casdoor Role | `总经理`、`战区总`、`采购负责人`、`小区经理`、`财务总` |
| 动作权限 | 平台 manifest 码 | 全部数据角色：`data:query`；成本角色：`data:cost`；`data:create`/`data:precise` 按需；`tenant:admin` 只给明确管理员 |
| 数据范围 | `data.scope` + `data.scope_assignment` | `brand` / `store` / `category`；可层级、可 `all` |

**角色默认动作**：

| 角色 | 平台码 |
|---|---|
| 总经理 / 财务总 / 战区总 / 采购负责人 | `data:query` + `data:cost` |
| 小区经理 | `data:query` |

`data:manage` / `tenant:admin` 不来自旧角色；它们是管理身份，单独授予，并**绕过数据范围**
（管理面需要看全量；与资产 ACL 的管理员代管同口径）。

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
{ "system_book": ["3120"] }                 // brand
{ "region_l1": ["东部战区"] }               // store（一级）
{ "region_name": ["东部一区"] }             // store（二级）
{ "all": true }                             // store / category 全量
{ "item_department_name": ["水果"] }        // category（一级）
{ "item_category_name": ["苹果"] }          // category（二级）
```

- `brand` scope 的 selector 只允许 `system_book`；
- `store` scope 只允许 `region_l1` / `region_name` / `all`；
- `category` 只允许 `item_department_name` / `item_category_name` / `all`；
- 配置期校验 selector 值存在于 `dim_brand` / `dim_region` / item 维；不存在 ⇒ 拒绝配置（fail-closed）。

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

### 4.3 品类 = item 维（单独建）

`stg_lemeng_item` 已摊平 `item_department_name` / `item_category_name`；
`dim_item_latest` 目前只保留 `item_num/name/...`，**需要补列**（从最新快照选）：

```
item_department_name, item_department_code,
item_category_name, item_category_id, item_category_level
```

`dbt/semantics/dimensions.yml` 已声明 item 层级（department → category → item），补列后即可用。

SQL（**复合键**）：

```sql
AND (system_book, item_num) IN (
  SELECT system_book, item_num
    FROM dim_item_latest
   WHERE org = '<requester.orgId>'
     AND (item_department_name IN (...) OR item_category_name IN (...))
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
| category | `item_num`（首选）或 `item_department_name`/`item_category_name` | 拒绝（D1） |

- 复合键要求 `system_book` 在粒度里；没有 ⇒ 拒绝（防跨账套串号）；
- 指标粒度含 `region_l1`/`region_name` 但无 `branch_num` 时，可直接用 region 谓词；
- 指标粒度含 `item_department_name`/`item_category_name` 但无 `item_num` 时，可直接用 category 谓词。

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
| `shadow` | 解析并记录「将裁掉/将拒绝」，**不拦**；用于对照旧系统 |
| `enforce` | 真正裁/拒绝 |

- 生产上线顺序：`off` → `shadow` → `enforce`；每次切换都留审计；
- `data.query_audit` 增加 `scope_plan jsonb` / `scope_denial text`（迁移）；
- scope 变更落 `data.scope_audit`（新建/修改/assignment）。

### 5.5 管理面

- `GET/POST/PUT/DELETE /data/scopes`（`data:manage` 或 `tenant:admin`）；
- `PUT /data/scopes/:id/assignments`（role/user 整组替换）；
- `GET /data/scopes/effective?user=`（预览有效 scope，dry-run）；
- 全部写后回读 + 审计；selector 值必须存在于受控维表。

## 6. 迁移（旧系统只读，一次性）

### 6.1 用户对齐

- 按企微 `userid` 对齐；75 条角色成员；
- 71 精确命中；4 个别名：`DongJiJuan_1` / `Dongjijuan` → `DongJiJuan`（D4）；
- 旧 `shanhai` org 全程**只读**；新 `shanhaiyiguo-org` 是写入目标。

### 6.2 旧角色 → 新模型

| 旧 | 新 |
|---|---|
| 5 个业务角色（总经理/战区总/采购负责人/小区经理/财务总） | 5 个 Casdoor 岗位角色；成员迁入 |
| 22 个 `范围|*` 角色 | **不建角色**；转成 `store` scope + **user-level assignment** |
| `品牌|*`（业务角色内） | `brand` scope + **role-level assignment** |
| `品类|*`（业务角色内） | `category` scope + **role-level assignment** |
| `字段|成本可见` | 平台码 `data:cost`（挂到对应岗位角色） |
| `门禁|报表中心` | 平台码 `data:query`（挂到所有数据岗位角色；**不复制中文资源**） |
| `门禁|管理台` | 不映射；`tenant:admin` 另行指定 |
| `看板|*` | 二期：报表可见性（资产 ACL `scope` 受让方） |

### 6.3 范围 selector 自动生成

- `范围|全店` → `{ "all": true }`（D3）；
- 其余 `范围|*`：按名字查 `dim_region`：
  - 命中 `region_name`（level=2）⇒ `{ "region_name": [name] }`
  - 命中 `region_l1`（level=1）⇒ `{ "region_l1": [name] }`
  - 未命中 ⇒ dry-run 报错，人工确认（不猜）；
- `品牌|*`：按 `dim_brand` 映射到 `system_book`；
- `品类|*`：先核 `stg_lemeng_item` 的 distinct `item_department_name` / `item_category_name`，
  选定层级后生成 selector；核不出 ⇒ 停下，不猜。

### 6.4 迁移脚本

一次性脚本（`scripts/migrate-data-scopes.mjs` 或 data 模块 CLI）：

1. 读旧 Casdoor roles/permissions/users（只读）；
2. 读 `dim_region` / `dim_brand` / item dim 生成 selector；
3. 输出 dry-run：新角色、scope、assignment、无法映射的用户/资源、只有范围角色没有岗位角色的用户；
4. 人工确认后 `--apply`；
5. 写后回读：每个目标用户的有效 scope 预览；
6. 旧 org 置只读/冻结（流程动作，不改 Casdoor）。

**兜底**：迁移同时给每个业务用户写 **user-level assignment**（brand/store/category），
即使 `roles` 还没进会话，enforce 也不会出现空窗；role-level assignment 作为后续维护面。

## 7. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| Phase 0 | 本文 + 映射 dry-run（item 品类值、22 个范围全命中） | dry-run 清单可读；无未解释项 |
| Phase 1 | `data.scope`/`assignment` 迁移；`dim_item_latest` 补列；会话 `roles`；scope 管理端点 | schema/端点/审计；旧 org 零写入 |
| Phase 2 | `authorizeCore` scopeFilters + `DATA_SCOPE_MODE=shadow`；对照旧系统抽样 | shadow 日志与旧系统结果一致 |
| Phase 3 | `enforce`；迁移 75/75；scope 管理 UI（可选） | 授权矩阵全绿；无 scope 拒绝；管理员例外 |
| Phase 4 | `看板|*` 报表可见性；`data:precise`（如拍板） | 另立 spec |

**授权矩阵（最小集）**：

- 有 store scope 的用户：只看该区域门店；跨区域不可见；
- `all`：不裁；
- 无 store scope 的普通 `data:query`：拒绝；
- `data:manage`/`tenant:admin`：不裁；
- brand scope：只看到对应 `system_book`；
- category scope：item 粒度指标生效；门店总量指标拒绝（D1）；
- 复合键：同 `branch_num` 在两账套不会串；
- `scopeFilters` 注入的 SQL 在 `authorizeCore` 的输出里可见，且不改变既有 `subject` 钉死。

## 8. 风险与已知边界

1. **品类值映射未核实**：`水果/标品/耗材` 可能是 `item_department_name` 或 `item_category_name`；
   Phase 0 必须先查 distinct 值，不猜。
2. **`dim_item_latest` 补列**：需改 dbt 模型并重跑数据面；列可空，缺失时 category scope 应拒绝
   而不是放行。
3. **`dim_lemeng_branch` 无契约**：`dimensions.yml` 已登记战区层级缺口；scope 解析可直接读该表，
   但语义层声明需后续补契约/稳定视图。
4. **会话 `roles` 兼容**：旧会话无 `roles`；迁移的 user-level 兜底保证 enforce 不空窗。
5. **两账套同名区域/门店号**：一律复合键 `(system_book, branch_num)` / `(system_book, item_num)`，
   禁止裸 `branch_num`/`item_num`。
6. **`data:manage`/`tenant:admin` 绕过**：必须确认这些码没有发给业务岗位；发错等于越权。
7. **旧系统冻结**：迁移后旧 `shanhai` org 不再写；如需并行期，必须明确“只读”窗口，禁止双写。
8. **`看板|*`/`data:precise`**：不在本期；`看板` 不进行级谓词，避免把报表可见性混成数据范围。
9. **性能**：scope 子查询是小表；如出现慢查询，给 `dim_lemeng_branch(system_book,branch_num)`
   与 `dim_item_latest(system_book,item_num)` 补索引/物化 scope 值。
10. **默认拒绝的可用性**：迁移 dry-run 必须列出没有 brand/store/category 的业务用户；缺口先补。

## 9. 关联

- issue：#1883
- 既有 spec：`2026-10-30-org-as-platform-primitive-design.md`（组织原语）、
  `2026-10-17-column-and-value-level-security-design.md`（列/值级）、
  `2026-11-01-mobile-first-business-surface-design.md` §4（资产 ACL）、
  `2026-11-10-platform-superadmin-and-cross-module-authz-design.md`（A1）
- 数据模型：`dbt/seeds/dim_brand.csv`、`dbt/seeds/dim_region.csv`、
  `dbt/models/lemeng/marts/dim_lemeng_branch.sql`、`dbt/models/lemeng/staging/stg_lemeng_item.sql`、
  `dbt/models/lemeng/marts/dim_item_latest.sql`、`dbt/semantics/dimensions.yml`
- 执法/接线：`modules/data/domain/authz.ts`、`modules/data/domain/query-service.ts`、
  `modules/data/domain/toolbox/discovery.ts`、`modules/data/routes/context.ts`、
  `apps/server/src/session-middleware.ts`、`apps/server/src/pat-auth.ts`、
  `apps/server/src/wecom-channel-auth.ts`
