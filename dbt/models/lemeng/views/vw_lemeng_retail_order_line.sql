-- vw_lemeng_retail_order_line.sql — 乐檬零售订单明细**直读湖视图**（读面，不是 staging）。
--
-- 本文件正文与 `dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql` **逐字相同**，
-- **只翻物化方式**（`table` → `view`）：同一份 FROM 块（冷/热两段 + 封版断言）与同一份列区。
-- ⇒ 正文要改就回 staging 那一份改，再整份复制过来；**不要在这里单独改**。
--
-- ⚠️ 列区是生成物：由 `scripts/gen-data-projection.mjs` 按
--   `contracts/common/lemeng.retail_order_line.json` 重写 —— 生成器对 staging 与本视图用**同一份**
--   `buildStagingSelect` ⇒ 两份列清单逐字同源。**禁止手写列清单**（手改会被 `--check` 报红）。
--
-- 物化落点：视图仍落在 PG 可见关系上（进 pg_class，Metabase 与任何 PG 客户端看得见），
-- 但**不落数据**——每次查询按下面的 FROM 现读湖。
-- ⚠️ 注释必须留在 Jinja config 块外：块内是 Jinja 表达式、不认 SQL 注释行（真 dbt 1.9.1
--   parse 实测报 expected token，2026-09-23 T6 收尾订正）。
{{
    config(materialized='view')
}}

