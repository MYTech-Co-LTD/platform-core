# 零售明细 5 分钟提频（当日增量 tick）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 乐檬零售明细采集从「每日拉昨日 24 窗」提到「北京 8:00–24:00 每 5 分钟」（issue #260），落 duckle console 调度，幂等口径 = 覆盖写累计快照（2026-09-27 实测 + 用户裁决，见 #260 两条评论）。

**Architecture:** console 调度新增 tick/close 两条 cron → 薄管线（code.shell 调 `/opt/lemeng-run.sh tick`，与 windows 同构）→ `run-retail-day.sh` 新增 `tick` 模式：每 tick 查**当前小时 + 上一小时（闭窗尾款）**两个时窗、各覆盖写自己的 `hour=` 分区；现有日批（昨日 24 窗，02:30Z）**保留作兜底层**。网关语义已实测为「该小时至今累计」（#260 探针评论），覆盖写安全。

**Tech Stack:** duckle 0.7.3 console 调度 + 既有 `src.rest`×12 管线（不改）+ POSIX sh wrapper + OpenObserve 观测/告警。

## Global Constraints（逐字值，勿改写）

- **幂等口径（用户已裁决）**：每 tick 全量重查当前小时 + 上一小时，覆盖写各自 `hour=` 分区；日批兜底保留。
- **网关语义（实测，#260）**：小时窗查询返回「该小时至今累计」；旁证 = 闭窗整窗可稳定重取。
- **营业时段**：北京 8:00–24:00 ⇒ UTC `0-15` 时每 5 分钟（`*/5 0-15 * * *`，192 tick/天/账套）+ **闭窗 tick** UTC `0 16 * * *`（北京 00:00，只补昨日 23 点档尾款）。
- **页容量**：管线 12 页 × `page_size=200` = 2400 orders/窗容量闸（实测高峰小时 ~500 orders ≤3 页，余量充足；**不改管线**）。
- **时区铁律**：营业日/小时一律 `TZ=Asia/Shanghai` 显式推导（继承系统 TZ = 让偶然决定分区名，run-retail-day.sh 头注既有结论）。
- ** Midnight 边界**：北京 00:00 的闭窗 tick 查的是**昨天**（bizday=昨日、hour=23）——cur 与 prev 的 bizday 可以不同，这是本计划唯一真正的新逻辑面。
- **开工前置（硬闸）**：W2 已收口（#265 merged、retail job 已退役、机器 repo 已收敛到含 3120 console 调度的 main）；3120 日批在 console 上稳定 ≥1 运行日。
- **投递铁律**：wrapper/pipeline/schedules 变更必须先 push 才能被机器 sync 取到（LOCK_FETCH 教训）；seed 走 console HTTP API（W2 Option A 口径，§1.1.6 ⑥a）。
- **敏感值**：全部 `${ENV:...}` / job secrets，正文与提交零明文。
- **双账套铺开顺序（默认，计划评审可改）**：3120 试点 ≥1 个完整营业日 → 64188 跟进。

---

### Task 1: wrapper 新增 `tick` 模式（当日增量 + 闭窗尾款）

**Files:**
- Modify: `scripts/lemeng/run-retail-day.sh`
- Test: `scripts/lemeng/run-retail-day.test.sh`（Task 2）

**Interfaces:**
- Produces: `sh run-retail-day.sh tick [close]`——`tick` = cur+prev 两窗；`tick close` = 仅 prev 窗（昨日 23 点档，闭窗补采专用）。退出码契约同 `windows`（逐窗尽力、末尾统一判红 `TICK_FAILED hours:…`）。`_ops` 行 `job:"retail-tick"`，每窗一行（含 `bizday`/`hour`）。
- 消费方：Task 3 的管线 `code.shell` 只调这一个入口。

- [ ] **Step 1: 把 `window` case 分支的管线调用体抽成函数**

`window` case 分支里 `$COMPOSE run … duckle --pipeline …` 起到 `ops_emit` 判红为止的整段，抽成：

```sh
run_window_window() { # $1=bizday $2=hour $3=suffix $4=ops_job(缺省 retail-day) → 沿用原 case 分支的退出码语义
  # 与原 window 分支逐字同体，仅三处取自参数：
  #   BIZDAY="$1"（命令前缀赋值 + -e BIZDAY="$1"）、HOUR/HOUR_FROM/HOUR_TO 用 "$2" 推、
  #   ops_emit 的 job 字段取 "$4"（缺省 retail-day；tick 传 retail-tick）
}
```

