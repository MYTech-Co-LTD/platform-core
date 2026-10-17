---
name: askdata-tuning
description: Use when the 企微/OpenClaw 问数 bot 表现不确定——反复尝试、用 exec/curl 翻插件源码或猜参数、同一调用原样重试、答错时间窗、或拿不到数；也用于要改它的工具面（tools.allow）、SKILL、工作区指令，或要度量「拿一个数花了多少探索动作」时。
---

# askdata-tuning：问数效果调优（测 → 定位 → 改 → 验）

## 定位

本 skill 是**判据表 + 杠杆图**，不是第二事实源。采集/归因链路的实现与实测记录在
`scripts/askdata/`（`export-transcript.py` / `attribute.py`）与 `docs/superpowers/notes/` 的 T0 交付物里；
本文只回答「**看什么、改哪儿、怎么算过**」。

**核心判据**：问数是否确定，不看「答得对不对」（答对可能是猜对），看
**拿数前的探索动作次数**——`read` / `tool_search` / `tool_describe` / `exec` / 猜参数形状。目标 **0–1**。

## 第 1 步：取轨迹（思考 + 工具序列）

事实源是**会话库**，不是 OTel span（span 里思考是 `redacted`）：

- 路径：`<openclaw 状态卷>/agents/<agent>/agent/openclaw-agent.sqlite` → 表 `transcript_events`
- 列：`session_id, seq(全局单调), created_at(ms), event_json`
- `event_json.message.content[]` 里：`thinking`（正文在 `thinking` 字段）/ `text` / `toolCall{id,name,arguments}` / `toolResult`
- **两个坑**：`content` 可能是**字符串**（user 消息，按 list 迭代会逐字符摊行）；**toolResult 的 part type 是 `text`、角色才是 `toolResult`**（角色优先于 part type）
- 归一化直接复用 `scripts/askdata/export-transcript.py` 的 `norm_parts`（别另写一套口径）

已在跑的自动链路（不必每次手搓）：openship job `custom:chw9WVKDdITzgGya`，每小时把轨迹写进 OO 的
`askdata_conv`，撞墙事件写 `askdata_stuck` / `askdata_stuck_attr`，统计写 `askdata_stats`。

## 第 2 步：判据表（症状 → 该动哪一层）

| 症状（轨迹里看到的） | 归属 | 正确动作 |
|---|---|---|
| 调 `exec` 跑 `ls/cat/curl/env`、读插件源码、循环试参数 | **工具面** | 见第 3 步杠杆 1/2 |
| 满屏 `tool_search` / `tool_describe` | 工具目录桥接 | `tools.toolSearch:false` |
| `Tool exec not found` / `Tool tool_call not found` | ①工具没在白名单 ②并行 XML 调用被误解析 | ①加白名单 ②频率低且自愈，别急打补丁 |
| `BAD_PARAM` / 参数形状错 | 指令面 | SKILL + 工具描述把形状写死 |
| 同一调用原样重试 | 指令面 | 明确「不要原样重试，读 detail 自纠一次」 |
| `truncated` 后未收窄 | 指令面 | 写死「收窄或改 total:true」 |
| `requesterSenderId` 缺失 | **身份链路**（不是问数逻辑） | 告知用户重发；别用其它工具绕过身份 |
| 答的时间窗不对 | 口径面 | 查数据截止 + 日期基准，不是「模型不会算」 |

## 第 3 步：四个杠杆（按优先级）

**杠杆 1 —— 工具白名单（最容易踩错的一个）**

真正管住 bot 的是 **`agents.entries.<id>.tools.allow`**（allow-list）。
**全局 `tools.deny` 对已有 allow-list 的 agent 不起作用**——改了没反应就是这个原因。

- 只给问数：`["list_metrics","query_data", ...]`
- 还要干别的活（需要 shell）：把 `exec` **加进 allow**，再用杠杆 3 防止它抢先用
- 改完**必须重启容器**（`config hot reload` 不一定覆盖工具面）

**杠杆 2 —— `tools.toolSearch: false`**：工具数个位数一律关，否则模型先过「目录→describe→call」三段桥。

**杠杆 3 —— 指令面，两处都要写**

1. **仓内 SKILL** `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`
   —— 构建期 COPY 进镜像，随版本走；改完要**重建部署**才生效。
2. **工作区 `AGENTS.md`**（状态卷 `workspace/AGENTS.md`）—— 立即生效，但 ⚠️ **卷重建会回退**。

规则内容固定三段：取数只走 `list_metrics`/`query_data`；不要为取数用 `exec`/`curl`/读源码/翻 env；
身份类报错如实告知用户重发，不要绕过身份检查。

**杠杆 4 —— 回包面**：`error.detail` 要说清「哪个键、什么毛病」，`total` / `truncated` / `freshness_line`
语义要硬；模型能自纠，就不用背规则。

## 第 4 步：验收（三条件全中才算过）

在**真实渠道**（企微）发一句会调工具的问题，然后从轨迹里读：

1. **整轮工具列表 = `['query_data']`**（零 `exec`、零 `read`、零 `tool_search`）；
2. **第 1 次 `query_data` 就出数**（零重试）；
3. 身份链路正常（真渠道有 `requesterSenderId`）。

⚠️ **CLI 轮不能替代渠道轮**：`openclaw agent --agent <id> -m "…"` 会因**缺 `requesterSenderId`** 稳定失败，
那是 CLI 特性，**不是**线上故障；但 CLI 轮**可以**用来测「工具选择」与「参数形状」。

## 反直觉的坑（都实测过）

- **别写死宿主端口**：openclaw 的 `18789` 每次部署会重映射（见过 20001 / 20002）。
  宿主侧探活要 `docker port <容器> 18789/tcp` 现取；打写死的端口会 `000`，**别据此判「容器没起来」**。
- **部署可能 `partial_failure` 只挂一个服务**：看 `GET /deployments/:id/pending` 拿 keep/reject；
  构建失败若报 `SSH connection reset … streaming command cancelled`，那是**控制面到构建机的链路抖动**，
  不是 Dockerfile/内容问题——用 `serviceIds` 只重建那一个服务重试即可。
- **控制面部署死锁**：`403 ... still finishing cancellation` 且该部署早已 `cancelled`
  ⇒ 查 `build_session` 里该部署的 `finished_at IS NULL`，回填后即解（属平台抢救，需留档）。
- **别用全局 `tools.deny` 当闸**（见杠杆 1），也别指望 `refreshServiceIds` 只刷单个服务。

## 关联

- 实现与实测：`scripts/askdata/`、`docs/superpowers/notes/2026-10-16-t0-span-inventory.md`
- 经验库：WeKnora《OpenClaw 工具面：真正管住 bot 的是 agents.entries…tools.allow》
- 采集/告警纪律：skill `collect-source` / `data-monitor`
