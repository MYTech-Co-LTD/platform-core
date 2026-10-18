# forms 受管数据集内核（M1.2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `modules/forms` 落地受管数据集内核：表单定义生命周期（draft→published 人 gate→retired，DB 触发器强制不可变）+ 字典形态（软删 / key 不可变 / 双档 P4）+ 绑定强度（required|open）+ 服务端提交校验。

**Architecture:** PoC `explore/poc/lifecycle-unified/`（28/28，人审）的 4 表 + 3 触发器 + 7 函数内核做**多租户工程化**（全部资产表加 `org`、提交加 `submitted_by`）；字典按正典「同名不同表」独立建表（租户/全局两档，P4）；校验纪律照 `modules/data/domain/authz.ts` 四不变量（纯函数、写时校验、机检错误码、主体钉死）。设计正典 `docs/architecture.md` §2.4 + explore ADR-0005（§12.11–12.13、§14.1、§15）。

**Tech Stack:** 模块协议（`@platform/sdk` defineModule / ManifestSchema）+ pg（SQL 函数与触发器）+ ajv@8（draft-07，§12.1 方言定案）+ vitest。零新基础设施。

## Global Constraints

- 三同：`manifest.id = forms` = DB schema = API 前缀（B1 门禁）。
- 迁移幂等（`drop ... if exists` / `create ... if not exists` / DML `on conflict`）；同一批重复执行不报错。
- 租户表必须有 `org text not null`；全局表用 `-- global-table: <理由>` 独占一行**紧贴** create table（check-tenant-isolation 判据，T1+T2 一起豁免）。
- published 不可变性落 **DB 触发器**（裸 SQL 直改也拦）；`lifecycle.internal` 会话旗标是唯一合法 published→retired 通路，出现在业务代码里视为告警。
- 契约方言 = **draft-07**（2020-12 会静默失效，§12.1）；发布门 = 编译闸。
- 错误一律机检错误码（调用方按 code 映射状态与文案，不解析 message）；主体（org）只来自 `identity.orgId`；请求参数出现保留键一律 400。
- P7：绑定强度只落 `required`|`open`，`extensible` 拒。
- 模块内不跨 import 他模块（§12.13）；测试替身收严到真机形状。

## 文件结构

| 路径 | 职责 |
|---|---|
| `modules/forms/migrations/001_kernel.sql` | 6 表 + 3 触发器 + 8 函数 + kind 种子（幂等） |
| `modules/forms/domain/contract.ts` | **纯函数**：契约编译闸 + 提交五道闸（不 import pool/env/Hono） |
| `modules/forms/domain/contract.test.ts` | 编译闸与五道闸单测（无 DB） |
| `modules/forms/storage.ts` | 生命周期函数 / 字典 CRUD / 提交的 SQL 封装（pool 进、行出） |
| `modules/forms/routes.ts` | 21 条端点（薄壳：identity → storage/contract，错误码映射状态码） |
| `modules/forms/index.ts` | 读 manifest → defineModule → mount routes（M1.1 骨架扩展） |
| `modules/forms/manifest.yaml` | 权限码 5 + api.internal 21 条声明 |
| `modules/forms/test-util.ts` | makeIdentity + 测试壳（照 aftersales 先例，复用宿主 runMigrations） |
| `modules/forms/kernel.test.ts` | PoC 28 断言对账（DB；含裸 SQL 绕过层与 md5 对账） |
| `modules/forms/dict.test.ts` | 字典四纪律 + P4 双档 + 跨 org 隔离（DB） |
| `modules/forms/routes.test.ts` | scope 门 / org 钉死 / 匿名探测 / 校验错误码（DB） |
| `docs/architecture.md` | §2.4 P4 分档落档 + 「§2.2 三角色」悬空指针订正（**先于代码提交**） |

依赖新增：`ajv@^8`（forms package.json，draft-07 内建）。

## 关键形状（任务间共享的精确接口）

### Schema（001_kernel.sql）