`window` case 分支改为：自证（IDENTITY_CHECKED 逻辑不动）→ `run_window_window "$BIZDAY" "$H" "${SUF}"` → 原退出码透传。**外部行为零变化**（`windows` 模式经 `run_one_window → sh $0 window H` 也不变；`_ops` 的 job 字段缺省值保证存量观测行不变）。

- [ ] **Step 2: 新增 `tick_windows()` 纯函数（本计划唯一新逻辑，必须可抽出测试）**

```sh
tick_windows() { # $1=模拟 CST 墙钟 "YYYY-MM-DD HH:MM"（空=真 now）；$2=""|close → stdout: "bizday,hour" 对（cur 在前 prev 在后）
  # 纯函数：墙钟一律取 $1（可测），不直接读系统钟。
  #   d=$(TZ=Asia/Shanghai date +%F)；dy=昨日（复用脚本既有 GNU/BSD 双回退推导）
  #   h=10#${1##* } 的钟点（10# 防八进制 08/09）
  #   分派：
  #     h=0  → 只输出 "$dy,23"                              # 闭窗 tick：补昨日 23 点档
  #     h=1  → "$1的日期,01" "$1的日期,00"                   # 00 点档同日
  #     其他 → "$1的日期,$h" "$1的日期,printf %02d $((h-1))"
  #   close 形态只输出 prev 对（cur 留给次日开市 tick——营业时段外无 cur 可采）
}
```

- [ ] **Step 3: `tick` case 分支**

```sh
tick)
  # 语义：营业时段每 5 分钟由 console 调度触发；每 tick 查「当前小时至今 + 上一小时（闭窗尾款）」
  # 各覆盖写自己的 hour= 分区（幂等口径见 #260 裁决评论）。close 形态只在 UTC 16:00（北京 00:00）跑。
  if [ "${IDENTITY_CHECKED:-}" != "1" ]; then
    sh "$0" identity || exit $?   # 身份未证绝不碰网关（同 window）
    IDENTITY_CHECKED=1; export IDENTITY_CHECKED
  fi
  pairs=$(tick_windows "" "${2:-}")
  w_failed=""
  for pair in $pairs; do
    bd=${pair%%,*}; hr=${pair##*,}
    if run_window_window "$bd" "$hr" "-t"; then :; else w_failed="$w_failed $bd/$hr"; fi
    # 每窗 _ops 行由 run_window_window 内既有 ops_emit 发出；job 字段改传：
    #   run_window_window 增加第 4 参 ops_job（缺省 retail-day），tick 传 retail-tick
  done
  [ -n "$w_failed" ] && { echo "TICK_FAILED hours:${w_failed# }"; exit 1; }
  echo "TICK_OK $(echo $pairs | wc -w | tr -d ' ') windows"
  ;;
```

失败重试：**单 tick 内不做自动重试**（5 分钟后下一 tick 天然重试——覆盖写幂等使「下一 tick 即重试」成立；这是与 `windows` 模式的**有意差异**，写进 case 注释）。`usage` 行补 tick。

- [ ] **Step 4: `sh scripts/lemeng/run-retail-day.test.sh` 全绿 + 既有门禁**

Run: `sh scripts/lemeng/run-retail-day.test.sh`（既有 shim 测试必须零回归）+ 仓内 lint/typecheck。

- [ ] **Step 5: Commit** — `feat(lemeng): 零售日采集 wrapper 新增 tick 模式（当日增量+闭窗尾款） (#260)`（refuses 之外的常规提交；hook 自动盖 trailer）

### Task 2: `tick_windows()` 边界测试（先于 Task 1 Step 3 写红）

**Files:**
- Test: `scripts/lemeng/run-retail-day.test.sh`

- [ ] **Step 1: 按 test.sh 既有「awk 抽真函数」风格追加用例**（stub `date`：`BIN/date` 按 `TZ` 打印可控时刻，或给 tick_windows 传入可选 now 参数——**取传参形态**，纯函数不依赖墙钟）：

