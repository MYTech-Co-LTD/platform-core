# #294 Wave B 子管线补采 6 字段 + 契约 v2 + item_code 语义归位

> 2026-09-29 ｜ Orca worker `task_1fb2e83ecfed`（dispatch `ctx_335605bbfa3c`）
> ｜ 本 worktree `platform-core/issue294-fields`（分支 `ylwzzs/issue294-fields`，基于当日 fetch 的 origin/main `8dd839d`）
> ｜ 目标 issue：#294（**Refs 不 Closes**——issue 留到 Wave B 投递后关）
>
> **全部验证在本机 lab**：`/tmp/i294-lab/`（mock 网关 `127.0.0.1:8898` + 回环 MinIO `127.0.0.1:9900` 复用 waveB-lab 容器，
> 独立 system_book=3294 前缀，不碰 3120/64188 的既有 lab 对象）。**零生产写入**：未打真网关、未投递、未动生产容器/调度/64188。

---

## 0. 一句话结论

**落地完成**：子管线 flatten 18→24 列（mock 实跑全绿、落盘 parquet 逐列验值正确）、契约 v2 与 schema.yml 的 item_code 语义归位同步、
全部门禁绿；**staging 暂不加列**的约束拿到了本地 DuckDB 实证（选新列 bind 报错逐字在案），且实验还翻出一个**比预期更硬的事实**：
新形 parquet 一旦在 glob 里排到第一个，**连现行「只选旧 18 列」的 staging 读法都会整挂**（schema mismatch）——
历史回填（挂账任务）**必须先迁读侧**，否则会把现行物化直接打红。

---

## 1. 改动清单（4 个文件）

### 1.1 `deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json`

- **flatten（code.sql）**：现有 18 行（含 `item_code` 行）逐字未动，尾部追加 6 列：

| 新列 | 层级/来源 | cast |
|---|---|---|
| `order_transaction_type` | 订单级 `o.` | `CAST(o.order_transaction_type AS VARCHAR)` |
| `order_ref_billno` | 订单级 `o.` | `CAST(o.order_ref_billno AS VARCHAR)` |
| `order_detail_share_discount` | 明细 `u.d` JSON | `CAST(json_extract_string(u.d, '$.order_detail_share_discount') AS DECIMAL(14,2))` |
| `order_detail_std_price` | 明细 `u.d` JSON | 同上 `DECIMAL(14,2)` |
| `order_detail_price` | 明细 `u.d` JSON | 同上 `DECIMAL(14,2)` |
| `order_detail_online_qty` | 明细 `u.d` JSON | 同上但 `DECIMAL(14,3)` |

- **12 个 `src.rest` 源节点的声明 schema**：各加 `order_transaction_type` / `order_ref_billno`（string，插在 `order_source` 之后）。
  理由：flatten 消费的订单级字段在本文件的既有风格里**全部有声明**（`order_no/state/order_time/order_operate_time/order_source/branch`），
  新增两个照办。实测补充：只改 flatten 不改 schema 时 `validate_pipeline` 也 **ok**（src.rest 是运行时物化、编译期不 bind 列名），
  即声明不是编译前置，而是形状声明 + 与既有风格一致。

### 1.2 `contracts/common/lemeng.retail_order_line.json`（v2 = 24 列）

- `columns` 追加上表 6 列，类型/精度/可空性与管线 cast 一致（全部 `nullable: true`——cast 的输入可缺 ⇒ 落 NULL；
  真机实证 `order_detail_share_discount` 本就非满员：43/67 行有值）。
- **`contractVersion` 保持 1 不动**：该字段是**契约格式版本**（`_schema.schema.json` 里 `const: 1`，其 description 明言
  「格式本身要改时递增」），列集变更不是格式变更。v2 变更记在**顶层 description**（2026-09-29、18→24、列名清单、#294），
  这是该文件在 schema 允许范围内唯一的「注释位」（列级无 note 字段，`additionalProperties: false`）。
