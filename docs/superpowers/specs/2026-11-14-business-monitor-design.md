# 业务监控（指标 / 报表面板 → 通知）——设计（Wave 7 V1）

> 状态：2026-11-14 与用户逐条确认。上游底座：`2026-11-14-business-scheduler-design.md`（Wave 6）。
> 与 OpenObserve 的分工见 §3；判据来源与红线见 §4。
> 一句话：**给 agent 与业务人员一个「把这个指标/这张报表盯起来」的能力，语义求值在平台，告警不走运维面。**

## 1. 背景：我们要盯的到底是什么

用户的原始诉求是「给报表某个指标挂上监控，达到条件后触发通知」。但回顾本平台的真实失败形态，
**最贵的不是数值越界，是数据没了没人知道**：

- 某门店采集断供 5 天，靠人工核行数才发现；
- 接口改版静默 0 行，契约拒写；
- 对账链路停摆两天，readback 假绿。

阈值告警属于「业务想要」，断供/迟到属于「业务会亏钱」。两者都要，但**优先级与实现成本不同**：
`missing`/`stale` 是**读水位**（元数据查询，几乎不花钱），`threshold` 要跑指标编译 + 只读池（真实算力）。
所以 V1 先做便宜的那两类，把状态机、影子期、投递期校验全部验证透，再上阈值。

## 2. 目标 / 非目标

**目标**：人/agent 能把「某指标」或「某报表面板」挂上监控；条件成立时按状态机发通知；
监控本身可审计、可暂停、可复盘。

**非目标**：
- 不做系统/接口/进程/管线监控（那是 OpenObserve，见 §3）；
- 不做任意 SQL / 表达式 DSL / 自定义脚本（安全与可维护性红线）；
- 不做告警分组、抑制、on-call 升级（未到那个规模，见 §12 退出条件）；
- 不在业务监控里重算数据面水位（§4 红线 1）。

## 3. 与 OpenObserve / 数据面的分工

### 3.1 判定测试（一句话分界）

> 这条告警的对象，是「**一台机器 / 一个进程 / 一条流 / 一个管线**」，还是「**一个业务口径（指标 / 报表面板）**」？
> 前者 ⇒ **OO**；后者 ⇒ **业务监控**。两边都不是 ⇒ 不告警。

**这个边界必须是结构性的**：monitor 的 `target_kind` 是枚举，只允许 `metric | report_panel`；
工具与 console 的文案明确写「接口 / 进程 / 管线请用 OpenObserve」。**让越界的目标在类型层面不可表达。**

### 3.2 三层职责（沿用正典，不新造层）

正典分工在 `docs/data-platform-handbook.md` §1.5.3（追踪 #538）+ `.claude/skills/data-monitor`：
OO=预警面、openship=基建、数据面=判据。业务监控**不新增第四层**，它是「判据层」在平台侧的执行者。

| 层 | 拥有 | 明确不拥有 |
|---|---|---|
| **OO（预警面）** | 遥测（logs/metrics/traces）、探针流、流静默、**引擎自身健康**、告警状态机与静默 | 指标 id、租户口径、报表 ACL、业务收件人 |
| **数据面（判据）** | 采集/物化水位（`data.load_log`、`metric_freshness`）、管线断供与迟到 | 业务收件人、对外通知 |
| **业务监控（判据·平台侧）** | 「某指标 / 某报表面板」的语义监控、收件人与可见性、状态与冷却 | 采集遥测、重算水位、监控自己 |

### 3.3 四条红线

1. **不重算水位**：`stale`/`missing` **直接读数据面已有水位**，不自己扫湖。
2. **不监控自己**：监控引擎活没活交给 OO（+ 第二条独立路径，见 §10）。
3. **同一对象只有一个 owner**：同一根因只由一层发告警；业务侧若发现上层已报，只发给**业务收件人**。
4. **告警出口归一**：OO 走 bridge、openship 走基建告警、业务监控走 notify，最终收敛到同一企微出口。

### 3.4 为什么不让 OO 直接承载业务监控

有一条更省的路：业务侧只求值打点，阈值/状态/去重全交给 OO 规则（Datadog/CloudWatch 形态）。**不采用**：