```sql
-- global-table: 声明资产策略注册表——发布门禁策略是平台级配置，全租户共用，无租户归属（P4 分档配套，global-table 机制首个真实用例）
create table if not exists forms.kind (
  kind text primary key,
  publish_policy text not null check (publish_policy in ('human_gate','auto')),
  note text
);
insert into forms.kind(kind, publish_policy, note) values
  ('form_def','human_gate','表单定义：发布是人的唯一 gate（ADR-0005 §14.1）')
  on conflict (kind) do update set publish_policy = excluded.publish_policy, note = excluded.note;

create table if not exists forms.asset_version (
  org text not null,
  kind text not null references forms.kind(kind),
  asset_id text not null,
  version int not null,
  body jsonb not null,
  status text not null check (status in ('draft','published','retired')),
  created_by text not null,
  published_by text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  retired_at timestamptz,
  primary key (org, kind, asset_id, version)
);
create index if not exists idx_forms_asset_version_head on forms.asset_version(org, kind, asset_id, version desc);

create table if not exists forms.asset_head (
  org text not null, kind text not null, asset_id text not null,
  active_version int not null,
  primary key (org, kind, asset_id)
);

create table if not exists forms.submission (
  id bigserial primary key,
  org text not null, kind text not null, asset_id text not null,
  version int not null, payload jsonb not null,
  submitted_by text not null,
  submitted_at timestamptz not null default now()
);
create index if not exists idx_forms_submission_org on forms.submission(org, kind, asset_id, submitted_at desc);

create table if not exists forms.dict_item (
  org text not null, dict_id text not null, key text not null,
  label text not null, sort_no int not null default 0,
  enabled boolean not null default true, retired_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org, dict_id, key)
);

-- global-table: 平台全局字典（P4 分档）：标准码类值集全租户共用，无租户归属；编辑权=平台超管（forms:global-manage）
create table if not exists forms.dict_global_item (
  dict_id text not null, key text not null,
  label text not null, sort_no int not null default 0,
  enabled boolean not null default true, retired_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (dict_id, key)
);
```

触发器 3 + 共享 1（形状照 PoC，全部加 org 维度）：

1. `forms.forbid_published_mutation()`：identity 列（org/kind/asset_id）不可变；published 行无 `lifecycle.internal=on` 旗标一律拒；旗标下只放行 published→retired 且 body/version/署名/时间戳冻结。
2. `forms.forbid_published_delete()`：非 draft 行物理删即拒。
3. `forms.submission_must_follow_head()`：按 (org,kind,asset_id) 查 head；无 head 或 version≠head 拒。
4. `forms.forbid_dict_key_change()`（dict_item 与 dict_global_item 共用）：`new.key is distinct from old.key` 即拒。

函数 8（全部带 `p_org`；SQL 体照 PoC 逐条移植）：`new_draft(p_org,p_kind,p_asset,p_body,p_actor) returns int`、`update_draft(...)`、`drop_draft(...)`、`publish(p_org,...,p_actor,p_actor_role)`（human_gate 撞 `p_actor_role<>'human'` 即拒）、`rollback_to(p_org,...)`、`retire(p_org,...)`、`submit(p_org,p_kind,p_asset,p_payload,p_submitted_by) returns bigint`、`body_at(p_org,p_kind,p_asset,p_version) returns jsonb`。

### 契约约定（domain/contract.ts）

```ts
export const DICT_REF_RE = /^(dict|gdict):([a-z][a-z0-9-]*)$/   // 第二消费者出现迁 SDK（可搬迁纪律）
export const BINDINGS = ['required','open'] as const           // extensible 拒（P7）
export const RESERVED_KEYS = ['org','tenant','tenantId','id','submittedBy','submittedAt']

// 发布门：draft 期自由；publish 前必须过
export function compileGate(body: unknown): { ok: true } | { ok: false; code: string; detail?: string }
//  - body 是对象、$schema 缺省或 draft-07（2020-12 → SCHEMA_DIALECT）
//  - ajv 编译通过（→ SCHEMA_COMPILE）
//  - 每个 x-dict 匹配 DICT_REF_RE（→ BAD_DICT_REF）、带 x-binding 且 ∈ BINDINGS（→ BINDING_REQUIRED / BAD_BINDING）

export function validateSubmission(args: {
  schema: object;                          // 提交钉住版本的 body
  payload: unknown;
  dictLookup: (ref: string) => Set<string> // ref → 生效 key 集（storage 注入；纯函数不碰池）
}): { ok: true; pinnedVersionNote: 'validated-against-pinned' } |
   { ok: false; code: 'RESERVED_KEY'|'UNKNOWN_FIELD'|'NOT_JSON'|'SCHEMA_INVALID'|'DICT_REQUIRED_VIOLATION'; detail?: string }
// 闸序：RESERVED_KEY → NOT_JSON → UNKNOWN_FIELD（顶层 keys ⊆ properties，不静默丢弃）→ ajv 校验 → 字典 required 绑定
```