- **超出最低限度的一处（披露，可回退）**：`item_code` 列的 description 从「商品业务码（跨品牌归并键）」改为如实描述
  （上游订单 API 无此字段、恒空串、归并职责在 `dim_item.item_code`）。与任务标题「item_code 语义归位」同向，
  不改任何机器行为（名称/类型/可空性未动）。

### 1.3 `dbt/models/common/staging/schema.yml`（只改 item_code 两处描述）

- `stg_lemeng_retail_order_line.item_code`（协调者定案逐字）：
  「上游订单 API 无此字段（PosOrderDetailAiVO/PosOrderAiVO 均无），恒空串；跨品牌归并键职责由 dim_item.item_code 承担（实测两账套 100% 有值），join 键 item_num。」
- `stg_lemeng_item.item_code`：补一句「实测两账套 100% 有值（2026-09-28 归因核验）——retail_order_line.item_code 恒空串，跨品牌归并键职责由本列承担（join 键 item_num）。」
- **staging 模型 SQL 一行未动，不加 6 新列**——理由与实证见 §4。

### 1.4 `deploy/data-plane.lock`

管线/ schema.yml 变更后重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs` 重生成（3 行变化：自校验头 + 两文件 sha）。

---

## 2. 字段名核验（对照 2026-09-28-lemeng-recon-attribution.md §5）

| 采纳（6） | 层级 | 真机证据（spec §3.3/§3.2 逐字） |
|---|---|---|
| `order_transaction_type` | 订单 | ∈ {SALE_ORDER, PARTIAL_ORDER_RETURN, FULL_ORDER_RETURN, NO_ORDER_RETURN}；非 SALE 行金额逐分=平台 return_money（§3.2） |
| `order_ref_billno` | 订单 | 退货关联原单号（问答 Q3 取证，文档有） |
| `order_detail_share_discount` | 明细 | 店 19 非空计数 43/67；自算分支级 sd 1120/1120 逐分相等（§4） |
| `order_detail_std_price` | 明细 | 非空 67/67 |
| `order_detail_price` | 明细 | 非空 67/67 |
| `order_detail_online_qty` | 明细 | 非空 67/67 |

**明确不采（3 个真机恒空，已核对没采错）**：`order_detail_state`（0/67）、`order_detail_policy_flag`（0/67）、
`order_detail_policy_present_flag`（恒 False）——spec §3.3 直方图逐字在案。

---

## 3. Lab A：mock 正反向实跑（配方 = 2026-09-29-duckle-l1-retail-waveB-verify.md）

### 3.1 环境

| 项 | 值 |
|---|---|
| duckle / DuckDB | 0.7.4 / 1.5.5（`/private/tmp/duckle-lab-p1/.venv074`，与 deploy/duckle Dockerfile 钉的版本一致） |
| mock 网关 | `/tmp/i294-lab/mock/mock_gateway.py`（照 waveB 版抄，**绑 127.0.0.1:8898** 不动原 lab 的 8899）；订单 fixture 扩 6 新字段：订单级 `order_transaction_type`（seq0=SALE_ORDER 无 ref 键 ⇒ 验 NULL 透传 / seq1=FULL_ORDER_RETURN 带 `REF-<hour>-0001`），明细级 4 列随行号 `i` 取确定值（`1.00+0.5i / 10.50+0.25i / 9.99+0.01i / 0.500+0.25i`） |
| 对象存储 | 复用回环 MinIO `127.0.0.1:9900`（waveB-lab 容器），桶 `lemeng-lab` 下独立前缀 `system_book=3294/`（whoami company_id 同步设 3294 过身份门），不碰既有 3120/64188 对象 |
| 驱动 | `/tmp/i294-lab/drive.sh`（derive：URL→8898、`/workspace/`→lab ws、retryBackoffMs 60000→200；reset；run：env `SYSTEM_BOOK=3294 BRANCH_NUMS=[1001,1002,1003]`）——lab 变体规则与 waveB verify 相同，无行为改动 |
| 凭据 | 连接沿 waveB-lab 的 `enc:v2:` 加密连接 + 同源 key（lab 专用假凭据，未进仓） |

### 3.2 正向结果（跑的是**本 worktree 改后管线**的 lab 变体）

```
run id   : run-manual-lemeng-retail-windows-l1-1790652701284
status   : ok        （fe ok 24 rows / su 24 rows / sr 0 rows，exit 0）
```

- mock 请求 **289**（whoami×1 + 24 窗×12 页），与 waveB 基线一致；
- 湖上 `system_book=3294/bizday=2026-09-28/hour=00..23` 恰 **24 个对象**，144 行（24×6），逐 hour `batch_id` 数恒 1；
- **parquet 24 列**，列名与顺序逐字：

```
[batch_id, system_book, bizday, hour, order_no, order_detail_num, branch_num, branch_name,
 order_time, order_operate_time, state, order_source, item_num, item_code, sale_money,
 discount_money, payment_money, quantity, order_transaction_type, order_ref_billno,
 order_detail_share_discount, order_detail_std_price, order_detail_price, order_detail_online_qty]
