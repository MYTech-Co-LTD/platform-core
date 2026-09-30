# 对账判别式落 dbt audit：赠品命中集 + 退货归属完备性

> 2026-09-30 ｜ 依据：判别式正典 `2026-09-30-recon-zeroing-self-attribution.md`（#396 定案）+
> `2026-09-28-lemeng-recon-attribution.md` §3 末的收紧设想 ｜ Closes #397（PR #398）· Refs #287 #396
> 结论一句话：**两个判别式已从「单日人工验证」变成每天自动守的 dbt singular test，且两条测试的
> 编译形态 SQL 已在真库（pg_duckdb 免凭据只读通道）上全量跑过——settled 日全绿，唯一出行的是
> 当天新鲜度竞态（与既有两条指标 audit 同性质，非本族新增风险）。**

## 1. 交付物

| 文件 | 是什么 |
|---|---|
| `dbt/tests/audit_lemeng__retail__recon_gift_hit.sql` | 赠品判别式命中集的独立复算（parquet vs staging）+ 空转自检 |
| `dbt/tests/audit_lemeng__retail__recon_return_attribution.sql` | 退货归属完备性（六部分断言，见 §4） |
| `dbt/README.md` §7.1 | 对账判别式族的登记（不挂指标的关系说明） |
| 本报告 | 设计依据、实测、验证与边界 |

**不挂指标**：`l1_metrics.yml` 不新增任何指标（判别式未转正、无 marts 落点——加指标就得加 marts
实现，越出「只加 tests」的边界）。门禁规则 ⑦ 是**单向**的（每个声明指标必须有对账文件；反之不成立），
`check-data-models.mjs` 实测 OK（对账测试计数 2→4）。文件名带 `recon_` 段与指标 audit 区分，
头注均标「★ 本文件不挂指标」。

## 2. 判别式怎么落的（容差与护栏逐字照抄正典）

### 2.1 赠品（正典 §0）

```sql
state = 'FINISHED'
AND order_detail_std_price > 0 AND sale_money > 0 AND quantity > 0   -- 护栏（退化命中排除）
AND abs(discount_money − order_detail_std_price × quantity) <= 0.02  -- 容差 ±0.02 逐字
```

**真值复现核验**：判别式在真湖上逐字重跑，09-27（账套 3120）= **24 行 / 363.01** —— 与正典 §1
的平台真值标签**逐字相等**；09-23~09-29 各日 3120 命中 363.01~11,584.57、64188 各日 36.45~2,510.74，
形状与正典跨日观测一致。退化命中（公式成立但护栏排除）全湖 0~61 行/日（64188 偏多），
按正典由护栏三条件排除，**不进断言面**（正典已记载的 by-design 排除）。

### 2.2 退货归属（正典 §0）

```sql
state = 'FINISHED' AND order_transaction_type <> 'SALE_ORDER'
AND order_ref_billno → 原单 bizday        -- join 回湖（键 = order_ref_billno → order_no）
```

### 2.3 归零公式的平台侧（|gap|<0.5）——**不落、不假装**

现有 audit 没有平台数据通路（两条指标 audit 都是湖内两层数互对：parquet vs marts/staging）；
凭据面（console 容器网关调用）不在 dbt 测试可达面。按任务边界：**没有平台通路的断言不假装在对账**。
平台侧逐日对账属于正典 §4 的后续（拉平台报表 × 湖侧公式跑一个周期），不在本 PR。

## 3. 设计依据的湖侧实测（2026-09-30，pg_duckdb 免凭据只读，全湖两账套 09-23~09-30）

| 测量 | 结果 |
|---|---|
| FINISHED 行 txn_type 分布 | SALE_ORDER 142,557 / FULL 524 / PARTIAL 97 / NO_ORDER 16；**null = 0** |
| FULL/PARTIAL 缺 ref | **0 行**（全湖）⇒ 「必须有 ref」红闸成立 |
| NO_ORDER_RETURN 缺 ref | 16/16（类型语义=无原单退货，**按定义无 ref**）⇒ 不立「缺 ref」闸，立反向闸（带 ref 即矛盾） |
| ref join 回湖 | FULL/PARTIAL 共 621 个带 ref 行，**616 join 上**；join 上的原单 bizday **全部唯一**（歧义=0）、原单全部含 FINISHED 行 |
| join 不回湖 | **5 行**：3 行 = 3120 湖首日 09-23（原单在湖外，正典 §3 已记载的边界）+ 2 行 RW 前缀单号（`RW13424260927000009` / `RW13424260929000014`——原单是本管线采不到的单号系） |
| 赠品命中跨日 | 两账套每个观测日都有命中（正典 §1 一致）⇒ 空转自检的依据 |

