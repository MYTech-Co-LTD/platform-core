# 组织架构升为平台一等公民：平台 org 表 + 自建同步器 + 三消费点（设计）

> 本文是「组织架构从展示数据升级为授权/路由主体」的**规划稿**（spec）。
> **状态：待用户 review（2026-10-30 起草）。未开工——按架构先行，review 通过后开 issue 实施。**
> 工作铁律：实施中任何方向/范围调整，先改本文再动码。

## 0. 背景与决策链

触发诉求（用户 2026-10-30 重申，三条）：

1. 租户管理后台可见与企微相同的组织架构（**已上线**：console 组织架构页，v0.194.0）；
2. 可创建角色、配置权限（**已上线**：角色管理页 + 码↔人/角色挂接）；
3. **组织架构全局可用**——报表页配权限时可选组织架构（按部门授权）、推送消息设接收人可选组织架构（按部门路由）等。

第 3 条是**新增需求**，它改变了组织架构数据的性质：从「console 组织树页的展示数据」变成**授权判定与消息路由的主体**。本设计由此而来。

决策链：yangwei「没有报表权限」排查 → 发现 Casdoor 组织树缺 29 个部门/70 人 → 逐层实测定位三组根因（详见 §1）→ 手工补齐并全量对齐（272 组/475 用户，2026-10-29 执行完毕）→ 复盘架构 → 用户明确第 3 条诉求 → 本设计。

## 1. 现状与实测证据（2026-10-26 ~ 10-30，全部真机实测）

### 1.1 Casdoor 内置 syncer：三条结构性死刑（不可修复）

| # | 缺陷 | 证据 |
|---|---|---|
| 1 | **企微可信 IP 校验「本企业服务器 IP」**——共享 Casdoor 机（113.249.101.33，公司主体）被 `60020` 拒；官方错误码原文「请确认该 IP 是本企业服务器 IP…第三方服务商 IP 不能调用」。加白名单不是配置问题是主体校验 | 同一 secret 从山海机（104.181）`errcode=0`、从 Casdoor 机 `60020`，双向对照实测 |
| 2 | **不支持代开发 suite**：`syncer_wecom.go` 全文零匹配 `suite`，唯一认证路径 `gettoken(corpid, corpsecret)` | 源码级核对（object/syncer_wecom.go:194） |
| 3 | **更新分支不写 groups**：`updateUserForOriginalFields` 的列白名单只含 tableColumns 映射列 + affiliation/hash/pre_hash/wecom | 源码级核对（object/syncer_user.go:87-102）；山海 3 个存量户（先建号后同步）零组的直接根因 |

### 1.2 同步覆盖面 = 凭证可见范围（静默缺口）

同一企业三枚凭证，从同一台机器拉 `department/list`：

| 凭证 | agentId | 可见部门数 | 含数字技术部(57)？ |
|---|---|---|---|
| `platform.tenant.wecom_secret`（经营分析） | 1000012 | **0**（可见范围仅 2 人） | ❌ |
| A 机 `WECOM_SECRET`（数据分析，10-26 同步实际所用） | 1000008 | 243 | ❌ |
| A 机 `WECOM_OPS_SECRET`（消息通知，全员可见） | 1000009 | **272** | ✅ |

**10-26 那次同步用了 1000008，从第一天起就看不见那 29 个部门**（共享中心/战略中心/新零售中心等整条分支）——`fail-closed` 缺失使它以「同步成功」的姿态静默存在了一个月。yangwei 不在组织树、报表页看不见他，全部由此而来。

### 1.3 代开发（企微服务商）轨道现状：登录通、组织同步从未跑通

- 登录链路真实在用：woke 5 个用户持有 `wo` 前缀 openid（第三方体系产物），三个 app 绑 `provider_wecom`（clientId=`wp…` 32 位，即 suite_id）。
- 但 woke gateway PG `wechat_corp_auth` 表：**permanent_code 长度 0、access_token 长度 0**（授权凭据从未成功落库；且 `corpid` 字段误存了 suite_id 格式的值）。
- `app_config.wecom_suite_ticket` 最后更新 **2026-08-30**——企微每 10 分钟推送一次，**断流两个月无告警**（监控缺口）。
- Casdoor `subType` 字段不可作判据：`provider_wecom_third` 标了 `Third-party` 却是空壳（未绑任何 app）；真代开发 `provider_wecom` 标的是 `Internal`。可靠判据是 **clientId 前缀**：`ww`+16=corpId（自建），`wp`+32=suite_id（代开发）。
- 代开发取 token 的正确链路（`deploy/wecom-suite/server.mjs` 实测注释）：`get_suite_token` → `get_permanent_code` → **普通 `gettoken(corpid, permanent_code)`**（`get_corp_token` 对代开发 48002 无权限）。⇒ **代开发与自建应用最终收敛到同一个 gettoken 调用**，差异只在 secret 的来源。

