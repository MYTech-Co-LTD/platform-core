-- assert_fct_retail_sale_measure_shadow_parity.sql — 影子列 vs 现有列的对账（聚合面组件化 P3.0；
-- plan 2026-10-23-aggregate-face-componentization Task 6 / spec §4.2）。
--
-- 契约同全仓 singular test：**返回任何行即失败**。
--
-- ── 它守什么 ────────────────────────────────────────────────────────────────────────────
-- `fct_retail_sale` 里并行输出了两套同口径的度量：
--   · `sale_amount` / `return_amount` / `net_amount` = **现有基线**（手写 `sale_side` / `return_side`，
--     逐字未动；它们的真值由 `audit_lemeng__retail__*` 独立复算兜，不是本测试判的对象）；
--   · `*__gen` = `l1_metrics.yml` 的 measure 两阶段编译版（`scripts/gen-fct-measures.mjs` 生成，Task 5）。
-- 本测试按 fct 粒度（账套 × 业务日 × 门店）**逐行逐列**比这两套值：任一分差 > 0.01 即红。
-- 它是 P3.0 唯一能证明「生成侧口径等价」的东西——生成器只保证「声明 → SQL」的确定性，
-- 保证不了「声明读对了」。红 = 两阶段编译的 keys/grain/判别式与手写 CTE 漂了，**不许靠调容差抹平**。
--
-- 比的是**同一行上的两列**（同一张 fct 表）⇒ 不需要 full join（与 `assert_drill_*` 那种两侧独立
-- 取数不同）：行集相同由 Task 5 的结构保证（`gen_agg` 只 left join，不增删最终行）。
--
-- ⚠️ **NULL 必须显式判红**：两侧都 `coalesce(…, 0)`，只比差值的话「影子列变 NULL、旧列是 0」
--    会算成 0 = 0 而**静默绿**——Task 5 修过的 I1 缺陷（单侧店日输出 NULL）正是这一类，
--    差值判据单独存在时结构性看不见它。故失败谓词里单列一条 `*__gen is null`，
--    口径容差仍是 1 分、不放宽。（P3.2 切列后消费方会撞 `not_null`，那时才发现就太晚了。）
--
-- ── 本测试**不**守什么（免得把绿读成「整条链都对」）────────────────────────────────────
-- · **声明漂移**：`l1_metrics.yml` 改了而 fct 生成区没重生成（或反之），本测试看不见——
--   它只比**物化后的数值**。那一层由 `gen-fct-measures.mjs --check`（逐字节）与
--   `scripts/sync-data-semantics.test.ts`（声明↔同步面）守。
-- · **fct 粒度以下的差异**：对账在 (账套 × 业务日 × 门店) 上做，逐单/逐行互相抵消的错
--   （两笔订单金额互换、行级与单级聚合恰好同和）在这里不可见。
-- · **谁对**：这是**等价性**测试，两侧同错也绿。旧列是不是真值由 `audit_lemeng__retail__*` 独立复算兜。
-- · **窗口外**：14 天以外的历史分区不复检（旧分区被重写的回归抓不到）。
--
-- ── 为什么是 1 分容差 ───────────────────────────────────────────────────────────────────
-- 两侧都落 `numeric(20,2)`，但**算术路径不同**：旧侧在 `sale_side` / `return_side` 一次 cast；
-- 影子侧先在 measure 粒度聚合、再在上卷 CTE 里 cast ⇒ 舍入发生的时点不同。逐位相等是过强判据
-- （全精度直比必假红的实测结论见 #957，全仓金额对账一律 1 分容差）。
--
-- ── 为什么窗口是 14 天、且只取闭窗日 ───────────────────────────────────────────────────
-- 窗口跟着 **tier 最严的那个度量**走，本表三个量里 `lemeng:retail:sales`（= `sale_amount`）是
-- **certified**（`net_sales` / 退货侧是 experimental，见 `dbt/semantics/l1_metrics.yml`）⇒ 取 14 天。
-- 三列共用同一窗口以**避免同一件事出现两个窗口、两个红绿结论**：`net_amount` 本可按更短窗口，
-- 但放宽它只会让红来得更晚，没有收益。
-- 只测 `bizday < 上海今天`：当日分区被 tick 持续重写，两侧时点不同不可比（同 `audit_*` 的闭窗约定）。
--
-- ── 空转绿守卫 ─────────────────────────────────────────────────────────────────────────
-- 窗口内一行都没有时，`where` 在空集上「通过」是**空转绿**（不是对上了）。故显式补一行失败。
-- 守卫是**整窗**级的：单个账套整段空窗不会触发（「账套级覆盖」归水位/新鲜度机制，不归本测试）。
--
-- ⚠️ 本测试是 **P3.0 的桥**：P3.2 把消费面切到 `*__gen` 之后，两列同源、本对账失去参照
--    ⇒ 那时的计划必须改写或移除它，**不要留成空转绿**。
with cmp as (
    select system_book, bizday, branch_num,
           sale_amount, sale_amount__gen,
           return_amount, return_amount__gen,
           net_amount, net_amount__gen
    from {{ ref('fct_retail_sale') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and bizday >= CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE) - 14
)
select *,
       case when sale_amount__gen is null or return_amount__gen is null or net_amount__gen is null
            then '影子列为 NULL（coalesce 归零后会算成 0 = 0 的静默绿，故显式判红）'
            else '影子列与现有列不一致（sale/return/net，1 分容差）'
       end as note
from cmp
where abs(coalesce(sale_amount,0)   - coalesce(sale_amount__gen,0))   > 0.01
   or abs(coalesce(return_amount,0) - coalesce(return_amount__gen,0)) > 0.01
   or abs(coalesce(net_amount,0)    - coalesce(net_amount__gen,0))    > 0.01
   or sale_amount__gen   is null
   or return_amount__gen is null
   or net_amount__gen    is null

union all

select null, null, null, null, null, null, null, null, null,
       '空转绿：窗口内一行都没有' as note
where (select count(*) from cmp) = 0