```

**6 新列逐列验值**（`/tmp/i294-lab/evidence/labA-verify.out`）：

| 列 | 判据 | 结果 |
|---|---|---|
| `order_transaction_type` | 直方图 | SALE_ORDER 96 + FULL_ORDER_RETURN 48 = 144 ✓（= 每小时 4 SALE 行 + 2 退货行） |
| `order_ref_billno` | 精确匹配 + 语义交叉 | 96 NULL + 48 = `REF-<hour>-0001` 逐字、0 错配；`(type=FULL_ORDER_RETURN) ⇔ (ref 非空)` 违例 0 ✓（**缺键 ⇒ NULL 透传**验证通过） |
| `order_detail_share_discount` | 行号公式 | `00-0→1.00 / 00-1→1.50`（24 小时同构），公式违例 0 ✓，类型 `decimal(14,2)` ✓ |
| `order_detail_std_price` | 同上 | `10.50 / 10.75`，违例 0 ✓，`decimal(14,2)` ✓ |
| `order_detail_price` | 同上 | `9.99 / 10.00`，违例 0 ✓，`decimal(14,2)` ✓ |
| `order_detail_online_qty` | 同上 | `0.500 / 0.750`，违例 0 ✓，`decimal(14,3)` ✓ |

**老 18 列回归**：`sale_money=10.00 / discount_money=0.00 / payment_money=10.00 / quantity=1.000 / item_code=C000·C001` 全行一致（144 行仅两值分组，各 72）✓。

### 3.3 反向（validate + 机检守卫）

- `validate_pipeline`：子管线（24 列 flatten 编译）ok（20 stages）、父管线 ok（19 stages）——duckle MCP 直读仓内文件；
- 机检：`check-data-plane-lock` / `lint-architecture` / `check-compose` / `check-env-example` / `check-manifests` / `check-data-models` 全绿，
  `pnpm typecheck` exit 0。

---

## 4. Lab B：5 分钟约束实证（「staging 暂不加列」的锚）

复刻 stg 模型的**确切读法**（`dbt/models/common/staging/stg_lemeng_retail_order_line.sql`：
`from read_parquet('<glob>') r` + `r['列名']` 下标取列——单位置参数，无 `union_by_name`）。
本地建 A（18 列旧形）/ B（24 列新形）两个 parquet 后 glob 混读，**DuckDB 1.5.5 逐字输出**（`evidence/labB-parquet-constraint.out`）：

**B-1 旧文件在前、只选旧列（= 现行 stg 形态，新形文件的额外列被忽略）：**
```
┌──────────┬──────────────┐
│ order_no │  sale_money  │
├──────────┼──────────────┤
│ O1       │        10.00 │   ← A、B 两文件的行都在（2 行）
│ O1       │        10.00 │
└──────────┴──────────────┘
```

**B-2 旧文件在前、选新列（= staging 加列的后果）：**
```
Binder Error: Could not find key "order_transaction_type" in struct

