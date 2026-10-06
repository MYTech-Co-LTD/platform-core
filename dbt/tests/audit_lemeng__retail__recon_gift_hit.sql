-- audit_lemeng__retail__recon_gift_hit.sql — 赠品判别式命中集的**独立复算**（对账判别式族）。
--
-- ★ 承 #444（pick 自 #398 已关 PR 的同名文件，commit 4feaa28）：判别式**逐字未改**；
--   基线已从 24 列走到 25 列（#430 加 order_total_money）——本测试不触碰该列，
--   判别式输入列（state / std_price / sale_money / quantity / discount_money）在两版契约里同形。
--
-- ★ 本文件**不挂指标**：`l1_metrics.yml` 没有（也不许有）`lemeng:retail:recon_gift_hit` 这个指标。
--   门禁规则 ⑦（check-data-models.mjs）是**单向**的——「每个声明指标必须有对账文件」；
--   本文件属于另一族：**对账判别式的湖侧自洽断言**（判别式正典 =
--   docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md §0，依据
--   2026-09-28-lemeng-recon-attribution.md 的单日归因）。族内文件名带 `recon_` 段以示区分。
--
-- 判别式（**逐字照抄正典，勿改**）：
--   state='FINISHED'
--   AND order_detail_std_price > 0 AND sale_money > 0 AND quantity > 0   ← 护栏（退化命中排除）
--   AND abs(discount_money − order_detail_std_price × quantity) ≤ 0.02
--   语义：折让 = 标准价全额 × 数量 ⇒ 该行分文未收（白送）。
--   容差 ±0.02 的标定与护栏三条件的依据见正典 §1「容差与稳定性」（±0.005 漏称重尾差行、
--   ±0.5 起误报 ⇒ 定 ±0.02；全期 164 行 std≤0/sale≤0/qty≤0 退化命中 ⇒ 三条件排除）。
--
-- 对账方法（与两条指标 audit 同族的「独立复算」，但比对面不同）：
--   · 复算侧：**直接打 parquet**（不 ref staging、不 ref marts）——复算若走 staging，staging 的
--     cast 错会同时污染两边 ⇒ 对账恒绿。
--   · 物化侧：**staging 表**（stg_lemeng_retail_order_line）。赠品命中集**没有 marts 落点**
--     （口径只许在 marts 定义一次，本判别式还没到转正那步），能对的最深一层就是 staging 的
--     v2 列投影（std_price ::numeric 等 6 列）。staging 把 std_price cast 成 numeric、把湖里的
--     decimal 透传成 numeric——**cast 错了这里能抓**（命中集行数/金额任一侧漂了就红）。
--   · 两侧口径**同量**：都按 (system_book, bizday, branch_num, item_num) —— 即归零公式里
--     赠品排除项的消费粒度（店,商品,日）；失败行直接给出键与两侧差额，不红总数。
--
-- ⚠️ 与指标 audit 共有的**新鲜度竞态**（不是本文件新增的风险）：物化 job 是「先物化 staging、
--   再跑 tests」的同一轮 dbt build；若测试执行瞬间湖又落了新窗口，两侧在**当天**可能差一拍。
--   2026-09-30 实测佐证：手动对拍（staging 停在当日 03:20 UTC 物化版）全湖差 7 行、
--   **全部落在当天 bizday**、剔除当天后 0 差（settled 日两侧逐分一致）。
--
-- ⚠️ 空集也是坑（同族先例：两条指标 audit 的「空转自检」）：湖里有 FINISHED 且 sale>0 的行、
--   而赠品命中集为空 = 判别式静默失明（v2 列死掉 / 容差漂移 / 上游不再回 std_price）——
--   那个「绿」毫无信息量，故出行。依据：正典 §1 跨日实测「3120 各日 363~11,483、
--   64188 各日 36~2,511」——两个账套每个观测日都有命中，全湖零命中不是已见过的合法形态。
--   （边界：若某天促销真停了，本自检会假红——那是要人来判的事，不是静默放行的事。）
--
-- ── 形态：与两条指标 audit **同一套实测形态**──────────────────────────────────────────
--   取列用 `from read_parquet('…') r` + `r['列名']`（别名挂函数调用上，CTE 形态取列报
--   `cannot subscript type record`）；`hive_partitioning=1` 不能作 read_parquet 形参
--   （pg_duckdb 的 read_parquet 是 PG 函数、只认位置参数）。实测坑（2026-09-30 真机踩到）：
--   ① `r['列']` 之间的**算术**必须先 `::numeric`：裸写 `abs(r['discount_money'] - …)` 报
--      `function abs(duckdb.unresolved_type) does not exist`（PG 解析期定不了类型）。
--   ② FULL JOIN … USING 的**键**两侧类型要对得上：`r['branch_num']` 不 cast 就报
--      `JOIN/USING types duckdb.unresolved_type and integer cannot be matched` ⇒ 键逐个显式 cast。
--   ③ DuckDB 侧聚合值与**字面量**做 coalesce 也要先 cast：`coalesce(a.hit_amount, 0)` 报
--      `COALESCE types duckdb.unresolved_type and integer cannot be matched` ⇒ 先 `::numeric` 再 coalesce。
--
-- ── 2026-10-06 定稿补充：只比 **已闭窗营业日**（bizday < 上海今天）──────────────────────
--   上面「新鲜度竞态」在真 harness 里实测会**真红**：物化 job 03:20 UTC 物化 staging、约
--   03:26 跑 tests——两次读湖之间 16~40 秒，tick 每 5 分钟重写当日窗口文件 ⇒ 每晚约 5~13%
--   概率假红（03:20 首跑撞 ETag 的同族竞态，见 #452）。修法与正典定稿线同一哲学：
--   **未定稿日（上海今天）不判**——两侧 CTE 各自过滤 `bizday < 上海今天`。
--   tick 只重写当天的窗口文件 ⇒ 剔除当天后两侧读的是**不可变历史**，竞态窗口归零。
--   （2026-10-06 真机：ad-hoc 对拍剔除当天后 0 差；当天 8 行全部落在当天。）
with recheck as (
    -- 复算：直接打 parquet，按归零公式的消费粒度 (账套,日,店,商品) 聚合命中集。
    select
        r['system_book']::varchar               as system_book,
        r['bizday']::date                       as bizday,
        r['branch_num']::int                    as branch_num,
        r['item_num']::varchar                  as item_num,
        count(*)                                as hit_rows,
        sum(r['quantity'])                      as hit_qty,
        sum(r['sale_money'])                    as hit_amount
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    where r['state'] = 'FINISHED'
      and r['order_detail_std_price']::numeric > 0
      and r['sale_money']::numeric > 0
      and r['quantity']::numeric > 0
      and abs(r['discount_money']::numeric - r['order_detail_std_price']::numeric * r['quantity']::numeric) <= 0.02
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
materialized as (
    -- 物化侧：staging 表上**独立再写一遍**同一判别式（列名是 staging 的投影名，cast 是
    -- staging 已定型的类型——两侧各写各的，对账才成立）。
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        count(*)          as hit_rows,
        sum(quantity)     as hit_qty,
        sum(sale_money)   as hit_amount
    from {{ ref('stg_lemeng_retail_order_line') }}
    where state = 'FINISHED'
      and order_detail_std_price > 0
      and sale_money > 0
      and quantity > 0
      and abs(discount_money - order_detail_std_price * quantity) <= 0.02
      and bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
)
select
    coalesce(a.system_book, b.system_book)                       as system_book,
    coalesce(a.bizday, b.bizday)                                 as bizday,
    coalesce(a.branch_num, b.branch_num)                         as branch_num,
    coalesce(a.item_num, b.item_num)                             as item_num,
    a.hit_rows                                                   as recheck_rows,
    b.hit_rows                                                   as staging_rows,
    a.hit_amount                                                 as recheck_amount,
    b.hit_amount                                                 as staging_amount,
    (coalesce(a.hit_amount::numeric(20,2), 0) - coalesce(b.hit_amount::numeric(20,2), 0))::numeric(20,2) as amount_diff,
    '赠品命中集两侧不一致（parquet 复算 vs staging 投影）：判别式依赖的 v2 列在某一侧漂了，或当天窗口两侧差一拍（新鲜度竞态，见头注）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, item_num)
where a.hit_rows is distinct from b.hit_rows
   or a.hit_qty is distinct from b.hit_qty
   or a.hit_amount is distinct from b.hit_amount

union all

select
    null, null, null, null, null, null, null, null, null,
    '湖里有 FINISHED 且 sale>0 的行、但赠品判别式全湖零命中：判别式静默失明（v2 列死掉/容差漂移/std_price 断供），不是对上了'
where not exists (select 1 from recheck)
  and exists (
      select 1
      from read_parquet(
          's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
      ) r
      where r['state'] = 'FINISHED' and r['sale_money']::numeric > 0
  )