### 1.4 Casdoor group 模型的既有缺陷（这些天实证）

- 双面冗余（`user.groups` + `group.users`）会漂移——更新分支不写（§1.1#3）是漂移源之一；
- 表达力不足：存不了部门负责人、排序；`isTopGroup`/`parentId` 真机形态多样；
- 写入只有 Admin API（cookie 会话），不适合运行时消费路径。

### 1.5 当前消费方盘点（决定迁移安全性）

| 消费方 | 是否读组织数据 | 现状 |
|---|---|---|
| `effectiveScopes`（权限判定核心） | ❌ **不读 groups**（只读 permissions.users/roles） | 迁移不影响授权语义 |
| console 组织树页（`admin.ts:277-311`） | ✅ 读 `u.groups` + `listGroups` | 唯一消费方 |
| 报表可见性（`reports.ts visibleTo`） | ❌ 只读 `required_scope`（平台权限码） | 与组织无关 |
| 消息推送（notify 模块） | ❌ 接收人按 userid，无部门概念 | 待新增 |

**⇒ 目前把组织数据从 Casdoor groups 迁走，授权语义零影响，只有组织树页一个消费点要切源。迁移窗口最好（组织树页刚上线、真实租户仅山海一家）。**

### 1.6 已验证的落地案例（无案例不立标准的「案例」）

2026-10-28~29，用「A 机拉企微全量 → Casdoor Admin API 写入」的方式手工执行了完整对齐：

- 组 243 → **272**（新建 29 个，含 `49 共享中心 → 57 数字技术部` 链），dry-run 先行（输出「建 29 组 / 改 4 人」清单人工确认）；
- 用户 405 → **475**（补建 70 个盲区账号，字段照 syncer 模板：`registerSource=<org>/shanhaiyiguo-wecom-directory`、`wecom=<userid>`、groups 按企微部门、企微 status 4/5 → isForbidden）；
- 验收：无组用户仅锚账号 `tenantsub`；企微有/Casdoor 无 = 0；禁用 234 与企微未激活对账一致。

**这套方法（dry-run → Admin API 建组/挂人/建号 → 回读对账）就是本设计同步器的直系原型。**

## 2. 决策

**D-O1 组织架构的平台内存储 = 平台自有 org 表（方案 B），废弃 Casdoor groups 作为组织存储。**

三方案对比（结论先行，论证见 §1）：

| 维度 | A：继续 Casdoor groups | **B：平台 org 表（选定）** | C：实时查企微 |
|---|---|---|---|
| 子树展开 | ❌ 每次拉全量自拼 | ✅ 物化 path 一步查 | ⚠️ 同 A |
| 部门→成员（推送） | ❌ 扫全量用户反查 | ✅ 索引查询 | ❌ 每次全量拉 |
| 用户→部门（授权） | ⚠️ getUser 顺带，仅全形名 | ✅ 会话刷新一并取 | ❌ |
| 写入路径 | ⚠️ Admin API + 双面冗余漂移 | ✅ 单表单向 | — |
| 多消费者扩展 | ❌ 各自拼树+缓存 | ✅ 统一读一处 | ❌ |
| 授权原语的归属 | 依赖第三方 group 模型 | 平台自有 | 平台自有 |
| 改动量 | 0 | 2 表 + job 固化 + 3 消费点 | 大且不可行（IP 白名单实测穷举无解） |

否决 A 的核心理由：让「报表谁能看」的判定原语建立在已实证会漂移、表达力不足、写入只能走 Admin 会话的第三方 group 模型上，是错误的依赖方向。否决 C：授权路径不能依赖企微在线，且除 A 机外无机器+凭证组合能拉全量树（§1.2 实测）。

**D-O2 同步执行者 = 平台自建 job（双轨取 token），Casdoor 内置 syncer 退出。** 死刑证据见 §1.1；两条取 token 轨最终收敛到同一 `gettoken` 调用（§1.3）。