Candidate Entries: "order_no", "order_operate_time", "order_source", "order_time", "order_detail_num"
```

**B-3 新文件在前、只选旧列（⇒ 比预期更硬：整个 glob 读挂，不只新列）：**
```
Invalid Input Error: Failed to read file "/tmp/i294-lab/labB-rev/02-old18.parquet": schema mismatch in glob:
column "order_transaction_type" was read from the original file "/tmp/i294-lab/labB-rev/01-new24.parquet",
but could not be found in file "/tmp/i294-lab/labB-rev/02-old18.parquet".
Candidate names: batch_id, system_book, bizday, hour, order_no, order_detail_num, branch_num, branch_name,
order_time, order_operate_time, state, order_source, item_num, item_code, sale_money, discount_money,
payment_money, quantity
If you are trying to read files with different schemas, try setting union_by_name=True
```

**B-4 新文件在前、选新列：** 同 B-3 的 `Invalid Input Error: schema mismatch in glob`（整挂）。

### 4.1 解读（写进 #294 评论的口径）

1. glob 的 schema 取自**第一个被打开的文件**。现行湖布局里分区键含 `bizday=`（YYYY-MM-DD 字典序=时间序），
   老分区（18 列）天然排在前 ⇒ 切流后落新形分区，staging 现行读法落在 **B-1 形态：照常工作，新列被忽略**。
   ——**推论**（非本实验直接测得，是布局+实测行为的合成判断）：这个「照常工作」依赖**最老分区仍是旧形**这一排序事实。
2. **staging 不能加列的实证**：B-2——老分区还在湖里，`select` 新列即 `Binder Error`（pg_duckdb 侧 `read_parquet`
   只收位置参数、`union_by_name` 递不进去，stg 模型头注 2026-09-24 真机实测原文已记）。⇒ 新列先落湖累计，读侧另立任务。
3. **⚠️ 回填前置条件（本轮新发现）**：历史回填若用**新管线**重写老 `bizday`（这正是挂账任务想做的——让
   `order_transaction_type` 覆盖对账期），被重写的**最老分区**会变成 24 列 ⇒ glob 第一个文件变新形 ⇒ **B-3 形态：
   现行 staging 连旧 18 列都读不出来，物化直接红**。⇒ **回填必须与读侧迁移（union_by_name 形态或 duckdb.raw_query
   通路）同批或其后**，绝不能先回填。

---

## 5. 门禁与交付

| 项 | 结果 |
|---|---|
| `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs` | 重生成，`check-data-plane-lock: OK` |
| `validate_pipeline`（子/父） | ok / ok |
| `lint-architecture` / `check-compose` / `check-env-example` / `check-manifests` / `check-data-models` | 全 OK |
| `pnpm typecheck` | exit 0 |
| PR CI：unit / web / smoke | **pass** |
| PR CI：discipline / gates | **fail** ——唯一成因：任务书要求 PR body 写 **Refs #294 不写 Closes**，而 `check-pr-discipline.mjs` 对 feat 类 PR 硬性要求 `Closes #N`（与 X-Issue/分支号一致）或 `skip-issue` 标签。**代码相关检查全绿，无其他红因**。处置选项（A=skip-issue 标签（推荐）/ B=改 Closes / C=保持红）已 escalade 给协调者裁决（worker 不擅自改 PR）；裁决前无人能合（CLEAN 才可合），状态安全 |
| 分支/PR | `ylwzzs/issue294-fields`（当日 fetch 后与 origin/main `8dd839d` 一致）；PR **Refs #294**（不写 Closes），不合并 |

## 6. 挂账（已写进 #294 评论，未实施）

1. **`retail_order_line` 历史回填任务**：用补采后的管线重写对账期历史分区，使 `order_transaction_type` 等新列覆盖对账期。
   **硬前置**：必须先迁读侧（§4.1-3 的 B-3 实证），否则现行 staging 物化被打红。
2. **读侧消费新列**（历史回填或 raw_query 迁移）单独立任务。

## 7. 纪律声明

本机 lab 零生产写入（未打真网关/未投递/未动生产容器与调度与 64188）；lab MinIO 凭据为回环容器专用假凭据，未进仓未进报告；
mock/驱动脚本只在 `/tmp/i294-lab/`，仓内只落本报告与 4 个交付文件。
