# 集成健康一等公民：让「装完就忘」在结构上不可能（设计）

> **状态：待用户 review（2026-10-31 起草）。** 按架构先行，review 通过后开 issue 分三期实施；
> 实施中任何方向/范围调整，先改本文再动码。
> 触发：woke 代开发 `suite_ticket` 自 2026-08-30 起断流两个月**零信号**，直到排查组织架构时才偶然发现。

## 0. 一句话

出站集成（回调 / 凭据 / 通道）**接入时必须回答「凭什么判它活着」**；答不出来就过不了门禁。
判据本体是纯函数、定时喂、结论可查；告警走既有单通道。

## 1. 证据：三类失效，两个洞

| 真实失效（2026 年） | 本质 | 当时有无信号 |
|---|---|---|
| woke `suite_ticket` 停推两个月 | **回调型集成「该来的没来」**——没有调用方，所以永不失败 | ❌ 零信号 |
| 山海 `wecom_default` 通道 bridge env 未配 | 静态配置缺失 | ✅ 已修（`configured` / 未配置标红） |
| 控制台预检 `scope_holders` 恒 0 人（#1179） | 代码语义错位 | ❌ 只能靠真机点验发现 |

第三类是代码缺陷，靠测试与真机验收兜（已有教训沉淀）。**本文解决第一类**——它不被任何
「有调用才失败」的机制覆盖：

- 引擎原生告警：只在**有事件**时评估；
- 投递失败/重试：只在**有投递**时产生；
- 容器健康检查：只证明**进程**活着，不证明**集成**活着（进程可以 200 而 token 已死）；
- openship job 失败：只在**有 job** 时产生，而「装完就忘」的集成根本没有 job。

⇒ 结构性缺口：**没有任何机制要求「一个新集成必须自带活性判据」。**

## 2. 设计

### 2.1 核心原语：Integration 登记 + 判据纯函数

```
Integration {
  id            唯一标识（如 wecom-suite-ticket / wecom-bridge / alipay-callback）
  kind          callback | token | channel
  source        判据来源（SQL / HTTP / 本地文件时间戳）——由探针 job 解释
  slaSeconds    允许多久没有「活着」的证据
  org?          可选：租户维度（多租户同一集成各算各的）
  enabled
  lastOkAt      最近一次「活着」的证据时间（由探针写回）
  lastProbeAt   最近一次探测时间
  lastError     最近一次探测的失败摘要
}
```

判据本体是**纯函数**（`judge(now, lastOkAt, slaSeconds, probeResult) → verdict`）：

- `OK` —— 探针成功，或证据未过 SLA；
- `STALE` —— 最近证据超过 SLA（含「从来没有过证据」= 从接入那一刻起就算超期）；
- `PROBE_FAILED` —— 探针本身跑不通（连接不上、查询报错）——**与 STALE 分开**：
  前者是「探不了」，后者是「查了，确实没动静」。混码会把部署问题误导成业务故障。

### 2.2 三种 kind 的判据语义（各自回答一个不同的问题）

| kind | 回答的问题 | 典型实现 | SLA 取值依据 |
|---|---|---|---|
| `callback` | **该来的推送来了吗** | 查「最后一条回调落库时间」（企微 suite_ticket 每 10min 推 ⇒ SLA 30min） | 推送周期 × 3（容忍一次丢包 + 一次重试） |
| `token` | **现在还能换到凭证吗** | 主动 dry-run 一次取 token（不落库、不产生副作用） | 取 token 幂等 ⇒ 每日 1 次即可；SLA = 26h（容忍一次跳过） |
| `channel` | **最近一次真投递成功是多久前** | 查 `notify.delivery` 最近一条 `status='sent'` | `max(业务预期发送间隔, 24h)`；无预期流量时**不设**（见 §5） |

关键：`token` 是**主动**的——它是唯一能覆盖「没人调用、凭证已死」这个洞的形态。

### 2.3 落点：`platform.integration` + 宿主探针

- **表在 `platform`**（`platform.integration`，迁移 `apps/server/src/migrations/014`）：
  集成健康是平台原语，跨模块（notify 通道、auth 回调、业务回调）共用一张表，与 org 表同构。
- **判据纯函数在 `apps/server/src/integration-health.ts`**（宿主代码，可穷举单测，不碰 IO）。
- **探针薄壳 `scripts/integration-probe.mjs`**：读表 → 按 `source` 取证据 → 调判据 → 写回
  `lastOkAt/lastProbeAt/lastError` + 写一行结论。
  - 为什么是脚本：`scripts/` 可读 platform schema（B1 只约束 `modules/**`），且已有同款先例
    （`notify-worker.mjs` / `notify-seed-builtin.mjs`）。
  - 调度：并入既有 `notify-worker` 容器的循环**或**独立 openship job（Phase 2 定，见 §4）。
- **读面 `GET /api/platform/admin/integrations`**（`tenant:admin`）：控制台一屏，显示每个集成
  「多久没消息 / 上次错误」，让状态**先可见**。

### 2.4 告警：复用既有的单出口，不新造