```sh
FUNC2=$(awk '/^tick_windows\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$SRC")
eval "$FUNC2"
# 用例（传参 = 模拟的 CST 墙钟 "YYYY-MM-DD HH:MM"）：
ok "$(tick_windows '2026-09-27 19:35' '')"   '2026-09-27,19 2026-09-27,18'   # 普通下午 tick
ok "$(tick_windows '2026-09-27 08:00' '')"   '2026-09-27,08 2026-09-27,07'   # 开市首 tick
ok "$(tick_windows '2026-09-27 23:55' '')"   '2026-09-27,23 2026-09-27,22'   # 末班 tick
ok "$(tick_windows '2026-09-28 00:00' close)" '2026-09-27,23'                # 闭窗：昨日 23 点档（bizday 跨日）
ok "$(tick_windows '2026-10-01 00:00' close)" '2026-09-30,23'                # 跨月
```

- [ ] **Step 2: 红灯确认**（Task 1 Step 2 未落地时 `抽不到 tick_windows` 判红）→ Task 1 完成后转绿。TDD 顺序：本 Task 的 Step 1 在 Task 1 Step 2 **之前**执行。

### Task 3: console 管线 ×2 + 调度定义（repo 文件，3120 试点 / 64188 备好未启）

**Files:**
- Create: `deploy/duckle/console/pipelines/lemeng.retail.tick.run.json`（code.shell：`LEMENG_IN_CONTAINER=1 LEMENG_NOTIFY=1 sh /opt/lemeng-run.sh tick`；`qa.contract` exit 0 闸；`snk.csv` 记录 `/workspace/logs/retail-tick-run.csv`——**逐字复刻 windows 三件套结构**）
- Create: `deploy/duckle/console/pipelines/lemeng.retail.close.run.json`（同上，argv 末尾加 `close`；记录 `retail-close-run.csv`）
- Modify: `deploy/duckle/console/schedules/3120.json`：追加 `panel-lemeng.retail.tick.run`（cron `*/5 0-15 * * *`，enabled:true）+ `panel-lemeng.retail.close.run`（cron `0 16 * * *`，enabled:true）
- Modify: `deploy/duckle/console/schedules/64188.json`：同两条，**enabled:false**（试点签字后 Task 7 翻 true）

