# 收件人身份映射：把「渠道原生地址」从平台标识里解耦（设计）

> **状态：待用户 review（2026-10-31 起草）。** 按架构先行，review 通过后开 issue 实施 Phase 1。
> 触发：山海部门真机轮 `LuZhengHui` 落企微 `81013`（用户确认＝不在应用可见范围）——排查中发现
> 真正的债不是这次失败，而是**身份在系统里被往返猜了一次**（issue #1225）。

## 0. 一句话

`org_membership.user_name` 今天同时扮演「平台标识」和「渠道地址」两个角色，而两者的相等只是
**一条注释里的假设**。本设计把渠道原生地址（企微 `userid`、将来飞书 `open_id`）**显式存下来**，
发送时按「显式 → 绑定 → 兼容兜底」解析，让「发不到谁」和「不知道这是谁」变成可解释的两件事。

## 1. 现状与证据（2026-10-31 实测）

| # | 事实 | 出处 | 后果 |
|---|---|---|---|
| 1 | 企微同步把 `userid` 当成员名写入 `org_membership.user_name` | `apps/server/src/org-sync.ts` `fetchWecomSnapshot`（`userName: u.userid`）+ `applySnapshot` | 山海的成员名**恰好**是企微 userid |
| 2 | 表注释把这条断言写成事实：`user_name text -- Casdoor name（= 企微 userid）` | `apps/server/src/migrations/012_org_tables.sql` | 没有任何约束/列能表达「这是假设」 |
| 3 | 同步支持两个源：`?source=wecom`（默认）与 `?source=casdoor`；后者 `userName = Casdoor 名` | `org-sync.ts` `snapshotFromCasdoor` + `routes/admin.ts` `POST /org-sync` | **表里没有 provenance**：跑过一次 casdoor 源之后，消费方无法分辨拿到的是 userid 还是名字 |
| 4 | 发送时身份靠 `address_fallback: 'casdoor_name'` 猜 | `modules/notify/worker.ts`、`routes.ts`、`mcp.ts` 三处同款三元 | 租户级布尔假设；手工建号成员必然错，且**不报错**（只是发不到） |
| 5 | `platform.identity_link` 是显式映射的正解，但只在「用企微登录过」时落 | `platform.identity_link`（山海：**0 行**） | 显式映射被边缘化，隐式猜测成了主路径 |
| 6 | 81013 这类**个人级**失败只躺在 `notify.delivery.last_error` | 本次实测 | 没有业务消息时不可见；真实审批消息发出后「一半人没收到」只有翻库才知道 |

**结论**：#1225 里「同步没存 userid」的说法**不成立**（已订正）；真正的缺口是
**地址与标识同列 + 无来源标记 + 解析靠猜 + 个人级失败不可观测**。

## 2. 决策（已与用户对齐 2026-10-31）

| # | 决策 | 理由 |
|---|---|---|
| D1 | `org_membership` **加两列**（`source`、`external_id`），不新建映射表 | 同步时本就知道答案，顺手落；表按 tenant 整组重写，加列零迁移成本；独立表要多一次 join 与一套一致性维护 |
| D2 | 解析顺序：**显式 `external_id` → `identity_link`（active）→ 兼容兜底 `casdoor_name`（带 warn）→ 失败** | 显式优先；绑定次之；兼容层保留但不静默（warn 可被日志告警抓到） |
| D3 | 个人级可达性探针（`user/get` 抽样）**不进 SLA** | 可见范围这类配置问题会让 SLA 天天红；先用「可达率告警」，红了也不制造成 STALE 风暴（与 `{at,error}` 的「不适用 ≠ 红」同口径） |
| D4 | 投递永久失败**按 code 聚合**后再告警 | 否则个人级失败只能人工翻库（同类教训：`woke` 的静默死就是「没人看的地方失败」） |
| D5 | **不做**历史数据强制回填：`external_id` 可空，下次同步自然补齐 | 旧行 `source` 未知就是一个诚实的状态；强填等于造假 |

## 3. 数据模型

### 3.1 表变更（`apps/server/src/migrations/017_org_member_identity.sql`）

```sql
-- 幂等：add column if not exists
alter table platform.org_membership
  add column if not exists source      text,   -- 'wecom' | 'casdoor'；NULL = 本次迁移前的旧行（来源未知）
  add column if not exists external_id text;   -- 渠道原生地址：wecom 源 = 企微 userid；casdoor 源 = NULL（未知）
```

语义（**写进列注释，不只是本文**）：

- `user_name`：平台用户标识（Casdoor name）。**不再断言"= 渠道地址"**。
- `external_id`：**该源渠道**的原生地址。`source='wecom'` ⇒ 非空；`source='casdoor'` ⇒ NULL。
- 主键不变 `(tenant_id, user_name, ext_id)`：同一人在多个部门各一行，`external_id` 各行相同。

> 为什么 `external_id` 现在与 `user_name` 值相同还要单独存：**两者语义不同**（一个是平台主键，
> 一个是渠道地址）。今天相等是因为企微同步拿 userid 当名字；一旦出现「Casdoor 名是工号/手机号、
> 企微 userid 是拼音」的租户，只有 `external_id` 能承载地址，`user_name` 不能。

