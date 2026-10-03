# tick L1 `_ops` 观测行投递（#406）——设计 + 方言 + 验收

> 2026-10-03 · 触发：观察期巡检发现 OO 流 `retail_day` 只有 1 行 bootstrap（09-28 连通性测试），
> 而tick 面板管线已连跑数日全 ok——「链路在跑」与「观测面看得见」之间断了一截。

## 1. 缺口（实测证据）

| 事实 | 出处 |
|---|---|
| OO `retail_day` 流内仅 1 行（`job=bootstrap`，2026-09-28） | OO SearchSQL 全量 GROUP BY job |
| tick L1 每 5 分钟跑、连续数日 `last_run_status=ok` | 两个 console 的 `schedules.json` + `runs/` |
| console 的 OO 摄取 env **齐**（OO_BASE/OO_ORG/OO_AUTH），`data_alerts` 流照常在进 | console `env` 只读枚举 + OO 流现状 |
| `_ops` 行的原投递者 = 薄壳 wrapper（`OPS_STREAM=retail-day` → OO `_json`），09-29 随 Wave D 退役 | `9b340ef^:scripts/lemeng/run-retail-day.sh` L255-310 |
| OO 告警 `retail_tick_absent_business_hours` 因此停在 paused（启用即永久假告警） | 告警自述 + 本巡检 |

⇒ 通路在、没人在发。**「营业时段链路停摆」这一档当前没有告警面。**

## 2. 方案（选定：管线内投递）

`lemeng.retail.tick.l1.json` 增两节点三边（其余逐字未动）：

```
su（每窗汇总）
 ├→ rep / sr / …（原有扇出不动）
 ├→ op（code.sql：行成形）                        ← 新
 │    ts=now() ISO / job='retail-tick' / system_book=${ENV:SYSTEM_BOOK}
 │    / bizday / hour / rows / status / run_token —— 缺口窗（status=missing）也投，
 │    与 wrapper「每窗一行」同形
 │→ wh（snk.webhook）                             ← 新
      POST ${ENV:OO_BASE}/api/${ENV:OO_ORG}/retail-day/_json
      Authorization: Basic ${ENV:OO_AUTH}（headers 手写，snk.webhook 无 basic 档）
      retryAttempts=3 / retryBackoffMs=2000 / continueOnFailure=true
 wh ──on-subjob-ok──→ a2（先投递后判红，对齐 wrapper 语义）
```

- **为什么不另起一条 ops 管线**：那会把「行存在」与「tick 真在跑」解耦成两件事——ops 管线重发旧
  summary 会制造**假存活**，要么再加新鲜度闸（多一套件）；管线内投递天然「行在 = run 在」。
- **为什么挂 `su` 而不是收据目录**：`su` 的输出就是本次 run 的每窗成色（含 missing），零额外读盘。

## 3. 方言与取舍（排障前必读）

1. **stage 错误必然 run 红**（survey §4 实测；`continueOnFailure` 只保后续 stage、不消红）。
   ⇒ OO 持续不可达时 tick run 红。该时刻 OO 告警链**整体致盲**（data_alerts 也在 OO 里），无企微噪声；
   代价是运行记录红——**排障先看 error 是不是 observe.hookflow.cn**，别当采集失败。
2. `wh→a2` 触发边让判红**等**投递：观测行落了 dz 才说话；`wh` 软失败时 a2/dz 可能不触发，
   但 run 已因 stage 错误红——状态面不丢，丢的只是 TICK_FAILED 文案（可接受，已记档）。
3. `${ENV:}` 进 sink 属性（url / **headers 值**）有 bucket/key 先例，但 **headers 值内替换未经生产验证**
   ⇒ 投递后首个 run 必查 OO 真收到行（§5 验收 2）；401 = 替换没生效的第一嫌疑。
