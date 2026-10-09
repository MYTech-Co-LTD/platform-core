# #528 checkpoint 冻结缺口的治本修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「回填 = 重放」修不了冻结缺口这一结构性问题闭环：回填拒绝开窗 bizday（C）、heal 常设旁路修数口子（B）、A 的上游能力缺口留档（A-upstream）。

**Architecture:** C = backfill 父管线在进入 foreach 前插一道 bizday 级 fail-closed 守卫（code.sql 产违规行 + ctl.die 收行）；B = `recon-day-heal.sh` 在触发回填前先在 console 容器里备份并按内容标记删除目标日的冻结 checkpoint 条目，使回填真正重抓；A = duckle 引擎加载 checkpoint 时丢弃 `at` 字段（`crates/duckdb-engine/src/checkpoint.rs:91-94`），无 TTL 属性可用 ⇒ 上游缺口，只在 issue #528 留档不改源。

**Tech Stack:** duckle 管线 JSON（code.sql / ctl.die / 边 on-subjob-ok）、POSIX sh（heal 驱动 + docker exec）、`*.test.sh`（awk 抽真函数测试，仓内既有范式）。

## Global Constraints

- 引擎能力判断按**最新版** duckle 源码（memory: duckle-always-track-latest-version）；A 的证据引用 `checkpoint.rs:91-94`（load 时 `at` 被丢弃）。
- 迁移/幂等纪律不适用（无 schema 变更）；**架构先行**已满足（#528 案例经用户确认走 A+C+B，管线 JSON 属数据面既定架构内改动）。
- 敏感值只写「在哪、怎么取」（token 全部运行时从容器 env 取，不落盘不打印）。
- shell 相邻中文一律 `${VAR}`（issue #212，bash 3.2）。
- 提交：`fix(采集): …` 风格 + PR body `Closes #528`，squash，subject 带 `(#528)`；推前跑八条 check-* 门禁。
- 管线改动必须过 duckle MCP `validate_pipeline` 编译检查。

## 设计要点（不改的第二轮讨论，只写既定裁决）

1. **C 放 backfill 父管线而非子管线**：子管线窗级守卫挡不住 23:06 点火（h00–h22 相对各自 hour 已「闭窗」）；真正要守的闭窗单位是 **bizday**（上海 D+1 00:00）。
2. **排班父管线（windows.l1 / close.l1）不加守卫**：两者的 bizday 都是 now 推导（`now()-1d` / today），恒有 `now_sh >= bizday+1d`，守卫恒真 ⇒ 加了是死代码。边界残留（白昼手动触发 close 会把「今日已闭小时」冻进 checkpoint，次日 l1 重放）记入 issue 边界，不在本 PR 堵。
3. **B 的删除判据用内容标记不用 `at`**：行内 `"shift_table_bizday":"<紧凑 YYYYMMDD>"`（修数时实测 0 跨日误伤；对任意 `at` 形状稳健）。备份先行，全量重抓 = 最坏多抓一次，无害。
4. **HEAL_FORCE=1**：跳过 recon GAP 复核（无条件修数口子），但**保留** T-3 定稿线闸门——未定稿日的源还在变，重抓抓到半截快照没意义。
5. **空 ndjson 合法**：`grep -vF` 全删光时 exit 1，输出空文件 = 引擎全量重抓，是期望行为不是错误。

---

### Task 1: C — backfill 管线插 bizday 闭窗守卫

**Files:**
- Modify: `deploy/duckle/console/pipelines/lemeng.retail.windows.backfill.json`
  （节点表：`dv` 之后、`w0` 之前插 `wc` + `dw`；边表：`t9`(dv→w0) 替换为 dv→wc / wc→dw / dw→w0 三条；`_note` 增补守卫理由）

**Interfaces:**
- Consumes: `gv` 已断言 `${BIZDAY}` 形如 `YYYY-MM-DD`（wc 的 SQL 可安全 cast）。
- Produces: `dw` die 时 run 红、message 含 `WINDOW_OPEN`（真机验收 grep 用）。

- [ ] **Step 1: 写 `wc`（code.sql，FROM-less 产违规行）与 `dw`（ctl.die has-rows）节点**

`wc` SQL（严格 `<` ⇒ 边界含入：恰 D+1 00:00:00 上海时 0 行放行）：

```sql
SELECT 'WINDOW_OPEN' AS violation,
       '${BIZDAY}' AS detail,
       '上海时间未到 D+1 00:00：回填会窗内抓拍并被 checkpoint 永久冻结（#528），拒绝' AS rule
WHERE (now() AT TIME ZONE 'Asia/Shanghai') < ('${BIZDAY}'::date + INTERVAL 1 DAY)
```

`dw`：ctl.die，`has-rows`，message `WINDOW_OPEN bizday=${BIZDAY} 未闭窗，拒绝回填（#528）`。
节点 position 取 dv/w0 之间的空位（x 递增）。

- [ ] **Step 2: 改边**：删 `t9`，加 `t9a`(dv→wc, on-subjob-ok)、`t9b`(wc→dw, main)、`t9c`(dw→w0, on-subjob-ok)。以文件里 dv 前驱边的 `connectionType` 实际字面量为准（实现时逐字段照抄既有边形状）。

- [ ] **Step 3: 增补 `_note`**：记录「为什么守卫在 backfill 且是 bizday 级」「排班父管线为何不加（恒真死代码）」「边界残留：白昼手动 close」三句。

- [ ] **Step 4: duckle MCP `validate_pipeline` 编译检查**（本机无 duckdb CLI，语义不本地跑；真机谓词验证放 Task 6）。