1. OO 规则靠**手动 sync** 落地（PR → tarball sync → 验 `AUD_OK`），支撑不了 agent 自助建 N 条；
2. OO **没有租户语义**（不认 `metric_id`、部门可见性、收件人），塞进 tag 等于在 OO 里重造权限模型；
3. 会污染运维面——业务人员建的监控出现在 OO 里，正是要避免的「业务压力放运维平台」。

**OO 继续只做系统层预警与观测；业务语义层求值留在平台。** 业务监控的 firing 事件**默认不镜像进 OO**；
若要镜像，只允许 `{monitorId, state, verdict}`，**不带数值、不带阈值**（`reveal='report'` 的指标数值一旦进 OO，
任何有 OO 权限的人都能查——那是数据泄露）。

## 4. 不变量

1. **目标与条件都是闭集**：`target_kind ∈ {metric, report_panel}`；`verdict ∈ {missing, stale, threshold}`。
   永不引入表达式 DSL 或任意 SQL。
2. **求值身份 = 创建者**（不是收件人）；创建者失活 ⇒ 自动暂停 + 通知，**不允许静默地用旧权限继续跑**。
3. **收件人两道门**：创建/启用时校验，**投递时复判**（部门会搬、ACL 会改、`owner_dept` 会变）。
4. **只在状态跃迁时发一条**，不是每次求值都发。
5. **判不了 ≠ 没问题**：水位读不到 ⇒ `unknown`，默认不发但可见、计入健康。
6. **新建监控默认影子期**（`dry_run=true`）：求值 + 记录，不投递；显式开启后才发。

## 5. 对象模型

```sql
create table if not exists data.monitor (
  id                bigserial primary key,
  org               text not null,
  name              text not null,
  target_kind       text not null check (target_kind in ('metric','report_panel')),
  metric_id         text,             -- target_kind='metric' 必填
  report_id         text,             -- target_kind='report_panel' 必填
  panel_index       integer,
  filters           jsonb not null default '{}'::jsonb,
  verdict           text not null check (verdict in ('missing','stale','threshold')),
  operator          text check (operator in ('gt','gte','lt','lte','eq')),  -- 仅 threshold
  threshold         numeric,                                                 -- 仅 threshold
  window_days       integer not null default 1,
  cadence_secs      integer not null,
  cooldown_secs     integer not null default 3600,
  dry_run           boolean not null default true,
  recipients        jsonb not null,          -- [{kind:'dept'|'user', ref:'…'}]
  channel_policy    text not null default 'in_app' check (channel_policy in ('in_app','wecom','webhook')),
  state             text not null default 'ok' check (state in ('ok','firing','unknown')),
  state_since       timestamptz,
  last_eval_at      timestamptz,
  consecutive_fail  integer not null default 0,
  enabled           boolean not null default true,
  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists monitor_due_idx on data.monitor (org, last_eval_at) where enabled;

create table if not exists data.monitor_run (
  id          bigserial primary key,
  monitor_id  bigint not null references data.monitor(id),
  org         text not null,
  evaluated_at timestamptz not null default now(),
  verdict     text not null,                 -- 本次判定
  value       numeric,                       -- 可空（missing/unknown）
  watermark_ref text,                        -- 上游水位/探针标识（相关性，见 §9）
  state_after text not null,
  notified    boolean not null default false,
  dry_run     boolean not null default true,
  duration_ms integer,
  error       text
);
create index if not exists monitor_run_monitor_idx on data.monitor_run (monitor_id, evaluated_at desc);
```

迁移编号：`modules/data/migrations/049_business_monitor.sql`（048 已重号两次，本波用 049 且一次用尽）。

## 6. 判据定义（精确到可测）

| verdict | 判定 | 数据来源 | 备注 |
|---|---|---|---|
| `missing` | 窗口内该指标/面板**行数为 0** | 指标查询（`rowcount=0`） | 报表面板取面板聚合后的行数 |
| `stale` | 指标依赖关系的**水位**早于 `now - window_days` | `data.load_log` / `metric_freshness` | **读水位，不扫湖**；`watermark_ref` 记录来源 |
| `threshold` | 窗口聚合值与阈值比较（`operator`） | 指标查询（只读池） | V1 后段实现 |