### manifest 权限码与端点（21 条）

权限码：`forms:view`（读/解析）｜`forms:fill`（提交）｜`forms:manage`（draft CRUD + 租户字典写）｜`forms:publish`（发布/回滚/退役，人 gate）｜`forms:global-manage`（全局字典写，默认无租户角色持有）。

| # | method path | scope | 语义 |
|---|---|---|---|
| 1 | GET /defs | view | 资产列表（org 钉死；head+版本计数） |
| 2 | GET /defs/:assetId | view | 版本清单 + head（`?version=` 回该版 body，retired 也可读=渲染历史） |
| 3 | POST /defs | manage | `{assetId, body}` 起草 v1 |
| 4 | PUT /defs/:assetId/versions/:v | manage | 改 draft（仅 draft；published 由触发器拦） |
| 5 | DELETE /defs/:assetId/versions/:v | manage | 删 draft |
| 6 | POST /defs/:assetId/versions/:v/publish | publish | **人 gate** + 编译闸；`actor_role='human'` |
| 7 | POST /defs/:assetId/rollback | publish | `{version}` 切 head 指针 |
| 8 | POST /defs/:assetId/versions/:v/retire | publish | 软删（head 不可退） |
| 9 | POST /defs/:assetId/submissions | fill | `{payload}` 按 head 钉版本校验后提交 |
| 10 | GET /defs/:assetId/submissions | view | 提交列表 |
| 11 | GET /submissions/:id | view | 提交 + 钉住版本契约（body_at） |
| 12 | GET /dicts | view | 租户字典清单（按 dict_id 聚合） |
| 13 | GET /dicts/:dictId/options | view | 生效 options（排序） |
| 14 | GET /dicts/:dictId/resolve?keys=a,b | view | 任意历史 key → label+enabled（渲染历史） |
| 15 | POST /dicts | manage | `{dictId, key, label, sortNo?}` |
| 16 | PUT /dicts/:dictId/keys/:key | manage | `{label?, sortNo?, enabled?}`（key 不可变；enabled=false 软删 / true 恢复） |
| 17–21 | /global-dicts 同 12–16 | view / global-manage | 全局字典五条 |

路由注意：同深度无静态兄弟与 param 混排（issue #145 敏感形状不出现）；错误码→状态码映射集中在 routes.ts 一个表。

### PoC 28 断言 → 本仓测试对账

| PoC | 断言 | 本仓落点 |
|---|---|---|
| G0 | 迁移连跑两遍幂等 | kernel.test（applyMigrations ×2） |
| D1–D4 | draft 建/改/删自由 + 回读 | kernel.test（storage 调 SQL 函数） |
| P1/P2 | agent 发 publish 拒；human 发过+署名+head 四件联查 | kernel.test P1 用 `actor_role='agent'`；routes.test 另证 scope 层（manage 发 publish → 403） |
| I1–I3 | 裸 SQL 改 published / 物理删 / 伪造旗标 → 拒 | kernel.test **直接 pool.query 裸 SQL**（DB 层绕过测试） |
| V1/V2 | 修改=新版本，旧版 md5 不变 | kernel.test |
| S1/S2 | 提交钉 head；契约收紧新提交立即按新契约拒 | kernel.test + contract.test |
| T0/T1/T2/T4/T5 | head 不可退；退役软删 body 原封；retired 版本历史提交仍按钉住版校验过；回滚目标须 published；提交只跟 head | kernel.test（T2 = S 系对照的退役侧） |
| R1–R3 | 回滚双 md5 不变；无 head/回 draft 拒 | kernel.test |
| K0/C 组 | kind 表策略驱动；一套内核多资产 | kernel.test 机制断言（策略行驱动 publish 分支）；**C 组四资产微缩链不在 v1**（仅 form_def 有载体）——auto 策略随补料契约（case-engine 挂载点）落地复验，不 seed 无主 kind |
| （新增） | 字典四纪律 + P4 双档 + 跨 org | dict.test（key 不可变为**裸 SQL** 绕过测试） |
| （新增） | 五道闸错误码 / 匿名 401 | contract.test + routes.test（probeAnonymous） |

防假绿：I1–I3 与字典 key 不可变测试走**裸 SQL**（不经 API）＝绕过层先证会红；跨 org 用例两 org 探针值必须互异。

## 任务分解