4. 行量：每 run 1–2 行 × 每 5 分钟 × 两账套 ≈ 12–24 行/时/账套，OO 侧可忽略。
5. OO 端点把流名 `retail-day` 清洗成 `retail_day`（连字符→下划线，2026-09-28 实测）——
   告警 SQL 按 `retail_day` + `job='retail-tick'` 查，与行形状对齐。

## 4. 已过的门（本 PR 内）

- `duckle validate_pipeline`：21 stage 编译过（`op` 读 `su`、`wh` 在 `a2` 前）。
- `check-duckle-catalog`（真引擎 0.7.4，与生产同源）：`OK（8 pipelines, 16 assets；lint 无 finding）`
  —— `snk.webhook` 不产生 `could not be named`。
- `data-plane-lock` 重生成 + `check-data-plane-lock` OK（本目录任一文件改后必跑）。
- JSON 语法 + 节点/边集合核对（21 节点 / 25 边）。

## 5. 验收（投递后）

1. 两账套各自手动触发一次 tick → run 记录 `ok`；
2. OO `retail_day` 出现 `job='retail-tick'` 行，`system_book` 两账套可分（**headers 替换的实弹验证**）；
3. 判红路径不受影响：人为缺口窗时 dz 照常 `TICK_FAILED`（观察期看自然缺口即可，不人为造）；
4. `catalog build/lint` 在投递机上重跑过（SOP ④ 三判据）。

## 6. 后续动作（不在本 PR）

- 行落地验证后：**启用** OO 告警 `retail_tick_absent_business_hours` 并更新其 description
  （删「tick 尚未投递」的暂停理由，补方言 3.1 的红-run 含义）；
- ✅ **已完成（当日拍板 #410/#411，用户口径「能迁就迁」）**：零售管线的**同构补迁**——
  `windows.l1` / `close.l1` 用与 tick 逐字同形的 `su→op→wh` + `wh→a2`。**实测验证**：close.l1 手动触发后
  OO `retail_day` 收到 `job=retail-close / system_book=3120 / rows=844 / ok`；tick 自 #407 起逐窗在收。
  observations 期按端到端实测销账，不另设。
- **L0 两条：决定不做 `_ops`（#414 定案，2026-10-03）** —— 这是**取舍**，不是待办：
  同样的 `op→wh` 挂在 L0 上，`wh` 恒发 `{"Success":true}` 而非上游行。**根因在上游 duckle 引擎，不在我们的管线写法**：
  引擎把 `CREATE SECRET …;` 前导挂到**每个** stage 的脚本上（每个 stage 是新 CLI 会话，凭据必须重下），而
  **DuckDB 的 `CREATE SECRET` 语句自己会返回一行**；sink 取行用的 `run_rows` 取的是**第一个** JSON 数组 ⇒ 拿到的是 secret 那一行。
  触发条件是**管线声明了会生成前导的凭据**（云凭据，或**带密码的 ATTACH**）——与「写不写 S3」无关；
  tick/windows/close 只有 REST 连接（REST 不需要 DuckDB secret）⇒ 前导为空 ⇒ 正常。
  同类受影响的上游函数 **13 个**（无一处用现成的 `run_last_rows`），修法一行。上游**已知**此陷阱——他们 2026-09-29 在
  **inspect** 路径上修过同一个病（`fix(inspect): read an S3 source's schema, not its secret's answer`），只是没扫到 sink 家族。
  ⇒ **L0 的观测面改用已有的两个**：`owners.json` 的湖对象新鲜度锚（`dim_branch` / `dim_item`）+ 每次 run 的
  **运行记录 / 回执**（行数与逐节点状态，经 openship MCP 可读）。上游修好后若要重上，另起 issue。

## 7. 关联

- issue **#406**（本篇正文）· wrapper 退役批 **#382** · 观测投递历史 issue **#210**
- 方言出处：《duckle 编排能力 survey》§4（stage 错误统一出口）· 管线 `_note` ⑩
- 投递程序：SOP §E + §1③ seed（本批只 seed `lemeng.retail.tick.l1.json` 一个文件）+ ④ 重建 catalog + ⑤ 重启
