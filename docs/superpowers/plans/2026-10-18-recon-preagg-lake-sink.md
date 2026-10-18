# 口径对账落仓：`recon_run` + `recon_break` 两张表

> 2026-10-18（第二版，按行业形态重写）。上位：消费面 spec §12.4 缺口①「证据不落仓」。
> 流程：`collect-source` A→I。A 段已完成并入库（PR #842）；B 段登记见 §1.7。

## 0. 现状（A 段结论 + 载体澄清）

### 0.1 两条 recon 是**两件不同的事**（这是一切的前提）

| | 比什么 | 抓什么 | 现在在跑吗 |
|---|---|---|---|
| **completeness** | 湖 vs **网关翻页累计**（同问句换通道） | **执行偏差**（漏页/漏店） | ✅ `recon-day-heal` 每天调 `diagnose.sh recon` |
| **accuracy / caliber** | 湖 vs **乐檬报表预聚合端点**（`itemsales`，按门店） | **口径 / 引擎错** | ❌ 手动/按需，**无排班** |

**本节要建的是第二条（caliber）**。混为一谈的代价：一条红了分不清该修管线还是修口径。

### 0.2 载体：生产方是**脚本**，不是 duckle 管线

- `scripts/lemeng/recon-preagg.sh`：**已分批**（`PREAGG_MAX_BRANCHES=100`）、已 5 天逐分归零、正典认定的执行面。
- `lemeng.recon.preagg.item`（有 CSV sink）：**任何账套都没排它**。
- `lemeng.recon.preagg`（64188 排了 `30 0`）：**4 节点、无 sink、`last_run_at: null`**。
- `recon-day-heal.sh`：只调 `diagnose.sh`，**不调 preagg**。

⇒ **不在"没人跑的管线"上盖楼**：生产方定为**脚本**，落湖由它经 console 的 zos 连接完成。

### 0.3 硬约束（已实测）

- `itemsales` 单次 `branch_nums` **≤100 家**，超出 **`code=10001` fail-loud**（不是静默截断）。
- 鉴权：容器 env `LEMENG_TOKEN`（`connections/lemeng.json` 的 `authToken` 会 401）。
- 两账套 2026-10-16 实测**逐分吻合**：64188 `27,777.50`＝`27,777.50`；3120 `9,893.40`＝`9,893.40`。

## 1. 目标

把「平台 vs 源报表」的差异变成**可查询、可认领、可到期**的一等公民——行业叫 **control totals + break management**。

**不是**"再跑一次对账"；**是**建一本差异台账：
> 今天有几笔不平 · 每笔什么原因 · 挂了多久 · 谁认领的 · 什么时候必须清掉。

## 2. 行业形态与本项目落地（本节是裁决）

### 2.1 两张表，不是一个明细

| 表 | 粒度 | 回答什么 | 用途 |
|---|---|---|---|
| **`recon_run`** | 一次控制执行一行：`period` × `control` | 这次对账**跑成了吗**？源可用吗？有几笔不平、最大一笔多大？ | **设闸 · 看趋势** |
| **`recon_break`** | 每个不平一行：`period` × `entity` | 这笔**差多少、为什么、谁认领、何时到期** | **查 · 认领 · 到期** |

**为什么不能合成一张**：`not_evaluated`（源不可用）与 `break_count=0`（真对了）在明细粒度上**长得一样**（都是零行）。合成一张 = 把「源故障」伪装成「健康」。

### 2.2 状态四态（不是三态）

```
run.status     = ok            -- 跑成且零不平
               | within_tol    -- 有 break，但全部在容差内
               | over_tol      -- 有 break 超容差
               | not_evaluated -- 源不可用/不可信（**绝不能记成 ok**）
```

`not_evaluated` 的 `reason`：`source_http_error` / `source_business_error` / `source_empty` / `branch_list_missing`。

### 2.3 容差是**数据**，且必须带 **reason_code + 到期日 + 认领人**

```
break.reason_code   e.g. 'late_return_restatement'   -- 具名，不是"容差内"
break.expires_on    -- 到期日；过期 break **自动转 over_tol**，不靠人记得
break.disposition   | disposition_by
```

