{{
    config(materialized='table')
}}
-- fct_transfer_line_quality.sql — 总仓配送出库**行质量构件**（W1 2026-10-12；服务 04-05/04-06/04-07）。
--
-- 【它为什么存在】04-05 批号填写率 / 04-06 零成本暴露 / 04-07 负金额调整是**行级/单头级**的面，
--   聚合构件表（fct_hq_outbound）承载不了，而 L1 单 FROM 不允许指向 staging ⇒ 这三个面的
--   聚合口径落本表（口径在 ④ 定义一次）。粒度 (system_book, bizday, branch_num)。
-- 【基面】与 fct_hq_outbound 的 transfer 域完全同款（state_code=3、out_branch_num=99、排除店间直调）。
-- 【口径逐列（客户文档数据条件逐条落位）】
--   · line_count / lot_filled_lines：04-05 全量版（X08 需批号清单未批 ⇒ 考核版待 X08；空白串视为
--     未填——客户文档「空白和占位字符视为无效」）。
--   · zero_cost_amount / zero_cost_rows：04-06「金额≠0 且**已知**成本=0」；成本 **null 另列**
--     （missing_cost_amount——客户文档「null 不当 0」，两类暴露**互斥、不相加**）。
--     ⚠️ 两面对**必须互斥**：`subtotal = 0`（已知为 0）与 `subtotal is null`（未知）不相交。
--     2026-10-17 订正：原写法 `coalesce(b.subtotal, 0) = 0` 把 null 并进零成本面 ⇒ 两面重叠。
--     对账互斥断言见 tests/audit_lemeng__transfer__zero_cost_exposure_amount.sql。
--   · negative_order_count / negative_amount：04-07「单头金额<0 的单数与合计」；负数可能是退补/
--     冲红/调整，「不按绝对值变正收入，也不一律称退货」（客户文档原话）。
-- 【wholesale 侧边界】D02 的行级质量面随 v2 补列的勾稽批次另出（本表只 transfer 域）。
--
-- ── 影子列（聚合面组件化 P3.3 影子波 Task 4，issue #1031）────────────────────────────────
-- `zero_cost_amount` 是**旧实现**（手写聚合逐字未动）；生成区里的 `zero_cost_amount__gen` 是同一
-- 口径的 measure 编译版（`tq_zero_cost_amount@order`，由 `scripts/gen-fct-measures.mjs` 生成——
-- 改声明后重跑生成器）。**本表是影子波唯一的两阶段族**：measure 先逐单求 `measure_value`（分组键
-- 与手写 `per_order` 链同源）、再上卷店日。`subtotal = 0` 的 null 排除语义随 expr 原样进组件
-- （与 missing_cost_amount **互斥**的锚，2026-10-17 订正，不许改成 `coalesce(subtotal, 0)`）。
-- 手写 base / per_order CTE 原样保留在标记区外、**自带 staging 读取** ⇒ staging 扫两次——
-- 影子期已知代价，切换批消除。本阶段只**并行输出**、任何消费方都不许读；切换要等影子对账
-- `dbt/tests/lemeng/assert_fct_transfer_line_quality_measure_shadow_parity.sql` 稳定后另开笔。
with base as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        out_money,
        subtotal,
        lot_number
    from {{ ref('stg_lemeng_transfer_out') }}
    where state_code = 3
      and out_branch_num = 99
      and branch_num <> out_branch_num
),
per_order as (
    select
        system_book, bizday, branch_num, order_no,
        max(coalesce(out_money, 0))::numeric(20,2) as order_money
    from base
    group by 1, 2, 3, 4
)
-- ⚠️ 逗号只能落在标记区**外**（区内逐字节受 `--check` 管），故单独起一行。
,
-- BEGIN GENERATED MEASURES
-- ⚠️ 本区由 scripts/gen-fct-measures.mjs 从 dbt/semantics/l1_metrics.yml 生成，**别手改**：
--    基面的 where 由组件 domain 派生、两阶段聚合由 measure 编译而来。改声明 → 重跑生成器 → 一并提交；
--    CI 的 `pnpm exec tsx scripts/gen-fct-measures.mjs --check` 逐字节比对本区，手改即红。
base_transfer_quality as (
    select * from {{ ref('stg_lemeng_transfer_out') }}
    where state_code = 3 and out_branch_num = 99 and branch_num <> out_branch_num
),
tq_zero_cost_amount__gen as (
    select system_book, bizday, branch_num, order_no, (sum(case when coalesce(out_money, 0) <> 0 and subtotal = 0 then out_money else 0 end)) as measure_value from base_transfer_quality group by system_book, bizday, branch_num, order_no
),
tq_zero_cost_amount__rollup as (
    select system_book, bizday, branch_num, sum(tq_zero_cost_amount__gen.measure_value)::numeric(20,2) as tq_zero_cost_amount__gen
    from tq_zero_cost_amount__gen
    group by 1, 2, 3
),
gen_agg as (
    select
        coalesce(tq_zero_cost_amount__rollup.system_book) as system_book,
        coalesce(tq_zero_cost_amount__rollup.bizday) as bizday,
        coalesce(tq_zero_cost_amount__rollup.branch_num) as branch_num,
        tq_zero_cost_amount__rollup.tq_zero_cost_amount__gen
    from tq_zero_cost_amount__rollup
)
-- END GENERATED MEASURES
select
    b.system_book,
    {{ subject_org() }} as org,
    b.bizday,
    b.branch_num,
    count(*)                                                          as line_count,
    count(*) filter (
        where b.lot_number is not null and trim(b.lot_number) <> ''
    )                                                                 as lot_filled_lines,
    -- ⚠️ 是 `b.subtotal = 0` 而**不是** `coalesce(b.subtotal, 0) = 0`：后者把 **null 也算成 0**
    --    ⇒ 缺成本行会被并进零成本面，与 missing_cost_amount 重叠（违反 04-06「**已知**成本=0」
    --    与「成本 null **另列**」）。SQL 里 `null = 0` 求值为 NULL ⇒ 不成立 ⇒ 天然排除 null。
    sum(case when coalesce(b.out_money, 0) <> 0 and b.subtotal = 0
             then b.out_money else 0 end)::numeric(20,2)              as zero_cost_amount,
    count(*) filter (
        where coalesce(b.out_money, 0) <> 0 and b.subtotal = 0
    )                                                                 as zero_cost_rows,
    sum(case when b.subtotal is null and coalesce(b.out_money, 0) <> 0
             then b.out_money else 0 end)::numeric(20,2)              as missing_cost_amount,
    count(distinct case when p.order_money < 0 then b.order_no end)   as negative_order_count,
    sum(case when p.order_money < 0 then p.order_money else 0 end)::numeric(20,2) as negative_amount,
    -- 影子列 = zero_cost_amount 的 measure 编译版（P3.3 期不许被消费）。本表 final SELECT 自带
    -- group by（不像 Task 2/3 的 CTE 已聚合形态）⇒ gen_agg 列必须包聚合才能进；gen_agg 按 fct
    -- 粒度唯一、left join 也按全键对上 ⇒ max 取「单值或 NULL」，与裸 `coalesce(…, 0)` 语义逐行等价。
    coalesce(max(gen_agg.tq_zero_cost_amount__gen), 0)::numeric(20,2) as zero_cost_amount__gen
from base b
join per_order p on b.system_book = p.system_book
                and b.bizday = p.bizday
                and b.branch_num = p.branch_num
                and b.order_no = p.order_no
-- gen_agg 的行域是 base 分组的子集（同谓词基面里只有「含零成本行」的组）⇒ left join 不增删行
-- （行集由 assert_fct_transfer_line_quality_grain_unique.sql 钉住）。
left join gen_agg
    on  b.system_book = gen_agg.system_book
    and b.bizday = gen_agg.bizday
    and b.branch_num = gen_agg.branch_num
group by 1, 3, 4