**`unknown`**：判定所需输入不可得（水位表读不到、查询超时、编译失败）⇒ **不是 `missing`**。
默认行为：不发通知，`monitor_run.verdict='unknown'`，`state` 保持原值，`consecutive_fail+1`。

## 7. 状态机与抑制

```
ok ──越界──▶ firing      （发一条 firing 通知）
firing ──回正常──▶ ok    （发一条恢复通知；可与 firing 合并计一个冷却窗）
任意 ──判不了──▶ unknown （不发；可见；连续 unknown ≥ N ⇒ 视为故障，通知创建者）
```

- **只在跃迁时发**；同一状态重复求值不发。
- `cooldown_secs`：跃迁后这段时间内的重复跃迁不重复发（防抖）。
- `no_flap`（连续 N 次才跃迁）**V2 再做**——V1 先保证「第一次越界就有人知道」。

## 8. 求值与资源

- **身份**：创建者。创建者失活/被删 ⇒ 监控自动 `enabled=false` 并通知 owner（**fail-visible**）。
- **cadence 下界**：`stale`/`missing` 的求值周期**必须晚于水位刷新一个档**（例：物化 2h 一更 ⇒ 不得小于 2h），
  否则每次都是误报（同「探活容差错位致预警风暴」的坑）。`threshold` 最小 15 分钟。
- **资源**：走只读池（`analystPool`），受既有并发闸；每次求值 `statement_timeout` 复用明细面配置。
- **规模上限**：单实例约 200 条规则 @1 分钟 tick；超出按 `org` 分片（写进实施计划的容量判据）。
- **引擎**：`data.monitor_tick` 是调度器 registry 里的**一个 key**（每个实例一条 schedule），
  tick 遍历到期规则——**agent 不创建 tick 的 schedule**，只创建规则行。

## 9. 投递与相关性

- **事件**：`data.monitor.fired` / `data.monitor.resolved`（在 `modules/data/manifest.yaml` 的
  `notifications.events` 声明，`ctx.notify.emit` 发出；模板与规则由通知板块 seed）。
- **收件人**：复用既有部门→地址映射（不新造收件人体系）；创建期校验 + **投递期复判**，
  越权收件人静默剔除并落审计。
- **文案**：默认带指标名、窗口、当前值；`reveal='report'` 的指标**不带值**，只说「有异常，请登录查看」。
- **相关性**：消息带 `watermark_ref`（上游水位/探针标识），使「你的指标没数」能指向「疑因：采集 3120 断供」。

## 10. 健康与自监控（双路径）

- tick 写 `platform.job_heartbeat('scheduler')`（复用调度器心跳），并写 `monitor_tick` 自身的心跳行。
- **路径 A**：OO 对心跳流做「流静默」规则（系统面）。
- **路径 B**：`scripts/check-probe-heartbeat.mjs`（openship 基建 job）同时检查 monitor tick 心跳。
  两条路径互不依赖，避免「OO 状态机冻结 ⇒ 引擎死了没人知道」。

## 11. 治理

- **配额**：每 namespace 最大监控数（建议 20）、最小间隔、每日最多 firing 条数。
- **组织级限流**：每 org 每小时 firing 上限（建议 50），超出合并为一条「已抑制 N 条」摘要。
- **熔断**：`consecutive_fail ≥ 5` ⇒ 自动 `enabled=false` + 通知创建者（防止一条坏规则永远空转）。
- **租户开通**：新租户 provisioning 必须 seed `data.monitor_tick` 的 schedule（否则新租户静默无监控）。
- **月度评审**：沿用采集/指标月度评审，检查「从不触发」「每次都触发」「无人读」的监控，该停就停。

## 12. build vs buy 的退出条件

以下任一成立 ⇒ 重新评估改用 Grafana/Alertmanager 或 OO 承载业务监控：
① 需要 on-call 值班表与多级升级；② 规则 > 500 或需要分组抑制；③ 需要 3 个以上通道的策略化路由；
④ 需要跨服务/跨租户关联分析。**没有这些之前，自建是合理的**；有了其中一条，就应该买/换而不是继续加功能。

