-- 物化落点 gate 2 的**显式表态**：staging 必须落在 PG 可见关系上（表/视图），
-- 不能是 read_parquet 的裸扫描结果 —— 裸扫描不进 pg_class ⇒ Metabase 与任何 PG 客户端看不见
-- （spec §9.4）。项目的缺省已是 table，这里再钉一次是为了「改项目缺省时不静默改变本模型语义」。
-- ⚠️ 注释必须留在 Jinja config 块外：块内是 Jinja 表达式、不认 SQL 注释行（真 dbt 1.9.1
--   parse 实测报 expected token，2026-09-23 T6 收尾订正）。
{{
    config(materialized='table')
}}

-- stg_lemeng_retail_order_line.sql — 乐檬零售订单明细 staging（**新湖**，2026-09-24 契约；
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
-- 子查询/CTE。既有 `stg_lemeng_retail_detail.sql`（旧湖）用的是
-- `with r as (select * from read_parquet(…)) select r['…']` 形态 —— 那个形态在本栈上**取列即报错**
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
-- 【三】契约 18 列**全带**（一对一不许丢列）
--    （另加 **dbt 注入列 `org`**：主体列，非契约列，见 dbt/macros/subject_org.sql）
-- ════════════════════════════════════════════════════════════════════════════════════════
-- `hour` 与 `order_operate_time` 也在内 —— 下游 marts 用不用是 marts 的事，③ 层没有资格替它裁。
-- 列的空值性以 `contracts/common/lemeng.retail_order_line.json` 为准（本层不加语义）。
--
-- 【前缀单点】`lemeng_retail_order_line` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_retail_order_line_prefix`（与两个 audit 共用一处，避免三份路径字符串各自漂移）。
select
  r['batch_id']             as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date         as bizday,
  r['hour']::int            as hour,
  r['order_no']             as order_no,
  r['order_detail_num']     as order_detail_num,
  r['branch_num']           as branch_num,
  r['branch_name']          as branch_name,
  r['order_time']           as order_time,
  r['order_operate_time']   as order_operate_time,
  r['state']                as state,
  r['order_source']         as order_source,
  r['item_num']             as item_num,
  r['item_code']            as item_code,
  r['sale_money']           as sale_money,
  r['discount_money']       as discount_money,
  r['payment_money']        as payment_money,
  r['quantity']             as quantity
-- pg_duckdb 把 read_parquet 委托给 DuckDB 执行。裸扫描结果**不是 PG 关系、不进 pg_class**
-- （spec §9.4 可见性坑）⇒ 它只出现在 staging 模型内部，物化落点由上面的 config + 项目缺省保证
-- 是 PG 可见关系（gate 2）。
from read_parquet(
  -- ⚠️ 路径段写 `system_book=*/` **通配两个账套**（故此处不用 `account_book` var）——与门店维/商品维**同源形态**
  -- （见 sources.yml 的 branch 条目注释）。`system_book` 是**列**：由路径 `system_book=<值>/` 自动推断
  -- （类型推成 bigint，下面显式 `::varchar` 定型）。
  -- 2026-09-26 改：64188（品品甜）铺开后，钉单账套的路径会让它的数据**落湖了却进不了物化**（issue #250）。
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
) r