### 3.2 同步侧（`org-sync.ts`）

- `OrgSnapshot.memberships` 增加 `externalId: string | null`；
- `fetchWecomSnapshot`：`externalId: u.userid`（`userName` 保持现状＝userid，向后兼容）；
- `snapshotFromCasdoor`：`externalId: null`（Casdoor groups 不含渠道地址，**不猜**）；
- `applySnapshot`：写入 `source`（由调用方传入，`wecom`/`casdoor`）与 `external_id`。

`applySnapshot` 的签名从 `(pool, tenantId, snapshot)` → `(pool, tenantId, snapshot, source)`；
`runOrgSync` 透传。**旧调用点必须显式传源**，不设默认值——默认值会让"忘了传"变成静默错源。

### 3.3 解析侧

**分两段，职责按"谁看得见配置"划清**：

| 段 | 位置 | 做什么 |
|---|---|---|
| 地址解析（显式） | `apps/server/src/channel-address.ts` `resolve()` | ① `org_membership.external_id`（`source` 与 provider 匹配才用）→ ② `identity_link`（active）→ 返回地址或 `null` |
| 兼容兜底 | `modules/notify/domain/resolve-address.ts`（**新增，唯一实现**） | ③ `resolve()` 返回 null 且通道 `config.address_fallback==='casdoor_name'` ⇒ 用 `userName` 作地址，并 `console.warn({event:'address_fallback_used', org, provider, name})` |

为什么兜底不放 `resolve()`：兜底开关是**通道配置**，宿主解析器拿不到通道；反过来让宿主去读
`notify.channel` 又违反 B1。所以兜底留在模块侧，但**收敛成一个函数**——今天它在 `worker.ts`、
`routes.ts`、`mcp.ts` **三处各写了一遍**（同一三元表达式），正是「三处同源」教训要避免的形态。

失败语义不变：最终仍为 `null` ⇒ 投递 `dead / missing_channel_address`（现状）。

### 3.4 观测（Phase 2，待实施）

- 探针抽样：`notify.channel_probe` 增加 `reachable` / `unreachable` 计数（每轮抽 N 个成员 `user/get`）；
- 投递聚合：`notify.delivery_attempt` 按 `(channel, code)` 24h 聚合，81013 等永久码超阈值进告警面；
- 控制台：通道页「地址未解析 / 被企微拒」清单（#1225 已登记）。

## 4. 迁移与回滚

| 步 | 动作 | 回滚 |
|---|---|---|
| 1 | 迁移 017 加两列（可空、幂等） | 列可留；不回滚 DDL |
| 2 | `applySnapshot` 写 `source/external_id`；解析改用新顺序 | 代码回滚到旧 `resolve`（只查 identity_link + fallback），新列闲置 |
| 3 | 重跑一次 `POST /org-sync?source=wecom&dryRun=false` 回填 | 不回滚数据（回填只是补齐，不改语义） |

**边界**：旧行 `source IS NULL` 时解析**不得**把它当 `wecom` 用（那是猜）——按 ②③④ 走。

## 5. 验收

| # | 判据 | 做法 |
|---|---|---|
| 1 | 同步落 `source/external_id` | 山海重跑同步后 `select source, count(*) from platform.org_membership group by 1` ⇒ 全 `wecom`；`external_id` 非空 |
| 2 | 解析顺序四态 | 单测：显式命中 / 仅 identity_link / 仅 fallback（有 warn）/ 全无 ⇒ null |
| 3 | 真机不回退 | 数字技术部重发：`yangwei` 仍 `sent`；`LuZhengHui` 仍 81013（可见范围，错误文案不变） |
| 4 | **变异** | 把某成员 `external_id` 改错 ⇒ 81013；置 NULL ⇒ 回退到 ③（有 warn），证明顺序真的生效 |
| 5 | 不引入新静默 | 走 ③ 兜底时日志里能 grep 到 `address_fallback_used` |

## 6. 不做（YAGNI）

- **不做**独立映射表 / 多地址一人一表（等第二个渠道落地再议）；
- **不做** `DeptExpansion` 形状变更（解析侧查表即可，展开仍只回名字）；
- **不做**跨渠道地址自动推导（飞书 open_id 是应用级，必须显式绑定）；
- **不做**历史行强制回填（D5）。

## 7. 影响面清单

| 面 | 文件 | 改动 |
|---|---|---|
| 迁移 | `apps/server/src/migrations/017_*.sql` | 加两列 |
| 同步 | `apps/server/src/org-sync.ts` | snapshot 带 `externalId`；`applySnapshot` 写 `source/external_id`；`runOrgSync` 透传 |
| 解析 | `apps/server/src/channel-address.ts` | ① `org_membership.external_id` 优先 |
| 兜底收敛 | `modules/notify/domain/resolve-address.ts`（新） | 唯一实现；`worker.ts` / `routes.ts` / `mcp.ts` 三处改调用它 |
| 测试 | `org-sync.test.ts`、`channel-address.test.ts`、`resolve-address.test.ts` | 四态 + 写入 + warn |

> 通知模块的**投递/发送逻辑零改动**：只换「地址从哪来」这一处。