> 📌 **勾选状态于 2026-10-18 回溯补记（执行时未逐项勾）**：M1.2 实际以**一次 PR（#713，`Closes #710`）**
> 合并，计划里的「分任务 commit」没有逐个落地 —— 各 `commit：…` 步骤按「**已随 #713 合入**」记 ✅。
> 逐项核对过的证据：`001_kernel.sql`（**6 表 / 5 触发器 / 12 函数 / 2 处 `global-table` 豁免**）、
> `test-util.ts` + `kernel/contract/dict/routes/module` 五个测试文件、`manifest.yaml`（**5 个权限码** +
> **24 条 `api.internal`**）、`domain/contract.ts` 走 **ajv draft-07**、`#710 CLOSED`。
> （数值比计划里的 4+2/3+1/8、21 条更大 —— 实现期增补，不是缺项。）

### Task 1：文档先行（架构订正 + 本计划）

- [x] `docs/architecture.md` §2.4：P4 分档落档 + 两处「§2.2 三角色」悬空指针订正（**已完成于开工时**）
- [x] 本计划落 `docs/superpowers/plans/2026-10-16-forms-managed-dataset-core.md`
- [x] commit：`docs(forms): M1.2 P4 分档落正典 + 实施计划（issue #710）`

### Task 2：迁移 001_kernel.sql + 幂等测试（TDD：先 G0 红）

- [x] test-util.ts（makeIdentity + 测试壳 + applyMigrations，照 aftersales；本模块无 storage 投影）
- [x] kernel.test.ts 先写 G0（applyMigrations 连跑两遍不抛）→ 跑红（迁移文件不存在）
- [x] 写 001_kernel.sql（上面 Schema 全文 + 触发器 + 函数 + 种子）
- [x] G0 绿 + `check-tenant-isolation` 真库绿（global-table 首用路径）
- [x] commit：`feat(forms): 生命周期内核迁移（4+2 表/3+1 触发器/8 函数，issue #710）`

### Task 3：domain/contract.ts（纯函数，TDD）

- [x] contract.test.ts 先红：方言拒（2020-12）→ SCHEMA_DIALECT；编译败 → SCHEMA_COMPILE；x-dict 无 binding → BINDING_REQUIRED；binding=extensible → BAD_BINDING；坏 ref → BAD_DICT_REF；RESERVED_KEY；UNKNOWN_FIELD（不静默丢弃）；DICT_REQUIRED_VIOLATION；open 放行
- [x] 实现 compileGate + validateSubmission（ajv draft-07；形状照上面接口）
- [x] 绿 + commit：`feat(forms): 契约编译闸与提交五道闸（issue #710）`

### Task 4：storage.ts（SQL 封装）

- [x] 生命周期七操作 + body_at + 字典 CRUD（put/upsert key、update（禁 key 变）、softDelete/restore、options、resolve、global 同构）+ 提交（先 contract 校验后 `forms.submit`）
- [x] kernel.test.ts 补满 D/P/I/V/S/T/R 组（裸 SQL 绕过 + md5 对账，对账表逐行）
- [x] dict.test.ts 补满四纪律 + 双档 + 跨 org
- [x] 绿（DATABASE_URL 指一次性空库）+ commit：`feat(forms): 内核与字典存储层（issue #710）`

### Task 5：routes.ts + manifest + index.ts（TDD）

- [x] routes.test.ts 先红：scope 矩阵（view 读 / fill 提交 / manage 起草 / publish 发布；**manage 发 publish → 403**；global-manage 才能写全局）+ org 钉死（B org 读不到 A 的资产）+ 错误码映射 + probeAnonymous 全 401
- [x] manifest.yaml 权限码 5 + api.internal 21 条；routes.ts 端点；index.ts 装配（api.internal ↔ 注册双向核对本地版测试照 aftersales）
- [x] module.test.ts 扩展：权限码前缀三同、双向核对、21 条声明
- [x] 绿 + commit：`feat(forms): API 面 21 端点与声明即授权（issue #710）`

### Task 6：全量门禁 + PR

- [x] 本地一次性空库：`pnpm test` 全绿；`pnpm typecheck`；12 守卫脚本 + `check-tenant-isolation`；web+mobile build + `pnpm smoke`
- [x] push + PR（squash，body `Closes #710`，验证清单如实）
- [x] CI CLEAN → 合并 → mytech 自动部署验证 → 山海例行（判内容：内核纯增量，无消费方前行为惰性）