## 13. 测试策略（先证伪）

- 水位缺失 ⇒ `unknown` 而**不是** `missing`（核心用例）。
- 窗口内 0 行 ⇒ `missing`；窗口内有数但水位旧 ⇒ `stale`。
- 收件人在创建后退权 ⇒ 投递期复判剔除 + 审计，消息仍发给剩余合法收件人。
- `reveal='report'` ⇒ 文案不含值、不含阈值。
- 抖动：1 分钟内 ok↔firing 反复 ⇒ 冷却期内只发一条。
- `dry_run=true` ⇒ 只写 `monitor_run`，`notified=false`，不产生任何 notify 事件。
- 创建者失活 ⇒ 自动停用 + 通知。
- 连续 5 次求值失败 ⇒ 自动停用。
- 指标退役引用面：被 monitor 引用的指标**不得**进 `metric-retire` 候选（见 §14）。

## 14. 与既有系统的接线（最容易漏的几条）

1. **指标退役引用面**：`metric-retire` 目前只排除「被报表引用」的指标。**monitor 是新的引用面**——
   必须加进 `retireEligibleOf` 的排除条件，否则 job 会提议删掉正在被监控的指标。
2. **指标可见性变更**：指标变成部门归属后，收件人可能越权 ⇒ 复用 §9 投递期复判；必要时自动暂停并通知。
3. **报表 ACL/受众变更**：`report_panel` 型监控跟随报表发布门（P5）同一套受众口径。
4. **审计**：创建/启停/触发/停用全部落 `data.asset_audit`（谁、何时、当时的值）。
5. **通知模板**：`data.monitor.*` 必须 seed 模板与派生规则（否则 `no_rules` 静默丢弃——本仓已有先例）。

## 15. 分期

| 期 | 交付 | 验收 |
|---|---|---|
| **W7-V1** | `data.monitor` + `monitor_run` + `data.monitor_tick`（调度器 key）+ `missing`/`stale` 两判据 + 状态机（ok/firing/unknown）+ cooldown + `dry_run` + 报表页「挂监控」入口 + 通知事件与模板 + 退役引用面补全 | 影子期一周：误报率可量化；开启投递后连续 7 天无重复/无漏发；被监控指标不出现在退役候选 |
| **W7-V2** | `threshold` 判据 + 恢复通知细化 + `no_flap` + 外发通道（审批）+ 组织级限流摘要 | 阈值监控在影子期无洪水；外发未审批不可生效 |
| **W7-V3（触发式）** | `change_pct`、异常检测、跨租户关联 | 有真实需求再做 |

## 16. 风险与已知边界

1. **阈值由 agent 定，第一版一定不准** ⇒ `dry_run` 默认开、一周影子期是硬门。
2. **业务告警与 OO 告警可能同时出现** ⇒ 靠 `watermark_ref` 建立相关性，靠「不同受众」避免重复推送。
3. **监控自身成为成本源**（每次求值一条查询）⇒ 容量上限 + cadence 下界 + 只读池并发闸。
4. **测试数据与真实水位不同步** ⇒ 影子期必须在生产库跑，不在测试库跑。
5. **多租户隔离**：规则、运行台账、收件人一律按 `org` 收敛；跨租户读取在 SQL 层禁止。
6. **长期归属**：V1 放 `data` 模块（要用指标可见性与只读池）。**抽取触发条件**：当监控目标扩展到
   非指标目标（管线 SLA、接口可用性、外部系统）时，抽出独立 `monitor` 模块——**现在不抽**。

## 17. 验收指标

| 指标 | 目标 |
|---|---|
| 断供类故障被人工发现的比例 | 0（全部由监控先发） |
| 影子期误报率 | 开启投递前可量化并收敛到 ≤ 20% |
| 同一事件重复通知 | 0（按状态跃迁 + 冷却） |
| 越权收件人收到消息 | 0（投递期复判） |
| 被监控指标被提议下线 | 0（退役引用面已补） |
| 监控引擎死亡未被发现 | 0（双路径心跳） |