> 实测途中发现一个与断言无关但值得留档的现象：对 `coalesce(txn_type,'(null)')` 这类**未 cast 的
> 表达式**做 GROUP BY 键时，真机上出现过**同键分裂成多行**且分裂边界跨查询漂移（各分裂行计数与
> 金额之和与合并值一致）。显式 `::varchar`/`::date` cast 全部键后稳定。本族测试所有键/算术均已
> 显式 cast（见 §6 的坑清单），但后来者在 pg_duckdb 上写裸表达式分组要警惕。

## 4. 断言清单（出行即失败；行带 (账套,日,店,商品,ref) 与数量/金额差额，不红总数）

### 4.1 `audit_lemeng__retail__recon_gift_hit.sql`

1. **命中集两侧一致**：parquet 复算 vs staging 投影，按归零公式消费粒度 (账套,日,店,商品) 对拍
   行数 / Σquantity / Σsale_money。staging 把 v2 列 cast 成 numeric(18,3)/varchar——cast 漂移
   （截断/精度丢）会改命中集，这里能抓（复算侧直接打 parquet，两侧各写各的 cast，方法同两条指标
   audit 的「独立复算」）。
2. **空转自检**：湖里有 FINISHED 且 sale>0 的行、但全湖零命中 = 判别式静默失明（v2 列死掉 /
   std_price 断供 / 容差漂移）⇒ 出行。

### 4.2 `audit_lemeng__retail__recon_return_attribution.sql`

1. **退货行集两侧一致**：parquet vs staging，按 (账套,日,交易类型) 对拍行数与金额（staging 对
   txn_type/ref_billno 的 varchar cast 漂移能抓）。
2. **缺 ref 硬闸**：FULL/PARTIAL_ORDER_RETURN 行必须带 order_ref_billno（实测 0 行 ⇒ 0 是唯一
   已见合法形态）；按 (账套,日,店,商品) 聚合计数与金额。
3. **FINISHED 行 txn 为空**：`<> 'SALE_ORDER'` 对 NULL 求值为未知 ⇒ 行**静默掉出**判别式
   （实测 0 行）；按 (账套,日,店,商品) 计数。
4. **NO_ORDER_RETURN 带 ref**：类型语义矛盾（实测 0 行）；逐行给 ref 与金额。
5. **归属歧义硬闸**：ref join 回湖后原单行必须落在唯一 bizday（实测 0 行）；逐 ref 报跨日数。
6. **空转自检**：有 FINISHED 行但退货行集为空 = txn 列死掉 ⇒ 出行。

## 5. 「ref join 不回湖」的口径裁决（5 行实测）

已 ask 协调者（msg_9e5df6f69c73，2026-09-30）给出三个选项：**A** 任何 FULL/PARTIAL 的 ref join
不回湖即红（今天即红 5 行——3 行湖首日边界 + 2 行 RW 前缀单号，合并当天起每天红，直到回填/补源）；
**B** 不进硬断言、只立 §4.2 的结构闸（测试今天即绿，5 行作为已知盲区写档）；**C** 按 ref 形状分
（RW 前缀/湖首日之外才红——把今日观察立成永久规则）。**截至本 PR 发出时裁决未回，按 B 落**，
理由：

- A 的长期红 = 每天一次企微告警的**假红账本**——5 行里 3 行是冻结的历史边界（湖首日，原单永远在
  湖外，除非回填再向前铺），红不会自愈；天天红会淹没**新增**的破洞（分不出「又是那 5 行」还是
  「新断了 50 行」）——那正是把红改成绿的反面。
- C 违反「无案例不立标准」（把 RW 前缀、湖首日这些**今日观察**编码成永久判据）。
- B 的已知盲区在头注与本节显式写档；升级到 A 是**加一个 UNION 分部**的事（逐 ref 出行带
  (账套,日,店,商品,ref,金额)），裁决要 A 时改一处即可。

**B 承担的残余风险（诚实写明）**：若原单采集**整体断供**而退货照采（ref 全量 join 不回湖），
本断言面不会红——退货行集两侧一致、ref 在场、无歧义都照过。该形态的兜底在别处：采集侧
run-retail-day 的逐窗判据 + 归零公式的平台侧逐日对账（正典 §4-2 的后续，非 dbt 面）。
裁决若选 A，此风险关闭。

5 行的构成（供裁决与将来回填核对）：

- 3 行湖首日边界：3120 / 09-23 / FULL_ORDER_RETURN ×3（ref `3120157262650010039`，2,075.20 元）
  ——原单销售日在湖覆盖起点之前；