**D-O3 子树继承 = 继承。** 报表授权给「共享中心」⇒ 数字技术部成员自动可见。物化 path 实现，`path LIKE '49.%'`。

**D-O4 部门门与 scope 门 = 叠加不替代。** entitlement（`data:query` 等权限码）先决，部门门在其上做行级收窄（`required_depts` 空 = 维持现状仅按 scope）。不引入「部门替代 scope」的语义。

**D-O5 Casdoor groups 不双写、渐进退役。** 切源后 272 个组失去消费者，留着无害；清理另行单独处理（低优先级，防止 identity 链引用未查清前误删）。

**D-O6 D5 修订**（对 2026-10-24 spec）：组织架构**事实源 = 企微；平台内存储 = 平台 org 表；Casdoor 只存人 + 权限码 + 角色**。「组织树也归 Casdoor」的表述废止。

## 3. 设计正文

### 3.1 存储模型（platform 库，2 张表）

```
platform.org_node
  tenant_id      int        -- 租户隔离
  ext_id         text       -- 企微部门 id（如 "57"），租户内唯一
  name           text       -- 部门名（快照，展示用）
  parent_ext_id  text       -- 父部门 ext_id；根 = NULL（企微 parentid=0/1 归一）
  path           text       -- 物化路径 "49.57"；子树查询唯一入口
  status         smallint   -- 1 正常 / 0 已删除（企微侧消失 → 软删）
  synced_at      timestamptz
  unique(tenant_id, ext_id)

platform.org_membership
  tenant_id      int
  user_name      text       -- Casdoor name（= 企微 userid）
  ext_id         text       -- 部门 ext_id
  is_primary     boolean    -- 企微 main_department
  synced_at      timestamptz
  unique(tenant_id, user_name, ext_id)
```

- 部门负责人/排序等字段**本期不建**（无消费方；有消费方时加列，YAGNI）。
- path 在同步时物化写入；部门重挂父时同步重算子树 path（272 节点量级，全量重算可接受）。
- 未激活成员照常入 membership（展示需要「在树但标灰」）；**消费侧按需排除**：推送排除禁用用户，授权不排除（未激活者登录不了，天然无效）。

### 3.2 同步 job（固化 §1.6 已验证的方法）

**形态**：platform-core 内置 job（同 seed/syncer 的手动触发模式起步；定时待稳定后议）。

**双轨取 token**（按租户配置判定，判据 = clientId 前缀，§1.3）：

```
自建应用：gettoken(corpId, corpSecret)              -- secret 来自租户配置；须从 IP 在白名单的机器调
代开发：  get_suite_token → permanent_code（已有）→ gettoken(corpId, permanent_code)
```

**流程**（每次全量对账式，量级 272 部门/474 人，秒级）：

1. 拉企微 `department/list` + `user/list?fetch_child=1`；
2. **fail-closed 门**：部门数 = 0 或 < 上次快照 × 0.5 ⇒ 失败告警，不写库（防 §1.2 静默缺口复发）；
3. dry-run 模式（缺省）：输出「新建 N 节点 / 重挂 M 子树 / 新增 K 成员 / 禁用 J 人」清单；
4. apply 模式：upsert org_node/org_membership（只增改；企微消失 → status=0 / membership 删除行）；**不写 Casdoor**（用户建号见 §3.5）；
5. 落一行同步审计（快照摘要 + diff 数），供对账。

**三条硬纪律**（写进 job，不是写进文档）：只读企微绝不反写；0 部门即失败；不物理删人。

### 3.3 消费点一：console 组织树页切源

`GET /api/platform/admin/org-tree` 与 `/org-tree/members` 改读 org 表（后端实现替换，前端契约不变）。Casdoor groups 不再被该页读取。验收：页面上树形/成员与企微逐节点一致（含共享中心→数字技术部链）。

### 3.4 消费点二：报表部门门

- `data.reports` 加列 `required_depts jsonb`（NULL = 无部门门，维持仅 scope 判定——向后兼容，存量两行均为 NULL）；
- 判定（`reports.ts` 增补，与 `visibleTo` 同构）：
  ```
  可见 = 持 data:query 且（required_depts 为空
          或 用户部门集（含祖先链）∩ required_depts ≠ ∅）   -- D-O3/D-O4
  ```
  用户部门集在**会话刷新时**（session-middleware 既有 5min 周期）一并从 org_membership 取出、进 session（部门数个位/人，载荷可忽略）；管理面（`data:manage`）不受部门门限制（否则没人能改门）。
