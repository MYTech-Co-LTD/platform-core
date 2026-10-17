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

## 3. 契约草案（C 段）

两个新湖资产，各自一份 `contracts/common/` 文件 + 管线/脚本侧 `data.schema` 申报（**两处逐字一致**）。

### 3.1 `lemeng/recon_run` — 分区 `system_book=` + `bizday=`，文件 `all.parquet`

| 列 | 类型 | 说明 |
|---|---|---|
| `batch_id` | varchar | 批次标记（既有约定） |
| `system_book` | varchar | 账套（分区键） |
| `bizday` | date | 被对账的业务日（分区键） |
| `control` | varchar | `caliber_sale` / `caliber_net`（**completeness 不在此资产内**，见 0.1） |
| `status` | varchar | `ok` / `within_tol` / `over_tol` / `not_evaluated` |
| `reason` | varchar | null；`not_evaluated` 时必填（2.2 的四值） |
| `rows_source` | int | 源报表行数 |
| `rows_target` | int | 平台侧行数 |
| `break_count` | int | 超容差实体数 |
| `max_break` | decimal(20,2) | 最大单实体差（绝对值） |
| `tol_abs` | decimal(20,2) | 本次绝对容差 |
| `tol_pct` | decimal(10,4) | 本次相对容差（%） |
| `tol_applied` | decimal(20,2) | 实际生效容差 = max(abs, pct×|target|) |
| `source_called_at` | timestamptz | 源接口调用时刻 |
| `evaluated_at` | timestamptz | 判定时刻 |

### 3.2 `lemeng/recon_break` — 同分区

| 列 | 类型 | 说明 |
|---|---|---|
| `batch_id` / `system_book` / `bizday` | 同上 | 分区键 |
| `control` | varchar | 同上 |
| `entity` | varchar | 门店号（可 1:1 匹配的最细粒度） |
| `source_value` | decimal(20,2) | 源报表值 |
| `target_value` | decimal(20,2) | 平台值 |
| `diff` | decimal(20,2) | `source − target` |
| `tol_applied` | decimal(20,2) | 该实体生效容差 |
| `bound_by` | varchar | `abs` / `pct` |
| `verdict` | varchar | `within_tol` / `over_tol` |
| `reason_code` | varchar | null = 未认领；具名 = 已知并接受（2.3） |
| `expires_on` | date | null = 无到期（必须清零）；有值 ⇒ 过期自动转 `over_tol` |
| `disposition` | varchar | 处置说明（按哪边修） |
| `disposition_by` | varchar | 认领人 |

> ⚠️ **降级路径**（若 duckle/脚本写两个 parquet 成本过高）：合并为单资产 + `record_type` 判别列。
> **但必须保留 `not_evaluated` 行**——否则 2.1 的核心保障失效。此为备选，默认不用。

## 4. 分段实施

### B 选型定案（已完成）
§1.7 已登记「派生资产非源」。本版把该行的三条裁决更新为**四态 + 两表 + reason/expires**。

### C 契约（**不能单独落仓**）
`check-data-contract` 要求「生产者与 staging 均已对齐」⇒ **C 必须与 D 同批**。
两份契约 + 生成器（`gen-data-projection.mjs`）跑出生成物，**不手改投影**。

### D 生产方（脚本，不是管线）
- 改 `scripts/lemeng/recon-preagg.sh`：在现有「分批 → 合并 → compare」之后，**多产两段输出**（run 行 + break 行）。
- 落湖：经 console 容器的 zos 连接写两个前缀（脚本已在 `docker exec` 进 console，不新增凭据面）。
- **保留原 CSV 输出**（`recon-day-heal` 与人工排障仍在用），切换后再谈退役。
- 判停：先单日真跑，**回读校验**（行数与 `break_count` 对得上）再谈排班。

### E 排班（**当前没有，这是本任务的核心增量**）
- 给 caliber 对账**新建**一条日 job（T-3 线，与 `recon-day-heal` 错峰），命令 `sh /opt/lemeng-recon-preagg.sh <bizday>`。
- **三个登记面**：① 排班种子/openship job；② **重建 catalog**（漏了 ⇒ 新鲜度锚静默失效）；③ 跑一次成功 run 起算。
- 锚：`owners.lemeng.json` 加两个前缀。

### F 验收（四层）
| 层 | 判据 |
|---|---|
| 自证 | 写后回读：`recon_run` 每 (账套,日,control) 恰 1 行；`break_count` == `recon_break` 行数 |
| 幂等 | 同日重跑覆盖写，行集不变 |
| 独立通道 | 本资产**就是**独立通道产物 ⇒ 反向验：仓内 `diff` == CSV 同日差 |
| 跨系统 | 待回填 |

### G 运维
- 判据用 **`status` + `break_count` 趋势 + 到期 break**，不是「有没有行」。
- 告警：`status ∈ {over_tol, not_evaluated}`；**`not_evaluated` 单独成一条**（源故障 ≠ 数不平）。

### H 回填
- 首批近 14 天，走同一脚本换 `bizday`；逐日与 CSV 对平后入库。

## 5. 风险与未验（写在最前面）

1. **容差让缺口可见，但不让它消失**：`within_tol` 的 break 必须**有 `expires_on`**，
   否则这本台账会变成"什么都放过的橡皮图章"。**没有到期日的 reason_code 不允许写库。**
2. **`not_evaluated` 必须真的出现**：上线首周要**主动**制造一次源不可用（或等自然发生）验证它落成
   `not_evaluated` 而不是 `ok`——这是本设计最重要的一条，也是最容易在实现里被吞掉的一条。
3. **3120 有 271 个门店号**：脚本已分批；但**"批间源数据在变"**（回调/退款）未验——批与批之间
   源可能已重述 ⇒ 全量跑完的 `source_called_at` 要记**起止**（当前列只有单值，D 段决定是否拆两列）。
4. **未验**：脚本经 console 写 parquet 的具体形态（D 段第一次跑就要验覆盖写语义）。

## 6. 不做

- 不改口径、不动 `NET_ABS_TOL` 的值（改的是**它的记账方式**）。
- 不把 completeness 对账塞进本资产（那是另一个控制，见 0.1）。
- 不为该资产声明 L1 指标（它是**对账事实**，不是业务口径）。
- 不停用 CSV 输出。