- [ ] **Step 5: 结构断言进 `scripts/lemeng/check-pipeline-json.test.sh` 风格的既有结构测试**（无则新增 `recon-day-heal.test.sh` 旁路之外的独立小测）：grep 断言 `WINDOW_OPEN` 节点在场、t9 旧边不在、新三边在场。

### Task 2: B — heal 驱动加旁路失效 + HEAL_FORCE

**Files:**
- Modify: `scripts/lemeng/recon-day-heal.sh`（头注、用法、heal_bypass 函数、主流程接线）
- Modify: `scripts/lemeng/recon-day-heal.test.sh`（新函数的抽测）

**Interfaces:**
- Produces: 可 grep 字面量 `HEAL_BYPASS_DELETED deleted=N files=N backup=<dir>`（成功删除）、`HEAL_BYPASS_FAILED:<reason>`（容器/依赖坏 → rc 3）、`HEAL_FORCED`（FORCE 模式横幅）。退出契约扩展：`HEAL_BYPASS=0` 可关旁路（仅 FORCE 模式下有已验证口子，GAP 路径默认保持开）。

- [ ] **Step 1: 先写失败测试**——`PRUNE_SNIPPET` 用 awk 抽真变量（`awk '/^PRUNE_SNIPPET=/{f=1} f{print} f&&/^\x27$/{exit}'`），四个夹具场景对本机 tmp 目录直接跑（不经 docker）：
  1. 三条目删二留一 + 备份文件内容 == 原文件内容；
  2. 全部命中 ⇒ 空 ndjson 留存、rc 0（全量重抓是合法态）；
  3. 无命中 ⇒ 文件字节不变；
  4. 无窗口目录 ⇒ `deleted=0`、rc 0。
  外加：标记构造测试（`2026-10-02` → `20261002`）。
  跑 `sh scripts/lemeng/recon-day-heal.test.sh`，期望 FAIL（抽不到 PRUNE_SNIPPET）。

- [ ] **Step 2: 实现**。`PRUNE_SNIPPET` 为单引号变量（**内部禁用单引号**），生产侧 `docker exec … sh -c "$PRUNE_SNIPPET" sh /workspace/state "<marker>" "<bdir>"`：

```sh
PRUNE_SNIPPET='
root=$1; marker=$2; bdir=$3
mkdir -p "$bdir"
deleted=0; files=0
for f in "$root"/lemeng_retail_order_line_window_*/checkpoints/*.ndjson; do
  [ -f "$f" ] || continue
  files=$((files+1))
  n=$(grep -cF "\"shift_table_bizday\":\"$marker\"" "$f" || :)
  [ "$n" -gt 0 ] || continue
  cp "$f" "$bdir/$(basename "$f").$files.bak"
  grep -vF "\"shift_table_bizday\":\"$marker\"" "$f" > "$f.tmp" || :
  mv "$f.tmp" "$f"
  deleted=$((deleted+n))
done
echo "HEAL_BYPASS_DELETED deleted=$deleted files=$files backup=$bdir"
'
```

- [ ] **Step 3: 主流程接线**：GAP 判定后、触发前调 `heal_bypass`（默认开，`HEAL_BYPASS=0` 跳过并打横幅）；`HEAL_FORCE=1` 时跳过 GAP 复核直接走 heal（打 `HEAL_FORCED`），**定稿线闸门照走**；旁路 docker exec 失败 → `HEAL_BYPASS_FAILED:<reason>` rc 3。

- [ ] **Step 4: 跑 `sh scripts/lemeng/recon-day-heal.test.sh` 全绿**（既有 heal_verdict/heal_settled 断言不许红）。

### Task 3: window.json `_note` ③ 订正

**Files:**
- Modify: `deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json`（仅 `_note` 文本，零节点/边改动——`check-diagnostic-tool.mjs` 盯的 src.rest 形状不动）

- [ ] 记入：被证伪的假设（「闭窗⇒内容不再变」两半都不成立）、两类病害（窗内抓拍 / 闭窗后源变更）、checkpoint=true 为何保留（排班父管线 bizday 构造性已闭 + heal 旁路 + 上游 A 缺口）、指向 #528。

### Task 4: handbook §1.4.1 措辞订正

**Files:**
- Modify: `docs/data-platform-handbook.md`（L654 失败动作单元格、L656 「触发回填的」句）

- [ ] 改为：失败动作 = `recon-day-heal.sh`（**先旁路失效冻结条目再回填**，回填本身=重放，单独回填修不了冻结缺口），引用 #528 案例；同步修 issue 验收判据 4。

### Task 5: issue #528 留档 A 缺口 + 边界

- [ ] 用 `gh issue comment 528` 补：A 的上游证据（checkpoint.rs load 丢 `at`、src.rest 无 TTL 属性、且 A 的窗级判据救不了 10-05 h00–h22——闭窗单位是 bizday）；边界残留（白昼手动 close）。

### Task 6: 门禁 + 提交 + PR

- [ ] 八条 check-*/纪律脚本全绿（`check-diagnostic-tool` 在列——确认 C/B 改动不触它的判据）。
- [ ] commit（勿动 provenance trailer）、push、PR `Closes #528`；merge 只等 CI CLEAN。

## 真机验收（merge 后，另案执行）

1. sync 到数据面 → 对**今日** bizday 触发 backfill ⇒ 红 `WINDOW_OPEN`（C 生效铁证）。
2. 对某定稿日 `HEAL_FORCE=1` 跑 heal ⇒ `HEAL_BYPASS_DELETED` + 重抓 + 双通道归零（B 生效铁证）。
3. 观察一个排班周期不受影响（l1/close 正常绿）。
4. 清 #528 修数备份两处；更新 memory + WeKnora 沉淀。
