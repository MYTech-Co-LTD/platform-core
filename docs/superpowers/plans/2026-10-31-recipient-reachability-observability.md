# 收件人可达性可观测（Phase 2）实施计划

> 承接 spec `2026-10-31-recipient-identity-mapping-design.md` §3.4 / issue #1225。
> 目标：把「**这批人收不到**」从「业务消息发出去之后才知道」提前到「平时就能看见」。

## 0. 缺口（一句话）

现有判据只证到「**应用凭据**能换 token」（`notify.channel_probe.last_ok_at`）。
`81013`（收件人不在可见范围）、`missing_channel_address`（地址解析不出）这类**个人级**失败，
今天只躺在 `notify.delivery.last_error` 里，没有业务消息时不可见。

## 1. 三件事

| # | 做什么 | 落在哪 |
|---|---|---|
| A | **抽样可达性**：worker 每轮探针顺带抽 N 个成员调 `user/get`（幂等、不发消息），把 `reachable/unreachable` 记进 `notify.channel_probe` | `modules/notify/domain/channel-probe.ts` + 迁移 009 |
| B | **失败聚合**：按 `(channel, code)` 聚合 24h 的永久失败，超过阈值在日志与读面里点名 | `domain/delivery-stats.ts`（新）+ `/channels` 读面 |
| C | **控制台清单**：通道页显示「可达性」与「地址异常（未解析/被企微拒）」两张小表 | `console/channels.tsx` |

## 2. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 抽样**不进 SLA**：不可达不产生 STALE/PROBE_FAILED | 可见范围是配置问题，纳入 SLA 会天天红（与 `{at,error}` 的「不适用 ≠ 红」同口径） |
| D2 | 抽样**只对直连通道**做（`transport=direct`） | 桥通道没有「本实例成员地址」这回事 |
| D3 | 抽样只调 `user/get`（单用户、幂等、无副作用），**不发消息** | 与判据同一条纪律 |
| D4 | 采样来源 = `org_membership.external_id`（Phase 1 的显式地址）；宿主注入采样器 | 模块不能读 platform schema（B1），组合根可以 |
| D5 | 阈值与窗口写死为常量并注释（24h / ≥3 次同 code），不做配置项 | 先跑起来再谈可配置；写死的小常量比没配的旋钮好 |

## 3. 验收

| # | 判据 |
|---|---|
| 1 | 单测：抽样成功/失败分别落 `reachable/unreachable`；`user/get` 失败不改变 `last_ok_at`（凭据仍活） |
| 2 | 山海实测：`channel_probe` 出现 `reachable ≥ 1`；把某人移出可见范围后 `unreachable` +1（下一轮抽样碰巧命中即可） |
| 3 | 读面：「地址异常」能列出 `missing_channel_address` 与 `81013` 的收件人（本次历史投递即可验证） |
| 4 | 不回归：现有判据仍 OK；抽样异常不影响发送 |

## 4. 不做

- 不做「逐人全量探活」（475 人 × 每分钟 = 打爆企微配额）；只抽样。
- 不做自动修复（把地址改对、扩可见范围）——那是人的决定。
- 不做告警通道（复用 `/channels` 读面 + 日志；真需要再进集成告警面）。
