# 通知规则层两处待定：跨服务 emit 认证（D2）与定时器载体（D3）

> 状态：**待拍板**（架构先行：定了才写码）。上游：正典 §2.6、实施计划 `docs/superpowers/plans/2026-10-18-notification-rules-layer.md`（D2/D3 两行）、ADR 0005 §18/§19（explore）。
> 日期 2026-10-18。本文只给**方案对比 + 推荐**，不预设结论。

## 0. 问题：接缝在平台里不存在（实测，不是推演）

T9（forms 填催接线）/ T10（case-engine emit）/ T11（定时器）都卡在同一件事：**「谁调 notify」这条路平台里没有**。

| 事实 | 实测依据 |
|---|---|
| 模块拿不到别的模块 | `ModuleContext = { pool, identityLinks? }`（`packages/platform-sdk/src/module.ts`） |
| 模块端口只有**宿主**能用 | `runtime.port(moduleId, name)` 在 `apps/server/src/app.ts` 调用；全仓唯一用例是 `runtime.port('data','resolvePatKey')` |
| **无模块间调用先例** | 模块的 `domain/` `routes.ts` `storage.ts` 里搜 `/api/modules/` 零命中（console 侧除外，那是浏览器） |
| 认证只有两条通道 | 会话 cookie（通道 A）/ PAT `Bearer dkq_…`（通道 B）；**无服务令牌** |
| 宿主**无**定时机制 | `apps/server/src` 搜 `setInterval`/`cron`/`schedule` 零命中 |

⇒ 任何解法都落在两类里：**（i）不跨模块——把触发放在模块之外**；**（ii）新增机制**（扩 `ModuleContext` / 造服务令牌）。按架构先行，新增机制须人同意。

---

## 1. D3：定时器载体（`form.due_reminder` / `sla.breach_warning`）

### 候选

| # | 载体 | 优 | 劣 |
|---|---|---|---|
| 1 | **openship job**（跑仓内脚本） | 本仓**已有两处先例**；审计口径即此；job 有运行记录与失败通知；**零常驻** | 需要 job 定义（openship 面板建）+ 脚本拿到 DB 凭据 |
| 2 | duckle console `schedules/*.json` | 本仓成熟形态 + 门禁 `check-console-schedules` | 那是 **duckle 管线**专用，拉不动 platform 逻辑（要跑的是「查 forms 到期 → 触发通知」） |
| 3 | case-engine 的 Mastra cron | ADR §17.8 已实证原生 cron | **边界错位**：通知层是 platform-core 的，定时职责外放到每客户引擎包 |
| 4 | platform-core 宿主内置定时器 | 宿主常驻、可直接用 `runtime.port` | 宿主**新增机制**；且与仓内既有原则相悖（见下） |

### 本仓既有口径（强依据）

`deploy/openship-adopt.md` 讲审计保留清理时写死了一句原则：

> 清理由 **openship job** 定时执行，**应用进程不自己跑**（有副作用的运维动作不该藏在一个 HTTP 服务里）。

同文另一处（`deploy/data-compose.yml`）：dbt runner 的调度是 **openship jobs 打 `docker run`，零常驻**。

### 推荐：**1（openship job）**

理由：与审计口径、与仓内两处先例、与那句原则三者一致；且候选 4 直接违反该原则。

### 关键推论：「甲」由此**不需要任何新机制**

job 跑的是**仓内脚本**（照 `deploy/data-compose.yml` 的 dbt runner 范式：openship 打 `docker run` 一个一次性容器），
脚本可以**直接 import notify 的 domain/storage 对 DB 操作**——因为它在同一个仓、写的是 notify 自己的 schema。
⇒ **in-platform 这一半（填催派生 + 到期触发）既不需要 HTTP，也不需要令牌，更不需要跨模块通路。**

于是「甲」的落地形状是：

```
openship job（每日/每小时）
  → 一次性容器跑 scripts/notify-reconcile.mjs
      ① 读 forms 的催办声明（forms schema）→ upsert 派生规则（notify schema）
      ② 查 forms 到期未提交 → 逐条 emit（notify pipeline）
  → 日志写回执条数与派生条数（便于 job 日志核对，照 prune_audit 的记账口径）
```

> ✅ **已核（2026-10-18）**：`scripts/lint-architecture.mjs` 的扫描根 = **`apps/ + packages/ + modules/`**
> （文件头第 8 行与第 49 行两处一致）——**`scripts/` 不在扫描根内** ⇒ 仓内脚本 import `modules/notify/**`
> **不触 B1**。落地方案成立，无需改门禁。

---

## 2. D2：跨服务 emit 认证（case-engine → platform-core）

### 前提（§19 已钉死，不在本文讨论范围）

跨服务调用**必须携 org 并显式校验**，不一致 fail-closed；**禁止「不带 org 的内网调用」通路**。

### 候选

| # | 机制 | 优 | 劣 |
|---|---|---|---|
| 1 | **复用 PAT（通道 B）+ 一枚专用服务账号** | 零新机制；既有实时 scopes 校验、限速（60/分）、审计、`fail-closed 503`（Casdoor 故障时） | PAT 的既有语义是「系统外**个人** Key」；服务用它语义别扭 ⇒ 需一个**非人**账号承载（不绑真人，避免离职即断） |
| 2 | 新造服务令牌（宿主层，per-tenant） | 语义正确（机器对机器） | **新机制 + 新正典 + 新密钥管理面**；且它不带用户上下文，泄漏后果比 PAT 更重 ⇒ 要另立防护与轮换纪律 |
| 3 | 靠网络位置（内网即信任） | 零成本 | **§19 已明文否决**（「不得以『内网才可达』豁免」） |

### 推荐：**1（PAT + 专用服务账号）**

理由：**能消失的机制面就让它消失**（同 `pat-auth.ts` 自己的哲学——哈希与查询留在模块侧、宿主侧不留第二份）。
新造服务令牌是「为 v1 规模付新基建」，与 §2.6 不做清单里「不建队列 / 不建 notifier 服务」同一取舍。

**配套（落地时须做）**：
- 服务账号的 scopes **只给 `notify:emit`**（最小权限，照安全基线第 6 条）；
- 该账号的 org 即其所属租户 ⇒ 天然满足「携 org」；接收端仍按 §19.1-2 校验「本实例 ↔ org」一致；
- PAT 前缀 `dkq_` 与限速沿用，不新增凭据类型；
- **待核**：Casdoor 侧「非人账号」怎么建（是否用普通 user + 不绑企微/SSO）。**未核前不写码。**

---

## 3. 结论与待拍板

| 项 | 推荐 | 依赖 | 拍板后解锁 |
|---|---|---|---|
| **D3** | openship job（跑仓内脚本，照 dbt runner 范式） | 无（本仓已有先例） | **T9**（甲）与 **T11** 一并可动 |
| **D2** | 复用 PAT + 专用服务账号（仅 `notify:emit`） | Casdoor 侧「非人账号」建法待核 | **T10**（乙） |

**两处都定下来，T9/T10/T11 一起通**；**不新增跨模块机制**（扩 `ModuleContext` 这条路本文不推荐：它把「模块间可互相纠缠」变成默认能力，而当前只有一处真实需求）。

**仍不推荐、且本文未采纳的**：扩 `ModuleContext` 加 ports（放大耦合面，收益不足）；宿主内置定时器（违反仓内原则）。