- console 报表配置 UI：scope 下拉旁加部门树多选（空 = 全员）。

### 3.5 消费点三：推送部门接收人

- notify 接收人类型增加 `{type:'dept', extId}`；发送时解析：org_membership 查该 ext_id（**含子树**）成员 → 排除禁用用户 → 展开 userid 清单交投递通道；
- 解析结果落审计：目标部门、展开人数、排除禁用数、**未解析（企微有平台无）数**——未解析数 > 0 记 warning，不阻断发送；
- 接收人选择 UI：部门树多选 + 实时预览「将发送给 N 人」。

**用户建号归 Casdoor**：同步 job 发现「企微有 / Casdoor 无」时不自动建号（保持 10-26 以来的口径：建号是对外动作，走管理操作/单独批量），只在 diff 中列出待建清单。

### 3.6 与既有体系的关系

- **Casdoor**：人 + 权限码 + 角色不变；`user.groups`/`group.users` 不再写入（D-O5）；
- **effectiveScopes 语义零改动**（部门门在模块/资源判定层，不进 entitlement）；
- **2026-10-24 spec**：D5 按本文 D-O6 修订；其余（D1 后台归属/D2 角色层/D4 手动节奏）不受影响；
- **2026-10-28 已手工对齐的数据**：作为 org 表首次同步的**种子基线**（迁移脚本从 Casdoor groups 灌入 org 表做初值，之后由 job 以企微为准覆盖）。

## 4. 验收

**Phase A（存储 + 同步 + 切源）**：
- 表结构 + 迁移评审通过；
- job 首跑：从企微拉 272/474，与 §1.6 基线 diff 为空（或差异逐条可解释）；
- fail-closed 门：伪造空部门响应 ⇒ job 失败告警（变异验证，非仅 happy path）；
- dry-run 输出可读清单；apply 后组织树页与企微逐节点一致；Casdoor 侧零写入。

**Phase B（报表部门门）**：
- NULL 门 = 存量行为逐字节不变（回归）；
- 授权「共享中心」⇒ 数字技术部成员可见、非子树不可见（D-O3 验证）；
- `data:manage` 持有者越门可见可改；
- UI 亲自浏览器走通（记忆配方）。

**Phase C（推送部门接收人）**：
- 发送审计含展开/排除/未解析三数；未解析 > 0 出 warning；
- 禁用用户收不到；真机企微链路验收（只可用真机轮，CLI 轮不走通道）。

## 5. 明确不做（YAGNI）

部门负责人/排序字段 ｜ console 内编辑组织树（企微权威，平台只读）｜ 部门级默认角色（2026-10-24 spec 已否，维持）｜ Casdoor groups 双写或即时清理 ｜ 代开发轨道实施（**前置条件未满足**：permanent_code 为空 + suite_ticket 断流两个月，需客户重新授权——满足前只保留取 token 抽象位）｜ 同步定时调度（手动起步，稳定后另议）｜ 多租户组织隔离之外的跨租户查询。

## 6. 风险与已知边界

1. **推送新鲜度依赖同步节奏**：手动同步起步 ⇒ 组织变动到推送生效有滞后；靠「未解析数告警 + 对账审计」兜底可见性，待稳定后上定时。
2. **代开发轨道有监控缺口**：suite_ticket 断流两个月无人知。本期顺手补一条探活（ticket 时间戳超 30min 即告警），修复授权另案。
3. **会话内部门集有 5min 陈旧窗口**：与既有 scopes 刷新周期一致，接受；即时失效不在本期。
4. **迁移期双源并存**：组织树页切源前 Casdoor groups 仍是真相之一；切换 PR 必须是**同一变更内前后端同切**（后端换源即前端无感，天然满足）。
5. **凭证管理**：自建应用 secret 的存放与轮换、以及「哪台机器的 IP 在白名单内」属于部署事实，落各租户接入清单（在哪、怎么取，不写明文）。

## 7. 关联

- 前序 spec：`2026-10-24-shanhai-wecom-directory-and-org-admin-design.md`（D5 由本文 D-O6 修订）
- 实测证据主体：本文 §1（源码/官方错误码/双向 IP 对照/凭证可见范围对照，均 2026-10-26~30 真机）
- 执行记录：2026-10-28~29 手工对齐（272 组/475 用户），脚本形态即 §3.2 job 原型
- 待议后续：代开发授权修复（需客户配合）、Casdoor groups 清理、同步定时化
