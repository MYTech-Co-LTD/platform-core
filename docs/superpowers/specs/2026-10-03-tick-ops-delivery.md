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
- ✅ **已迁（当日拍板，#410/后续 PR）**：其余四条管线（windows/close/L0×2）同批补上——windows/close 用与 tick 同构的 `su→op→wh`；L0 单链用 `sink→锚→op（自读 gate 计数）→wh`。观察期按 tick 端到端实测销账（用户拍板「9 月就在观测，能迁就迁」），不再另设。

## 7. 关联

- issue **#406**（本篇正文）· wrapper 退役批 **#382** · 观测投递历史 issue **#210**
- 方言出处：《duckle 编排能力 survey》§4（stage 错误统一出口）· 管线 `_note` ⑩
- 投递程序：SOP §E + §1③ seed（本批只 seed `lemeng.retail.tick.l1.json` 一个文件）+ ④ 重建 catalog + ⑤ 重启