- 结论落 `platform.integration` 后，由 **notify 模块**发一条内置事件
  `platform.integration.stale`（`email`? 不——用既有 `wecom`/`in_app` 通道），收件人 = `tenant:admin` 持有者。
- 为什么走 notify 而不是 OO：新框架里 notify 就是出站门面，通道、模板、重试、审计、冷却都在位；
  引入第二个告警面会造出「谁才是权威」的双事实源（同 `docs/data-platform-handbook.md` §1.5.3 的分工理由）。
- **fail-open 的有意边界**：告警本身可能发不出去（通道坏）。为此设**元级看门狗**：
  探针每轮写心跳；心跳超 2× 周期未更新 ⇒ 由 **openship job 失败**兜底（job 崩溃级属基建，符合
  「告警单出口」红线的例外条款）。看门狗只盯「探针本身跑没跑」，不重复判业务语义。

### 2.5 门禁：判据是接入的一部分

- 新增集成时，必须在 `deploy/integration-registry.json`（唯一事实源）登记 `{id, kind, source, slaSeconds}`；
- `scripts/check-integrations.mjs`（新守卫，进 gates job）核对：
  1. registry 里每条都有实现（`source` 类型可实现、`id` 不与已用冲突）；
  2. **manifest 里声明的 `notify` 通道 provider / 新回调路由 ⇒ registry 必须有对应条目**，
     缺失即红（"装了没判据"不允许合并）；
- 与 `api.internal` 的「声明即授权」同构：**声明即判据**。

## 3. 数据流

```
registry.json ──(门禁)──✓
      │
      ▼
platform.integration ──► 探针 job（每 N 分钟）
      ▲                        │
      │                        ├─ callback: 查回调落库时间
      │                        ├─ token:    dry-run 取 token
      │                        └─ channel:  查 notify.delivery 最近 sent
      │                        ▼
      └──── 写回 lastOkAt ── judge() ── verdict
                                       │
                        ┌──────────────┴──────────────┐
                        ▼                             ▼
              notify 事件（stale 才发）        控制台「集成健康」一屏
```

## 4. 分期与验收

| Phase | 内容 | 验收（必须真机） |
|---|---|---|
| 1 | 迁移 014 + `integration-health.ts` 判据 + 单测 + `GET /admin/integrations` + 控制台一屏 | 三个 kind 各一条 fixture；**变异验证**：把 `lastOkAt` 手工推到 SLA 之外 ⇒ 判据变 STALE（断言落库/读面） |
| 2 | 探针 job + 真实 evidence 源（先覆盖现有三类：企微 bridge 通道、企业回调解密时间、Casdoor token dry-run）+ notify 事件接线 | **人为制造一次真红**（断开 bridge / 停回调）⇒ 企微收到一次 `platform.integration.stale`；恢复后下一轮转 OK |
| 3 | `check-integrations.mjs` 门禁 + `deploy/integration-registry.json` + 协议文档（`docs/module-protocol.md` 增「接入必带判据」） | 故意删 registry 里一条被 manifest 引用的条目 ⇒ gates 红 |

Phase 1 只让状态**可见**（无告警），Phase 2 才产生告警——先可见、再告警。

## 5. 明确不做（YAGNI）

- **不给「无流量集成」造假的活跃判据**：没有预期发送流的通道，SLA 设不了就别设，
  宁可不监控也不要造一条永远 OK 的假信号（`channel` 类要求先回答「多久没发算异常」）。
- **不做依赖拓扑/影响面分析**（谁依赖谁）：当前只有个位数集成，YAGNI。
- **不接管 openship 的容器/进程层健康**：那层的权威仍是 openship，本设计只覆盖「进程活着但集成死了」。
- **不做自动修复**（重新授权、重配 env）：都是对外/高危动作，只报不修。

## 6. 风险与边界

1. **探针自身的可靠性**：探针挂了 = 又回到静默。故 §2.4 的心跳看门狗是**必须项**，不是加分项。
2. **token dry-run 可能触发限流**：SLA 取 26h、每集成一天一次，量级可忽略；若某集成有更严配额，
   在 registry 里把 SLA 调大而不是取消判据。
3. **误报成本**：`STALE` 的常见原因是「对方还没推」而非故障，故 SLA = 周期 × 3，且事件带
   `lastOkAt` 与 `slaSeconds` 明文，方便一眼判断是否真故障。
4. **多租户**：同一集成不同租户各算各的（`org` 维度），`registry` 只登记形状，不登记值。

## 7. 与既有体系的关系

- **notify**：本文只**新增**一个事件 + 复用其通道；不改投递协议。
- **data-platform-handbook §1.5.3**：那份定的是「数据面判据走 OO/桥」；本文定的是「**新框架自己的出站集成**」
  怎么判活——两者不冲突：数据面判据仍归 OO，平台集成判据归本机制（同属「判据归数据面，告警单出口」原则）。
- **`configured`（#1188）**：那是**静态**检查（env 有没有），本文是**动态**检查（活着没）；两者互补，
  静态的先跑（接入时），动态的持续跑。
