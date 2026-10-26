{{
    config(materialized='table')
}}
-- stg_lemeng_item_price.sql — 乐檬**门店商品应用价** staging（新湖；#481 价格批；一对一、只规范化不改义）
-- 【R1 增量模型】行 = 价格**变更事件**（bizday=采集日分区，last_edit_time=事件时间）；「现价」= 每 key
-- 取 last_edit_time 最新——那是口径，落在 publish-dims 的窗口函数里（单一来源），本层只规范化。
-- 分区键推断类型不合约 ⇒ 两列显式 cast（system_book::varchar / bizday::date）；取列必须 `from read_parquet(...) r`
-- 函数别名形态（CTE 形态在 pg_duckdb 上取列即报错，同 stg_lemeng_branch.sql 头注）。
--
-- 【前缀单点】`lemeng/item_price` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_item_price_prefix`（出处：contracts/common/lemeng.item_price.json 的 `layout.prefix`；
--   ⚠️ 刻意不叫 `dim_item_price`——生产者判定按子串匹配，会撞 `dim_item` 契约，见 var 注）。
--   分区键顺序 `["system_book","bizday"]` 与管线的 sink `key` 逐段一致（backfill 另有 bf-*.parquet 同层文件，glob 一并吃）；见
--   `deploy/duckle/console/pipelines/lemeng.dim.item_price.l0*.json` 的 sink 节点）。
--
-- 【run 层】2026-10-26 起 sink 在 `bizday=<日>/` 下**多一层 run 戳目录**（`${datetime}/all.parquet`，
--   issue #1069：本管线 5 次/天而 snk.minio 只有覆盖写 ⇒ 日级 key 会让后一轮覆盖前一轮的增量）。
--   ⇒ glob 写 `bizday=*/**/*.parquet` 而不是 `bizday=**/*.parquet`：单层形态匹配不到多出来的这一层，
--   而新形态**同时**匹配历史单层老文件（2026-10-26 真机实测两种深度都命中）。行语义仍是「变更事件」，
--   同日多轮不会互相覆盖，去重照旧落在 publish-dims 的 last_edit_time 最新窗口。
--
-- 【事件去重】run 目录布局（#1069）之后，同一天的 5 轮各自落文件；而源端增量过滤是**闭区间**
--   （`last_edit_time >= 水位`，刻意：秒级时间戳改 `>` 会漏同秒的后续修改）⇒ 水位边界那个事件会被
--   下一轮**重取**，落进另一个 run 目录 ⇒ 同一事件（键 + last_edit_time 完全相同）出现两行。
--   此前「日级单文件覆盖」把这份重复结构性地掩盖了（同日只剩最后一个文件），所以
--   `assert_stg_lemeng_item_price_key_unique` 到 #1069 上线才红（2026-10-26 实测 108 组，
--   每组 batch 数 2、价 payload 唯一 ⇒ 是同一事件、不是两个不同事件）。
--   ⇒ 本层按**事件键**去重、保留 `batch_id` 最新那行：声明粒度（一行 = 一个变更事件 · 每采集日）
--   由此自洽。去重放在这里而不是 publish：publish 取的是「每 key 最新价」，看不见重复；而断言的
--   护栏只在 staging 有意义。`qualify` + `row_number()` 直读湖实测可跑（15133 → 15025，正好 −108）。
-- 【覆盖双账套】路径段写 `*/bizday=*/` 而不是钉单账套 —— 与 branch/item 同款：一个模型读两个
--   账套分区（`system_book` 是**列**、不是 var）。
--
-- 列与空值性以 `contracts/common/lemeng.item_price.json` 为准（31 列全带，本层不加语义；
-- **另加 dbt 注入列 `org`**）。行粒度 = 账套 × 采集日 × 门店 × 商品(×分级) × last_edit_time（事件键）；
-- `item_grade_num is null` = 主商品行。`regular_real_price` 可空（0/空 = 源侧未单独设置，
-- 发布面 Task 4 过滤，本层照透传）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['branch_matrix_price_actived']::boolean as branch_matrix_price_actived,
  r['item_num']::bigint as item_num,
  r['item_grade_num']::bigint as item_grade_num,
  r['item_code']::varchar as item_code,
  r['bar_code']::varchar as bar_code,
  r['item_name']::varchar as item_name,
  r['spec_num']::varchar as spec_num,
  r['spec_unit']::varchar as spec_unit,
  r['spec_rate']::decimal(18,8) as spec_rate,
  r['item_unit']::varchar as item_unit,
  r['item_category']::varchar as item_category,
  r['item_department']::varchar as item_department,
  r['last_edit_time']::varchar as last_edit_time,
  r['regular_price']::decimal(18,8) as regular_price,
  r['level2_price']::decimal(18,8) as level2_price,
  r['level3_price']::decimal(18,8) as level3_price,
  r['level4_price']::decimal(18,8) as level4_price,
  r['max_price']::decimal(18,8) as max_price,
  r['min_price']::decimal(18,8) as min_price,
  r['regular_real_price']::decimal(18,8) as regular_real_price,
  r['level2_real_price']::decimal(18,8) as level2_real_price,
  r['level3_real_price']::decimal(18,8) as level3_real_price,
  r['level4_real_price']::decimal(18,8) as level4_real_price,
  r['max_real_price']::decimal(18,8) as max_real_price,
  r['min_real_price']::decimal(18,8) as min_real_price
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_price_prefix") }}/*/bizday=*/**/*.parquet'
) r
-- 事件键去重（跨 run 重取，见头注【事件去重】）：同键同 last_edit_time 只留 batch_id 最新那行。
-- 必须挂在 `from read_parquet(…) r` 这一层（`r['…']` 要求 r 是函数别名，不能包 CTE/子查询）。
qualify row_number() over (
  partition by
    r['system_book']::varchar,
    r['bizday']::date,
    r['branch_num']::int,
    r['item_num']::bigint,
    r['item_grade_num']::bigint,
    r['last_edit_time']::varchar
  order by r['batch_id']::varchar desc
) = 1