**现状 `NET_ABS_TOL=200` 就是一个没有名字的 reason code**——它同样放过任何 ≤200 元的新问题，
而且没人知道它何时该失效。本条是把那个匿名活口变成**有名字、会到期**的东西。

### 2.4 双档容差并记录**谁 binding**

`tol_applied = max(abs_tol, pct × |target|)`，并记 `bound_by ∈ {abs, pct}`。

理由：200 元绝对容差对日销 100 元的小店荒谬；1% 相对容差在旺季大店又太松。**不记录谁生效，就无法复核容差是否合理**。

### 2.5 合计对平 ≠ 对上了

**健康判据不能是 `sum(diff) ≈ 0`**（A 店 +100、B 店 −100 正好抵消）。必须是：
- `break_count`（超容差门店数）
- `max_break`（最大单店差）
- **两者的趋势**（连续 N 期上升即红）

### 2.6 记录系统（system of record）先定下来

| 用途 | 以谁为准 |
|---|---|
| **对外 / 对客户**（结算、考核） | **源系统报表**（合同与财务依据） |
| **对内 / 分析**（趋势、归因） | **我们的仓**（可复算、可拆解） |

不一致时不是"谁错"，而是**桥上有多少、为什么**。⇒ `recon_break` 的 `disposition` 必须写明按哪边修的。

## 3. 分解（第三版：湖只装事实，台账归 dbt）

> 修订理由（2026-10-18 读码）：父管线 `lemeng.recon.preagg` 的 `pday` 把**全部门店拼成一个 JSON 数组**，
> `pfe`（`ctl.foreach`，`itemKey=bizday`）一天只跑一次子管线 ⇒ 请求必然是「全部门店」。
> 64188 有 129 家、3120 有 271 家，**都 >100 ⇒ 必 `10001`**（端点硬限，已实测）。
> 而 `check-data-contract` 要求生产方是**带 `snk.*` 的 duckle 管线** ⇒ 生产方必须沿这条父子链走。

| 层 | 放什么 | 为什么放这 |
|---|---|---|
| **湖资产 ×1** | `lemeng/recon_preagg`，粒度 **(system_book, bizday, chunk_no, branch_num)** | 只放**逐店比对事实**。加一级 `chunk=` 分区即解决 >100：父管线按 ≤100 家切块，每块一个子管线 run、写自己那一片 |
| **dbt 模型 ×2** | `recon_run`（`status` / `break_count` / `max_break` / 容差 / `not_evaluated`）+ `recon_break`（超容差行 + 原因/到期/认领） | **台账是派生分析，不是采集**。放 dbt ⇒ 天然可复算、可测试，且不必为它维护第二份采集 |
| **seed ×1** | `dbt/seeds/recon_reason_codes.csv`（`reason_code` / `expires_on` / `disposition_by`） | 与 `x08_thresholds` 同形：**配置不是数据** |

## 4. 分段实施

### B 选型定案（已完成并两轮订正）
§1.7 已登记；本版把落点改为**一个湖资产 + dbt 台账**。

### C 契约（与 D 同批，不能单独落）
`contracts/common/lemeng.recon_preagg.json`，hive 三级分区 `system_book=` / `bizday=` / `chunk=`，列：

| 列 | 类型 | 说明 |
|---|---|---|
| `batch_id` | varchar | 批次标记（既有约定） |
| `system_book` / `bizday` / `chunk_no` | varchar/date/int | 分区键 |
| `branch_num` | bigint | 门店 |
| `platform_sale` / `source_sale` | decimal(20,2) | **销售侧**：平台自算 / 源报表 |
| `platform_net` / `source_net` | decimal(20,2) | **净额侧**：平台自算 / 源报表 |
| `computed_at` | timestamptz | 计算时刻 |

> 容差与原因**不进湖**——它们是**判定配置**（seed）与**派生物**（dbt），落湖会把配置冻进事实。

配 `dbt/models/lemeng/staging/stg_lemeng_recon_preagg.sql` + 跑 `gen-data-projection.mjs`。

### D 管线（父 + 子）

- **父** `lemeng.recon.preagg`：`pday` 由「一行 + 全部门店」改为**「每 ≤100 家一行」**
  （`chunk_no` + 该块 `branch_nums_json`）；`pfe` 的 `itemKey` 改为 `bizday + chunk_no`。