- 2 行 RW 单号：3120 / 09-27 店 61 `RW13424260927000009`（19.80 元）、09-29 店 48
  `RW13424260929000014`（15.00 元）——原单属另一单号系，本管线采不到。

## 6. 验证

| 验证 | 结果 |
|---|---|
| `node scripts/check-data-models.mjs`（本地） | OK（staging 4 / 指标 2 / **对账测试 4** / L2 1 / sync 1） |
| 赠品测试编译形态 SQL 真库全量跑 | settled 日（bizday<09-30）**0 行**；全湖仅 7 行、全部落在 09-30 且全部是「parquet 有 / staging 无」——即当天新鲜度竞态（staging 停在当日 03:20 UTC 物化版），非两侧算不一致 |
| 退货测试编译形态 SQL 真库全量跑 | settled 日 **0 行**；全湖仅 2 行、同上性质（09-30 的 3120 FULL 3↔2、64188 NO 1↔0）；六类硬闸在真数据上**全部静默** |
| `dbt parse` / `dbt test` 本地 | **没法跑**：本机无 dbt 二进制、无 pg_duckdb/S3 凭据环境（仓内既有形态，非本 PR 缺口）。替代法 = 把 Jinja（var/ref）逐字替换后经 `docker exec <pg_duckdb> psql` 全量执行——**比 parse 强**（真执行了查询计划，含 pg_duckdb 的类型匹配层） |
| 真跑一轮完整 `dbt build`（含本族 tests） | 留给下一次物化 job（03:20 UTC）自然执行；job 的 `--select` 覆盖 staging/fct，本族 tests ref staging ⇒ 会被带上（eager indirect selection） |

真跑通道（只读复核用，与 2026-09-29 诊断工具 spec 的通道 C 同源）：

```sh
# openship MCP server exec（数据面机 8281d598）：
docker exec -i openship-platform-core-shanhai-data-pg_duckdb \
  psql -U platform -d warehouse -At -F'|' < <编译后的测试 SQL>
```

**pg_duckdb 跨引擎三个坑**（本族测试头注已记，这里汇总；两条指标 audit 时代未踩到）：

1. `r['列']` 之间的算术必须先 `::numeric`：`abs(r['a'] - r['b'])` 报
   `function abs(duckdb.unresolved_type) does not exist`。
2. FULL JOIN … USING 的键两侧类型要对上：`r['branch_num']` 不 cast 报
   `JOIN/USING types duckdb.unresolved_type and integer cannot be matched`。
3. DuckDB 侧聚合值与字面量 coalesce 也要先 cast：`coalesce(x, 0)` 报
   `COALESCE types duckdb.unresolved_type and integer cannot be matched`。

## 7. 边界与诚实清单

- **新鲜度竞态（与既有指标 audit 同性质，非新增）**：物化 job 同一轮 dbt build 里「先物化 staging
  再跑 tests」，若测试执行瞬间湖又落新窗口，两侧在**当天**差一拍（本日实测：赠品 7 行 / 退货 2 行
  全部此性质）。settled 日不受影响。job 的 retry 2×/300s 可吸收偶发；持续红再看是不是采集时序变了。
- **空转自检的假红面**：某天促销真停（全湖当日零赠品）会让赠品自检红——那是「要人来判」的事，
  不是静默放行的事（头注已写）。同理 txn 类型集合若上游新增枚举（本次实测途中就见到
  `REPAID_RETURN` 在 CANCELED/REPAID 状态下出现，FINISHED 下未见），只要不是 NULL 就不影响断言面。
- **NO_ORDER_RETURN 的金额不入归零公式**（16 行 / 全湖，无 ref 可归属）——它不是「缺 ref 的破洞」
  而是类型的定义；若平台 return_money 口径把它算进去，逐日对账时会在该日露出 gap，属正典 §4
  「跑一个周期」要验的，不是本断言面能对的。
- **join 不回湖的 5 行**：口径裁决见 §5。
- **staging 侧对账的极限**：本族能把「parquet → staging 投影」对上，保证不了「湖里列的语义」
  本身（同指标 audit 的已知边界）；湖本身的错要靠人工抽样（README §7 第三档）。

## 8. 后续（不在本 PR）

1. 正典 §4-2：拉平台报表 × 湖侧公式逐日跑一个周期，把判别式升级为多日验证（平台通路在
   console 容器，可做成 openship job，非 dbt）。
2. `RW` 前缀原单是否有可得源（若接得，§5 的 2 行可归）。
3. 判别式转正（S5 口径面）：若转正，赠品/退货排除进 marts 口径 + `l1_metrics.yml` 声明，
  本族测试随之升级为指标 audit（挂指标、物化侧换 marts）。

Refs #287（对账缺口）· #396（判别式定案）