-- 以下正文（含分层纪律、分区键定型、取列形态、契约列集、冷/热两段 FROM）**逐字取自 staging**，
-- 其说明同样适用于本视图。
-- 正文出自 stg_lemeng_retail_order_line.sql — 乐檬零售订单明细 staging（**新湖**，2026-09-24 契约；
-- layered §3：**一对一、只规范化不改义**）。
--
-- 分层纪律：③ 层只做「取列 / 命名 / 透传 / 分区键定型」，**不做聚合、不做 join、不改口径**
-- （口径只在 ④ marts 定义一次）。湖已落盘即定型（numeric/timestamp/date），本层不改义。
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 【一】分区键定型：本文件实际生效的机制 = **三个显式 `::type` cast**（不是 `hive_types`）
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 为什么不能用 `hive_types`（或任何 `hive_partitioning=1` 形态）：pg_duckdb 把 `read_parquet(...)`
-- 暴露成 **PG 函数**，它只认**位置参数**，**任何命名形参都进不去** —— 2026-09-24 数据面真机实测原文：
--   · `select count(*) from read_parquet('s3://…/**/*.parquet', hive_partitioning = 1)`
--       → `ERROR:  column "hive_partitioning" does not exist`
--   · `… , hive_partitioning := 1)`（DuckDB 的 `:=` 形态）
--       → `ERROR:  function read_parquet(unknown, hive_partitioning => integer) does not exist`
-- 即「改用 hive_types 钉死」这条退路在本栈上**根本不可达**：形参递不进去，不是写法不对。
-- （反过来说：命名形参只在 `duckdb.raw_query($$ … $$)` 那种**整段交给 DuckDB** 的入口里才存在。）
--
-- 但**分区推断本身是生效的**（勿回退到「从 filename 正则提取」的老退路）：路径里的 `key=value`
-- 段被自动识别成 hive 分区列（DuckDB 的 `hive_partitioning` 默认 = auto），三列**作为列出现**；
-- 若推断未生效，这三列根本不会是列。来源**唯一** = 路径字符串 —— `partitionBy` 已把三个分区键
-- 从**文件体里剥离**，故不存在「行内列 vs 分区键」同名遮蔽问题。
--
-- 推断出的类型**不合约**，故三列必须显式 cast（真机 `pg_typeof` 实测，2026-09-23 日数据）：
--   · `system_book` → **bigint**（路径段 "3120" 被自动转型；契约要求 varchar）⇒ `::varchar`
--   · `hour`        → 跨小时整读时是 **varchar**（零填充 '00'…'23' 保留字符串；单读 `hour=17`
--                     这种无前导零的目录才是 bigint）⇒ `::int`（两种推断下都成立）
--   · `bizday`      → **date**（管线落盘即定型，合契约）⇒ `::date` 为幂等保险
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 【二】取列形态：`from read_parquet('…') r` —— 别名挂在**函数调用**上（不是 CTE 形态）
-- ════════════════════════════════════════════════════════════════════════════════════════
-- `r['列名']` 是 pg_duckdb 的构造，它要求 `r` 是 **read_parquet 调用的别名**，而**不是**一个 PG
-- 子查询/CTE。~~既有 `stg_lemeng_retail_detail.sql`（旧湖）用的是~~
-- `with r as (select * from read_parquet(…)) select r['…']` 形态 —— 那个形态在本栈上**取列即报错**
-- （承此教训的旧湖文件已于 2026-10-06 仓内退役；下面这段原文保留为**反例留证**，不是现役代码）
-- （它从未在真机跑过：数据面 `/opt/…/dbt/target/` 里只有 `dbt parse` 的产物，没有 run_results）。
-- 2026-09-24 真机实测原文：
--   `with r as (select * from read_parquet('…')) select r['order_no'] from r`
--     → `ERROR:  cannot subscript type record because it does not support subscripting`
-- pg_duckdb 的报错提示（原文）也是这个方向：
--   「If you use DuckDB functions like read_parquet, you need to use the r['colname'] syntax to use
--     columns. If you're already doing that, maybe you forgot to give the function the r alias.」
-- 故本文件用**函数别名**形态。静态门禁规则 ① 要的正是 `r['列名']` 这个构造 ⇒ 本形态同时满足
-- 门禁与真机（CTE 形态只满足门禁、真机报错 —— 那正是「静态绿 ≠ 跑得动」的形态）。
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 【三】契约列集：v1 = 18 列、v2 = 24 列（2026-09-30 Phase 2 / #294）、v3 = 25 列（2026-10-05 / #430）。
--   本层**全带 25 列**，并在 FROM 段带**封版断言** —— 即 docs/architecture.md §5.2 的**迁移**步已完成
--   （前提：湖已回填齐 + `_SCHEMA/v3.parquet` 已落；契约 `consumerVersion` 同步置 3）。
--    （另加 **dbt 注入列 `org`**：主体列，非契约列，见 dbt/macros/subject_org.sql）
-- ════════════════════════════════════════════════════════════════════════════════════════
-- `hour` 与 `order_operate_time` 也在内 —— 下游 marts 用不用是 marts 的事，③ 层没有资格替它裁。
-- 列的空值性以 `contracts/common/lemeng.retail_order_line.json` 为准（本层不加语义）。
--
-- 【前缀单点】`lemeng_retail_order_line` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_retail_order_line_prefix`（与两个 audit 共用一处，避免三份路径字符串各自漂移）。
--
-- ⚠️ 下面 `select … from` 之间的**选列区是生成物**：由 `scripts/gen-data-projection.mjs` 按
--   `contracts/common/lemeng.retail_order_line.json` 重写（**勿手改**；改列集 = 改契约一处 + 跑生成器
--   + 重生成 `deploy/data-plane.lock`，CI `gates` 的 `--check` 兜「生成物 == committed」）。
--   生成器只认契约列区、**不保留 `select…from` 之间的注释** ⇒ 原先写在选列里的说明行（2026-10-06
--   #460）搬到这里保留：
--     · **v2 新增 6 列**（2026-09-30 Phase 2，#294/#328）：契约 v2 = 24 列；湖已于 2026-09-30 完成分批
--       回填（#328：五批全 done、全湖均一为 24 列）⇒ 投影可安全加上。类型照抄契约：
--       varchar ×2（order_transaction_type / order_ref_billno）+ decimal ×4
--       （order_detail_share_discount / order_detail_std_price / order_detail_price / order_detail_online_qty）。
--     · **v3 新增 1 列**（2026-10-05，#430，**换货判别的事实源**）：平台 `sale_money` 只算换货单的
--       「送出半边」= (Σ非赠品行额 + order_total_money) / 2（口径正典见 issue #430；同义描述见契约
--       `order_total_money` 列的 description）。**迁移步**：湖已回填齐并落了 `_SCHEMA/v3.parquet` 封版
--       标记 ⇒ 下面 FROM 里那条封版断言就是它的前提（契约 `consumerVersion` 同步置 3）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['hour']::int as hour,
  r['order_no']::varchar as order_no,
  r['order_detail_num']::varchar as order_detail_num,
  r['branch_num']::int as branch_num,
  r['branch_name']::varchar as branch_name,
  r['order_time']::timestamp as order_time,
  r['order_operate_time']::timestamp as order_operate_time,
  r['state']::varchar as state,
  r['order_source']::varchar as order_source,
  r['item_num']::varchar as item_num,
  r['item_code']::varchar as item_code,
  r['sale_money']::numeric(14,2) as sale_money,
  r['discount_money']::numeric(14,2) as discount_money,
  r['payment_money']::numeric(14,2) as payment_money,
  r['quantity']::numeric(14,3) as quantity,
  r['order_transaction_type']::varchar as order_transaction_type,
  r['order_ref_billno']::varchar as order_ref_billno,
  r['order_detail_share_discount']::numeric(14,2) as order_detail_share_discount,
  r['order_detail_std_price']::numeric(14,2) as order_detail_std_price,
  r['order_detail_price']::numeric(14,2) as order_detail_price,
  r['order_detail_online_qty']::numeric(14,3) as order_detail_online_qty,
  r['order_total_money']::numeric(14,2) as order_total_money
-- ══ 冷：月度合并文件（#1916 P1/P2）════════════════════════════════════════════════════════
-- 冷数据由 `lemeng.retail_order_line.month.compact` 把已封版日合并成
-- `_MONTH/system_book=<B>/month=<YYYY-MM>/all.parquet`（只含已封版日，无需 anti-join）。
-- 为什么不再直接 glob `_DAY_DATA`：30 天要打开 60 个 ~300KB 日文件 × 25 列逐列 range 请求
-- （~1,500 次 × 5ms ≈ 7.8s）；月文件后同样范围只开 1–2 个文件（实测 ~0.6s）。
-- ⚠️ 新鲜度：刚封版、但所在月文件还没重建的日子，由**热腿**兜底——热腿的 anti-join 只在
--   `lake_month_index.built_at >= sealed_at`（月文件已包含这次封版）时才排除小时文件。
--   ⇒ 封版 → 月文件重建之间的窗口由小时文件供数，不会出现空洞；GC 在 2 天后才删小时文件，
--     月度合并每天跑，窗口远小于 GC 保留期（积压 >2 天由 dbt 测试判红）。
from read_parquet(
  's3://{{ var("zos_bucket") }}/lemeng/retail_order_line_month/_MONTH/system_book=*/month=*/all.parquet'
) r,
-- ── 封版断言（正典 §5.2 ③）：`_SCHEMA/v<N>.parquet` 是「这套文件是齐的」的唯一凭据 ──────────
-- 它不在 ⇒ 404 ⇒ **带名字地失败**，而不是把半写的湖静默读成完整（实测过：392 行 vs 完整 796 行，rc=0）。
-- ⚠️ 这里的 `v3` / `schema_version = 3` 必须与契约 `contracts/common/lemeng.retail_order_line.json`
--   的 `schemaVersion` 一致（当前 3）——改契约就得改这里，两处漂开会让断言形同虚设。
-- ⚠️ 标记**在表根**、不在 `system_book=*` 之下 ⇒ 不进任何读湖 glob（真机实测命中 0）。
--   若把它挪到数据目录下面，`**/*.parquet` 会把它当**数据文件**读进来、结构体被解析成标记的列
--   （实测报 `Could not find key "sale_money" … Candidate Entries: "sealed_at"…`）。
  read_parquet(
    's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_SCHEMA/v3.parquet'
  ) sealed
where sealed['schema_version'] = 3
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['hour']::int as hour,
  r['order_no']::varchar as order_no,
  r['order_detail_num']::varchar as order_detail_num,
  r['branch_num']::int as branch_num,
  r['branch_name']::varchar as branch_name,
  r['order_time']::timestamp as order_time,
  r['order_operate_time']::timestamp as order_operate_time,
  r['state']::varchar as state,
  r['order_source']::varchar as order_source,
  r['item_num']::varchar as item_num,
  r['item_code']::varchar as item_code,
  r['sale_money']::numeric(14,2) as sale_money,
  r['discount_money']::numeric(14,2) as discount_money,
  r['payment_money']::numeric(14,2) as payment_money,
  r['quantity']::numeric(14,3) as quantity,
  r['order_transaction_type']::varchar as order_transaction_type,
  r['order_ref_billno']::varchar as order_ref_billno,
  r['order_detail_share_discount']::numeric(14,2) as order_detail_share_discount,
  r['order_detail_std_price']::numeric(14,2) as order_detail_std_price,
  r['order_detail_price']::numeric(14,2) as order_detail_price,
  r['order_detail_online_qty']::numeric(14,3) as order_detail_online_qty,
  r['order_total_money']::numeric(14,2) as order_total_money
-- ══ 热：未封版日子的小时文件 ═══════════════════════════════════════════════════════════════
-- ⚠️ **排除条件不是「已封版」，而是「已封版且所在月文件已包含它」**（`built_at >= sealed_at`）。
--   只按「已封版」排除会与月文件之间出现空洞（封版到月文件重建之间两份都没有）；
--   按「月文件已包含」排除则：窗口内由小时文件供数，合并完成后自动切换，**正确性与合并时机解耦**。
--   不做排除的后果是双算（月文件与小时文件并存）。
-- ⚠️ 读侧判定读**仓内封版表** `data.lemeng_daily_sealed`（#1872），不再 glob `_DAILY/`：
--   1,541 个一行小文件在 pg_duckdb 上 >110s 且会打崩后端。`_DAILY/` 标记仍由日管线写，
--   作为表的事实源/回填；表由 DDL 预建，回填必须含 `_bootstrap` 行（system_book='' / bizday=1970-01-01）。
-- ⚠️ 子查询里的 `select 1 from …` 要**写成一行**（`from` 不换行）：`gen-data-projection.mjs` 的
--   位点识别要求「后续位点必须是行首 select」，内联写法才不会被当成第三个投影位点。
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/bizday=*/hour=*/all.parquet'
) r,
  read_parquet(
    's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_SCHEMA/v3.parquet'
  ) sealed
where sealed['schema_version'] = 3
  and not exists (
    select 1 from data.lemeng_daily_sealed m
    join data.lake_month_index i
      on i.system_book = m.system_book and i.ym = strftime(m.bizday, '%Y-%m')
    where cast(m.system_book as varchar) = cast(r['system_book'] as varchar)
      and cast(m.bizday as date) = cast(r['bizday'] as date)
      and i.built_at >= m.sealed_at
  )