- **子** `lemeng.recon.preagg.item`：`report snk.csv` **保留**（heal 与人工排障在用），
  **新增** `snk.parquet` → `lemeng/recon_preagg/system_book=<账套>/bizday=<日>/chunk=<n>/all.parquet`，
  写逐店两侧值（不带容差/判定）。
- `data.schema` 申报与契约列集**逐字一致**。
- 判停：先单日单块真跑 → 回读校验 → 再全量。

### E 排班（本任务的核心增量：口径对账现在**没有排班**）
- 64188 已有 `30 0`（从没跑过）；**3120 未排**——`_note` 里「3120 恒 10006 所以不排」已被今日实测推翻 ⇒ **一并排上**。
- **三个登记面**：① 排班种子/openship job；② **重建 catalog**；③ 跑一次成功 run 起算。
- 锚：`owners.lemeng.json` 加 `lemeng/recon_preagg` 前缀。

### F 验收（四层）
| 层 | 判据 |
|---|---|
| 自证 | 写后回读：某日各块门店并集 == 湖侧门店集；两侧值与 CSV 同日逐分一致 |
| 幂等 | 同日同块重跑覆盖写，行集不变 |
| 独立通道 | 本资产**就是**独立通道产物；反向验：dbt `recon_break` 的差 == CSV 差 |
| 跨系统 | 待回填 |

### G 运维
- 判据用 **`recon_run.status` + `break_count` 趋势 + 到期 break**，不是「有没有行」。
- 告警：`status ∈ {over_tol, not_evaluated}`，其中 **`not_evaluated` 单独成一条**（源故障 ≠ 数不平）。

### H 回填
- 首批近 14 天；走同一条管线换 `bizday` 窗，不写一次性脚本。

## 5. 风险与未验（含 2026-10-18 实现侦查的三条**会静默出错**的约束）

1. **`not_evaluated` 最容易被吞掉**：源挂/空/`10001` 时，代码最容易顺手记成「零不平 = ok」。
   **上线首周必须主动制造一次源不可用**验证它。这是本设计最重要、也最容易悄悄失效的一条。

2. **⚠️ `itemKey` 是每行独立的水位键**（读 `ctl.foreach` 组件 schema 确认，非推测）：
   > 「Column whose value names each row's run… **Leave blank and all rows share one watermark,
   > which silently skips rows**」
   ⇒ 父管线吐 N 个 chunk 行却仍用 `itemKey=bizday` ⇒ **N 块共享水位、静默跳行**。
   **必须**让 `pday` 多吐合成键 `item_key = bizday || '-c' || chunk_no`，并把 `pfe.itemKey` 改成 `item_key`。

3. **⚠️ 子管线读不到 `${ENV:}`，且静默 ok**（既有实测 + 现状佐证：子管线 11 个节点**一个 `${ENV:}` 都没有**，
   全用 `${ITER_ITEM_*}`）。⇒ 新 sink 需要 `bucket` / `region` 时**只能由父管线透传**；
   父管线现在只吐 `bucket`，**缺 `region`**，须一并补。

4. **⚠️ 湖 sink 是 `snk.minio`，不是 `snk.parquet`**：`snk.parquet` 没有 `connectionRef` 字段。
   写湖必须 `snk.minio` + `connectionRef: "zos"` + `urlStyle: "path"` + `useSsl: "true"` + `format: "parquet"`。

5. **父管线 `pday` 的目标形状**（由 2–4 推出，实施时照此写）：
   `bizday | settled | system_book | bucket | region | chunk_no | branch_nums_json | item_key`

6. **inline foreach 持续失败会截尾**（既有实测）：块间失败不会自动补齐 ⇒ 需要「块级完整性」断言（F 层已列）。

7. **未验**：`snk.minio` 在同一 bizday 不同 `chunk=` 分区下的覆盖写语义；以及第一跑必须确认
   N 个 chunk 子 run **各写各的分区**（不是互相覆盖）。

## 6. 不做
- 不改口径、不动 `NET_ABS_TOL` 的值（改的是记账方式）。
- 不把 completeness 对账塞进来（那是 `diagnose.sh recon`，另一个控制）。
- 不把容差/原因写进湖（配置归 seed，判定归 dbt）。
- 不停用 CSV 输出。