- [ ] **Step 1:** 建两个管线 json（对照 `deploy/duckle/console/pipelines/lemeng.retail.windows.run.json` 逐字段仿写；label 注明「5min tick 覆盖写累计快照，口径见 #260」）
- [ ] **Step 2:** 两份 schedules 追加 entry（id/pipeline_id/name 三键与文件内既有条目同风格；last_run_* 置 null）
- [ ] **Step 3:** 门禁——`node scripts/lint-architecture.mjs`、lock 再验（deploy/** 变更按仓规矩重跑生成物）、`sh scripts/lemeng/run-retail-day.test.sh`
- [ ] **Step 4:** Commit — `feat(duckle): 零售 5min tick/close 管线与调度定义（3120 试点、64188 备用） (#260)`

### Task 4: 告警与新鲜度重推导（192 次/天量级）

**Files:**
- Modify: `deploy/duckle/console/alerts.json`（3120/64188 共用形状）：规则 match 追加 `lemeng.retail.tick.run` / `lemeng.retail.close.run`，on=`["failure","recovery"]`，**cooldownMinutes: 60**（失败风暴不刷屏；静默缺口由 OO 兜）——通道沿用既有 OO ingest webhook（`channel` 是 serde flatten 必填，照抄既有规则整块）
- Modify: `deploy/duckle/console/owners.json`：给 **daily windows 资产**补规则（W2 后零售已落 console 卷，P1 时「不给 retail 配规则」的理据已消失）：`maximumAge: 36h` 语义 = 兜底日批健康
- OpenObserve（运维面，不走 PR）：新增 scheduled alert「营业时段 tick 缺席」：stream=_ops 落的 `retail-tick` 行，查询窗口 15m、条件 count<1、**SQL 内 `toHour` 限定 UTC 0–16**（静态 maximumAge 表达不了营业时段，故营业时段新鲜度放 OO；文案变量只用已验证集）
- 注：tick 的 lake 资产**不进** owners.json maximumAge（静态阈值 ≥16h 离峰= 哑弹；营业时段检测归 OO 缺席告警——这条理由写进 owners.json `_note`）

- [ ] **Step 1:** 两份 repo 告警/新鲜度文件按上述改 + 门禁（lock/lint）
- [ ] **Step 2:** OO 告警经 MCP/API 建（Dev 验证一次触发路径后套生产 org `3IJ5tM4en3A06FzcJQhoHMTl4Xe`；模板变量只用已验证集——`{alert_name}/{stream_name}/{alert_count}/{alert_period}/{alert_url}` 等）
- [ ] **Step 3:** Commit — `feat(duckle): 零售 tick 告警与新鲜度规则（192/天量级重推导） (#260)`

### Task 5: 对账改述 + 台账/正典同步

**Files:**
- Modify: `scripts/lemeng/run-retail-day.sh`（新增只读模式 `recon <H>`：该 hour 湖分区 `count(*)/count(DISTINCT batch_id)` 经 `rb` 通路回读 + 网关当刻累计行数对照——闭窗小时两者应相等，容差 0）
- Modify: `docs/data-platform-handbook.md`：§1.3 验收锚补 tick 行（对账口径按 #260 裁决重述：**任一时刻 hour 分区文件内恰一个 batch_id（最新 tick 完整快照）且内容 = 网关当刻累计**；`count(DISTINCT batch_id) 按 hour=1` 只对**日批兜底层**继续成立）；§2 台账 3120 行频率列改「**现行** 5min tick（试点）」（Task 7 收口时再改 64188 行）
- [ ] **Step 1:** `recon` 模式 + 测试（只读、失败非零、无凭据明文）
- [ ] **Step 2:** handbook 两处（指针不复制正文）
- [ ] **Step 3:** Commit — `feat(lemeng): tick 对账口径 recon 模式与正典同步 (#260)`

### Task 6: 投递、seed、试点观察（3120；运维面，openship MCP）

- [ ] **Step 1:** 前置闸复核：#265 已合、机器 repo SYNC_OK 到新 main、3120 日批稳定 ≥1 运行日
- [ ] **Step 2:** 经 console HTTP API seed 两条新调度（`POST /api/schedules`，enabled:true）+ 定向部署两管线文件进卷（`serviceIds` 定向，别全量——会重启 pg_duckdb）
- [ ] **Step 3:** 首个 tick 四验：① receipt `run-scheduled-lemeng-retail-tick-run-*` 出现且 ok（**判触发看 receipts 的 startedAt，勿看 schedules.json 的 last_run_at——那是完成时刻**）② 湖里当天 `hour=<当前>` 分区 mtime 在 5 分钟内被覆盖更新、文件内恰 1 个 batch_id ③ `_ops` 出 `retail-tick` 行 ④ 下一 tick 后无 failure 告警
- [ ] **Step 4:** 闭窗验证：UTC 16:00 那次 close tick 写昨日 `hour=23`（与 23:55 tick 的文件 batch_id 不同、行数 ≥）
- [ ] **Step 5:** 观察一个完整营业日（192 tick）：TICK_FAILED 计数 0、OO 缺席告警 0 误报、`recon` 对随机 3 个闭窗小时全等 → 打 \"试点通过\" 结论进 #260

### Task 7: 64188 跟进 + 收口

- [ ] **Step 1:** 64188 seed（API）+ schedules/64188.json enabled 翻 true（PR）→ 同一套四验
- [ ] **Step 2:** handbook 台账 64188 行收口；#260 关闭（`Closes #260` 的收口 PR）
- [ ] **Step 3:** 新坑沉淀 WeKnora（检索查重 → 更新原条目：网关累计语义 + tick 口径）

## 波次

- **Wave 1**：Task 1 + Task 2（TDD 同一 worker；同文件必串行）
- **Wave 2**：Task 3、Task 4、Task 5（三个独立 worker；共享 handbook 的 Task 5 与 Task 3 无文件交集，可并行）
- **Wave 3**：Task 6（运维面，协调者主刀）、Task 7

## 明确不做（YAGNI）

- 不改 `src.rest`×12 管线本体（页容量余量 5 倍+；管线改造属 W3 语义，别混波）
- 不做回溯重放器（日批兜底 + 覆盖写幂等已覆盖缺口自愈）
- 不动 Metabase/视图层（新鲜度收益自然兑现，属 #259 范围）
- 不给 tick 资产配 owners.json maximumAge（理由见 Task 4 注）
